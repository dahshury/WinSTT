/**
 * SQLite-backed transcription history IPC wiring.
 *
 * Pure CRUD lives in `./history-store.ts`. This file is the electron-facing
 * shell: it opens the `node:sqlite` database, owns the recordings
 * directory under `{userData}/recordings/`, fires the retention sweeper on an
 * hourly timer, and registers every `history:*` ipcMain handler the renderer
 * (and the tray worktree's submenu) calls through.
 *
 * The DB path is `{userData}/history.db` and WAV files live under
 * `{userData}/recordings/<file_name>`. Both honor Electron's portable-mode
 * `app.getPath("userData")` resolution.
 *
 * Coexists with the legacy electron-store history (`transcription-history.ts`).
 * The two don't share storage on purpose — that one is the source of truth
 * for the existing settings UI, this one is the canonical SQLite store the
 * tray submenu + future history view consume.
 */

import { existsSync, mkdirSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";
import { dbg } from "../lib/debug-log";
import {
	createHistoryStore,
	type DatabaseLike,
	type HistoryStore,
	parseAddInput,
	parsePageArgs,
	type RecordingRetentionPeriod,
	runMigrations,
} from "./history-store";

// `node:sqlite` is Electron's bundled SQLite (Node 24 / ABI-stable — no native
// addon to rebuild against each Electron bump, unlike `better-sqlite3` which
// can't compile against Electron 42's V8 yet). `createRequire` keeps the lookup
// lazy so `bun test` files that import this module's siblings don't try to
// resolve `node:sqlite` under Bun's runtime (Bun ships `bun:sqlite`, not the
// Node builtin). Only `defaultOpen` touches it, and tests inject a fake DB.
const nodeRequire = createRequire(import.meta.url);

/**
 * Minimal slice of the `node:sqlite` surface we adapt to `DatabaseLike`. Kept
 * local (rather than importing the `node:sqlite` types) so type-checking never
 * depends on the running `@types/node` carrying this still-experimental module.
 */
interface NodeSqliteStatement {
	all: (...params: unknown[]) => unknown[];
	get: (...params: unknown[]) => unknown;
	run: (...params: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface NodeSqliteDatabase {
	close: () => void;
	exec: (sql: string) => void;
	prepare: (sql: string) => NodeSqliteStatement;
}
interface NodeSqliteModule {
	DatabaseSync: new (filename: string, options?: Record<string, unknown>) => NodeSqliteDatabase;
}

/**
 * Wrap a raw `node:sqlite` `DatabaseSync` in the `DatabaseLike` shape the pure
 * history store expects. `node:sqlite` has no `pragma()` or `transaction()`
 * helpers (better-sqlite3 inventions), so we synthesize them: `pragma` routes
 * write forms (`key = value`) through `exec` and read forms through a prepared
 * `PRAGMA` query (returning the scalar when `simple`), and `transaction`
 * brackets the callback with `BEGIN`/`COMMIT`, rolling back on throw.
 */
function adaptNodeSqlite(raw: NodeSqliteDatabase): DatabaseLike {
	return {
		close: () => raw.close(),
		exec: (sql) => raw.exec(sql),
		pragma: (text, options) => {
			const body = text.trim();
			if (body.includes("=")) {
				raw.exec(`PRAGMA ${body}`);
				return;
			}
			const row = raw.prepare(`PRAGMA ${body}`).get() as Record<string, unknown> | undefined;
			if (options?.simple) {
				if (!row) {
					return;
				}
				for (const value of Object.values(row)) {
					return value;
				}
				return;
			}
			return row;
		},
		prepare: (sql) => {
			const stmt = raw.prepare(sql);
			return {
				all: (...params) => stmt.all(...params),
				get: (...params) => stmt.get(...params),
				run: (...params) => {
					const result = stmt.run(...params);
					return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
				},
			};
		},
		transaction:
			(fn) =>
			(...args) => {
				raw.exec("BEGIN");
				try {
					const result = fn(...args);
					raw.exec("COMMIT");
					return result;
				} catch (err) {
					raw.exec("ROLLBACK");
					throw err;
				}
			},
	};
}

export type { HistoryStore } from "./history-store";

let _activeHistoryStore: HistoryStore | null = null;

/**
 * Module-level handle on the live SQLite history store. Populated when
 * `setupHistoryIpc` runs (at app boot) and cleared on dispose. The relay
 * reads this to add a row when a fullSentence event carries `wav_path`
 * without re-entering the IPC layer — main-process internal call,
 * synchronous, no ipcMain.invoke round-trip.
 *
 * Returns `null` when history hasn't been wired up yet (early startup, or
 * when running under bun:test with the wrapper omitted). Callers MUST
 * handle the null branch.
 */
export function getActiveHistoryStore(): HistoryStore | null {
	return _activeHistoryStore;
}

interface HistoryIpcDeps {
	broadcast?: (channel: string, payload: unknown) => void;
	getLimit?: () => number;
	getRetention?: () => RecordingRetentionPeriod;
	now?: () => number;
	openDatabase?: (dbPath: string) => DatabaseLike;
	userDataDir?: string;
}

export interface HistoryIpcResult {
	dbPath: string;
	dispose: () => void;
	recordingsDir: string;
	store: HistoryStore;
}

const HOUR_MS = 60 * 60 * 1000;

function defaultBroadcast(channel: string, payload: unknown): void {
	for (const bw of BrowserWindow.getAllWindows()) {
		if (bw.isDestroyed()) {
			continue;
		}
		try {
			bw.webContents.send(channel, payload);
		} catch (err) {
			dbg("history", `broadcast ${channel} failed:`, String(err));
		}
	}
}

function defaultOpen(dbPath: string): DatabaseLike {
	// Lazy require so `bun test` files that pull in this module's siblings don't
	// resolve `node:sqlite` under Bun. Electron's main bundle resolves the
	// builtin synchronously.
	const { DatabaseSync } = nodeRequire("node:sqlite") as NodeSqliteModule;
	const db = adaptNodeSqlite(new DatabaseSync(dbPath));
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = NORMAL");
	return db;
}

function isEnoent(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code?: unknown }).code === "ENOENT"
	);
}

