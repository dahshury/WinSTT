/**
 * SQLite-backed transcription history IPC wiring.
 *
 * Pure CRUD lives in `./history-store.ts`. This file is the electron-facing
 * shell: it opens the native `better-sqlite3` binding, owns the recordings
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

// `better-sqlite3` is a native CommonJS module — `import` would force a
// top-level fetch even under `bun test` which doesn't load native bindings.
// `createRequire` keeps the binding lazy + still lets knip see the dependency
// (it scans `require()` arguments).
const nodeRequire = createRequire(import.meta.url);

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
	// Lazy require so `bun test` files that don't touch native code don't need
	// to load the binding. The Electron main bundle resolves this synchronously.
	const factory = nodeRequire("better-sqlite3") as (
		path: string,
		opts?: Record<string, unknown>
	) => DatabaseLike;
	const db = factory(dbPath);
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