/**
 * Wire up the SQLite history IPC handlers. Returns a cleanup function the
 * caller invokes on shutdown.
 */
export function setupHistoryIpc(deps: HistoryIpcDeps = {}): HistoryIpcResult {
	const userDataDir = deps.userDataDir ?? app.getPath("userData");
	const recordingsDir = path.join(userDataDir, "recordings");
	const dbPath = path.join(userDataDir, "history.db");

	if (!existsSync(recordingsDir)) {
		mkdirSync(recordingsDir, { recursive: true });
	}

	const broadcast = deps.broadcast ?? defaultBroadcast;
	const opener = deps.openDatabase ?? defaultOpen;
	const db = opener(dbPath);
	runMigrations(db);

	const storeOptions: Parameters<typeof createHistoryStore>[0] = {
		db,
		onAdded: (row) => broadcast(IPC.HISTORY_ROW_ADDED, row),
		onDeleted: (id) => broadcast(IPC.HISTORY_ROW_DELETED, { id }),
		onToggled: (id, saved) => broadcast(IPC.HISTORY_ROW_TOGGLED, { id, saved }),
		onSweepError: (err) => {
			dbg("history", "sweep/WAV error:", String(err));
		},
		onWavDelete: async (fileName) => {
			const full = path.join(recordingsDir, fileName);
			try {
				await unlink(full);
			} catch (err) {
				if (isEnoent(err)) {
					return;
				}
				dbg("history", `unlink ${fileName} raised:`, String(err));
			}
		},
	};
	if (deps.now) {
		storeOptions.now = deps.now;
	}
	const store: HistoryStore = createHistoryStore(storeOptions);

	ipcMain.removeHandler(IPC.HISTORY_LIST);
	ipcMain.handle(IPC.HISTORY_LIST, (_e, payload: unknown) => {
		const { offset, limit } = parsePageArgs(payload);
		return store.list({ offset, limit });
	});

	ipcMain.removeHandler(IPC.HISTORY_ADD);
	ipcMain.handle(IPC.HISTORY_ADD, (_e, payload: unknown) => {
		const input = parseAddInput(payload);
		if (input === null) {
			return null;
		}
		return store.add(input);
	});

	ipcMain.removeHandler(IPC.HISTORY_DELETE_ROW);
	ipcMain.handle(IPC.HISTORY_DELETE_ROW, (_e, id: unknown) => {
		if (typeof id !== "number") {
			return { deleted: false };
		}
		return { deleted: store.deleteById(id) };
	});

	ipcMain.removeHandler(IPC.HISTORY_TOGGLE);
	ipcMain.handle(IPC.HISTORY_TOGGLE, (_e, id: unknown) => {
		if (typeof id !== "number") {
			return { saved: null };
		}
		return { saved: store.toggle(id) };
	});

	ipcMain.removeHandler(IPC.HISTORY_RECENT);
	ipcMain.handle(IPC.HISTORY_RECENT, (_e, n: unknown) => {
		const limit = typeof n === "number" ? n : 5;
		return store.recent(limit);
	});

	ipcMain.removeHandler(IPC.HISTORY_LOAD_AUDIO_BY_ROW);
	ipcMain.handle(IPC.HISTORY_LOAD_AUDIO_BY_ROW, async (_e, id: unknown) => {
		if (typeof id !== "number") {
			return null;
		}
		const row = store.getById(id);
		if (row === null || row.fileName === "") {
			return null;
		}
		const full = path.join(recordingsDir, row.fileName);
		try {
			const buf = await readFile(full);
			return `data:audio/wav;base64,${buf.toString("base64")}`;
		} catch (err) {
			if (isEnoent(err)) {
				return null;
			}
			dbg("history", `load-audio failed for ${row.fileName}:`, String(err));
			return null;
		}
	});

	function runSweep(): void {
		const period = deps.getRetention?.() ?? "preserveLimit";
		const limit = deps.getLimit?.() ?? 5;
		try {
			const removed = store.sweep(period, limit);
			if (removed > 0) {
				dbg("history", `retention swept ${removed} rows (period=${period})`);
			}
		} catch (err) {
			dbg("history", "sweep raised:", String(err));
		}
	}

	_activeHistoryStore = store;

	// Run once at startup so retention is enforced immediately on every launch,
	// then hourly as long as the app is alive.
	runSweep();
	const ticker = setInterval(runSweep, HOUR_MS);
	// `unref` so the timer doesn't keep the event loop alive during shutdown.
	if (typeof ticker.unref === "function") {
		ticker.unref();
	}

	const dispose = (): void => {
		clearInterval(ticker);
		ipcMain.removeHandler(IPC.HISTORY_LIST);
		ipcMain.removeHandler(IPC.HISTORY_ADD);
		ipcMain.removeHandler(IPC.HISTORY_DELETE_ROW);
		ipcMain.removeHandler(IPC.HISTORY_TOGGLE);
		ipcMain.removeHandler(IPC.HISTORY_RECENT);
		ipcMain.removeHandler(IPC.HISTORY_LOAD_AUDIO_BY_ROW);
		if (_activeHistoryStore === store) {
			_activeHistoryStore = null;
		}
		try {
			store.close();
		} catch (err) {
			dbg("history", "db close raised:", String(err));
		}
	};

	return { dispose, store, recordingsDir, dbPath };
}
