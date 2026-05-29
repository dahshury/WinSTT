/**
 * Behavioural tests for the electron-facing SQLite history shell.
 *
 * The earlier version of this file was a single re-export smoke test that
 * believed the `electron` mock was unusable locally. It is in fact usable —
 * `settings.test.ts` and friends drive `ipcMain` through the same
 * `@test/mocks/electron` shim. So here we exercise the previously-uncovered
 * surface for real:
 *
 *   - `adaptNodeSqlite` — pragma write/read/`simple`, prepare row-mapping,
 *     `run` change-coercion, `transaction` COMMIT/ROLLBACK.
 *   - `setupHistoryIpc` — recordings-dir creation, migration run, every
 *     `history:*` ipcMain handler, the `onAdded/onDeleted/onToggled`
 *     broadcast callbacks, `onWavDelete` (ENOENT swallow vs log), `runSweep`,
 *     and `dispose` (timer clear + handler removal + store close).
 *   - `defaultBroadcast` — skips destroyed windows, logs on send throw.
 *   - `isEnoent` — exercised through both `onWavDelete` and the
 *     `load-audio-by-row` handler's catch.
 *
 * Node I/O is mocked: `node:fs` (existsSync/mkdirSync), `node:fs/promises`
 * (readFile/unlink). The SQLite layer is injected via `deps.openDatabase` so
 * no real `node:sqlite` engine is touched.
 */

import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";
import {
	createHistoryStore as createStoreInWrapper,
	type DatabaseLike,
	MIGRATIONS as MIGRATIONS_FROM_WRAPPER,
	runMigrations as runMigrationsFromWrapper,
	type StatementLike,
} from "./history-store";

// ── electron shim ──────────────────────────────────────────────────────────
// Spread the full mock so sibling surfaces (`app`, `Menu`, …) stay intact, and
// drive `BrowserWindow.getAllWindows` so `defaultBroadcast` has windows to
// iterate. The default mock's `ipcMain` already records handlers and offers
// `invokeHandler`, which is exactly what we need to round-trip each handler.
const base = electronMock();

interface FakeWindow {
	isDestroyed: () => boolean;
	webContents: { send: (channel: string, payload: unknown) => void };
}
const fakeWindows: FakeWindow[] = [];

mock.module("electron", () => ({
	...base,
	BrowserWindow: {
		...base.BrowserWindow,
		getAllWindows: () => fakeWindows,
	},
}));

// ── node:fs (existsSync / mkdirSync) ────────────────────────────────────────
// `existsSync` is keyed on whether the recordings dir is considered present.
// We match on the trailing `recordings` segment rather than the full joined
// path because `path.join` yields backslashes on win32 (the host here).
const fsState = {
	recordingsExists: false,
	mkdirCalls: [] as string[],
	mkdirThrows: false,
};
mock.module("node:fs", () => ({
	existsSync: (p: string) => {
		if (p.endsWith("recordings")) {
			return fsState.recordingsExists;
		}
		return false;
	},
	mkdirSync: (p: string) => {
		fsState.mkdirCalls.push(p);
		if (fsState.mkdirThrows) {
			throw new Error("mkdir boom");
		}
	},
}));

// ── node:fs/promises (readFile / unlink) ────────────────────────────────────
const enoent = (): Error & { code: string } => {
	const err = new Error("no such file") as Error & { code: string };
	err.code = "ENOENT";
	return err;
};
const fspState = {
	readFileResult: Buffer.from("WAVDATA"),
	readFileError: null as Error | null,
	unlinkPaths: [] as string[],
	unlinkError: null as Error | null,
};
mock.module("node:fs/promises", () => ({
	readFile: async (_p: string) => {
		if (fspState.readFileError) {
			throw fspState.readFileError;
		}
		return fspState.readFileResult;
	},
	unlink: async (p: string) => {
		fspState.unlinkPaths.push(p);
		if (fspState.unlinkError) {
			throw fspState.unlinkError;
		}
	},
}));

// ── node:module — intercept `createRequire(...)("node:sqlite")` ──────────────
// `history.ts` resolves `node:sqlite` through `createRequire(import.meta.url)`
// (a CJS require), NOT the ESM graph that `mock.module("node:sqlite", …)`
// intercepts — and Bun's createRequire cannot fetch the builtin, so the real
// `defaultOpen` would throw "Failed to fetch builtin module". We override
// `createRequire` itself so the `nodeRequire` captured at module-load returns a
// programmable `DatabaseSync`, making the otherwise-unreachable `defaultOpen` →
// `adaptNodeSqlite` path covered for real.
import * as realModule from "node:module";

interface FakeRawStatement {
	all: (...params: unknown[]) => unknown[];
	get: (...params: unknown[]) => unknown;
	run: (...params: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface FakeRawDb {
	close: () => void;
	exec: (sql: string) => void;
	prepare: (sql: string) => FakeRawStatement;
}
// The current raw DB the fake node:sqlite hands back. Tests swap this before
// calling `setupHistoryIpc({})` (no openDatabase → defaultOpen path).
let currentRaw: FakeRawDb | null = null;

mock.module("node:module", () => ({
	...realModule,
	default: realModule,
	createRequire: (_url: string) => (id: string) => {
		if (id === "node:sqlite") {
			return {
				DatabaseSync: class {
					close: () => void;
					exec: (sql: string) => void;
					prepare: (sql: string) => FakeRawStatement;
					constructor() {
						if (currentRaw === null) {
							throw new Error("no raw DB staged for node:sqlite fake");
						}
						this.close = currentRaw.close;
						this.exec = currentRaw.exec;
						this.prepare = currentRaw.prepare;
					}
				},
			};
		}
		return realModule.createRequire(import.meta.url)(id);
	},
}));

// Captured dbg() lines — test/preload.ts installs a console transport that
// records every electron-log level into this global buffer.
const consoleLogLines = (globalThis as unknown as { __testLogLines: string[] }).__testLogLines;
function recentLogContains(needle: string): boolean {
	return consoleLogLines.some((line) => line.includes(needle));
}

const historyModule = await import("./history");
const { setupHistoryIpc, getActiveHistoryStore } = historyModule;

// ── A scriptable fake node:sqlite-shaped DatabaseLike ────────────────────────
// Records every exec/pragma so we can assert the adapter wiring without a real
// engine. `prepare` returns programmable statements keyed by a substring of the
// SQL so the store's CRUD paths can be steered per-test.
interface FakeStmtBehaviour {
	all?: (...params: unknown[]) => unknown[];
	get?: (...params: unknown[]) => unknown;
	run?: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
}
function makeFakeDb(opts: {
	pragmaReturns?: Record<string, unknown>;
	stmt?: (sql: string) => FakeStmtBehaviour;
	closeThrows?: boolean;
}): {
	db: DatabaseLike;
	execCalls: string[];
	pragmaCalls: Array<{ text: string; simple?: boolean | undefined }>;
	// Live getter (NOT a snapshot) so `close()` increments are visible to
	// assertions made after dispose.
	closedCount: () => number;
} {
	const execCalls: string[] = [];
	const pragmaCalls: Array<{ text: string; simple?: boolean | undefined }> = [];
	let closed = 0;
	const db: DatabaseLike = {
		close: () => {
			closed += 1;
			if (opts.closeThrows) {
				throw new Error("close boom");
			}
		},
		exec: (sql) => {
			execCalls.push(sql);
		},
		pragma: (text, options) => {
			pragmaCalls.push({ text, simple: options?.simple });
			return opts.pragmaReturns?.[text];
		},
		prepare: (sql): StatementLike => {
			const b = opts.stmt?.(sql) ?? {};
			return {
				all: (...params) => b.all?.(...params) ?? [],
				get: (...params) => b.get?.(...params) ?? undefined,
				run: (...params) => b.run?.(...params) ?? { changes: 0, lastInsertRowid: 0 },
			};
		},
		transaction:
			(fn) =>
			(...args) =>
				fn(...args),
	};
	return { db, execCalls, pragmaCalls, closedCount: () => closed };
}

// ════════════════════════════════════════════════════════════════════════════
describe("history.ts wrapper re-exports", () => {
	test("re-exports point at the canonical pure-store implementations", () => {
		expect(typeof createStoreInWrapper).toBe("function");
		expect(typeof runMigrationsFromWrapper).toBe("function");
		expect(Array.isArray(MIGRATIONS_FROM_WRAPPER)).toBe(true);
		expect(MIGRATIONS_FROM_WRAPPER.length).toBeGreaterThan(0);
	});
});

// ── adaptNodeSqlite — covered via the real `defaultOpen` path. We do NOT pass
// `deps.openDatabase`, so `setupHistoryIpc` calls `defaultOpen(dbPath)` →
// `nodeRequire("node:sqlite").DatabaseSync` → `adaptNodeSqlite`. The top-level
// `node:module` mock makes that require return a programmable `DatabaseSync`
// backed by `currentRaw`. This exercises every adapter branch for real:
// pragma write (`=` → exec), pragma read (prepare().get()), pragma simple
// (scalar extraction), prepare.run change-coercion (bigint → Number), and the
// transaction BEGIN/COMMIT/ROLLBACK bracket.
function stageRaw(behaviour: {
	get?: (sql: string) => unknown;
	all?: (sql: string, params: unknown[]) => unknown[];
	run?: (
		sql: string,
		params: unknown[]
	) => { changes: number | bigint; lastInsertRowid: number | bigint };
}): { execCalls: string[]; prepareCalls: string[]; closed: () => number } {
	const execCalls: string[] = [];
	const prepareCalls: string[] = [];
	let closedCount = 0;
	currentRaw = {
		close: () => {
			closedCount += 1;
		},
		exec: (sql) => {
			execCalls.push(sql);
		},
		prepare: (sql) => {
			prepareCalls.push(sql);
			return {
				all: (...params) => behaviour.all?.(sql, params) ?? [],
				get: () => behaviour.get?.(sql),
				run: (...params) => behaviour.run?.(sql, params) ?? { changes: 0, lastInsertRowid: 0 },
			};
		},
	};
	return { execCalls, prepareCalls, closed: () => closedCount };
}

describe("adaptNodeSqlite (covered via the real defaultOpen → node:sqlite path)", () => {
	test("pragma write→exec, pragma read→prepare.get, run coerces bigint changes", () => {
		const cap = stageRaw({
			get: (sql) => (sql === "PRAGMA user_version" ? { user_version: 0 } : undefined),
			run: () => ({ changes: 3n, lastInsertRowid: 42n }),
		});
		fsState.recordingsExists = true;
		// No openDatabase → defaultOpen path runs adaptNodeSqlite for real.
		const result = setupHistoryIpc({ userDataDir: "/mock/userData" });

		// defaultOpen's two write-pragmas routed through raw.exec as `PRAGMA <body>`.
		expect(cap.execCalls).toContain("PRAGMA journal_mode = WAL");
		expect(cap.execCalls).toContain("PRAGMA synchronous = NORMAL");
		// runMigrations' `pragma("user_version", {simple:true})` is a READ form →
		// prepare(`PRAGMA user_version`).get().
		expect(cap.prepareCalls).toContain("PRAGMA user_version");
		// At user_version 0 with non-empty MIGRATIONS, every migration DDL execs,
		// then user_version is bumped (write form → exec `PRAGMA user_version = N`).
		expect(cap.execCalls.some((s) => s.includes("CREATE TABLE"))).toBe(true);
		expect(cap.execCalls.some((s) => s.startsWith("PRAGMA user_version ="))).toBe(true);

		// run() bigint change-coercion: insertStmt.run returns lastInsertRowid 42n
		// → adapter coerces changes via Number(); the store maps lastInsertRowid.
		const added = result.store.add({ fileName: "x.wav", transcriptionText: "hi" });
		expect(added.id).toBe(42);
		expect(typeof added.id).toBe("number");

		result.dispose();
		expect(cap.closed()).toBe(1);
	});

	test("pragma simple with no row returns undefined (no crash); user_version defaults to 0", () => {
		// raw.get returns undefined for the user_version read → the `if (!row)`
		// branch inside the simple path returns undefined, and runMigrations
		// treats a non-number as version 0.
		const cap = stageRaw({ get: () => undefined });
		fsState.recordingsExists = true;
		const result = setupHistoryIpc({ userDataDir: "/mock/u2" });
		// Since version resolved to 0, every migration ran.
		expect(cap.execCalls.some((s) => s.includes("CREATE TABLE"))).toBe(true);
		result.dispose();
	});

	test("pragma simple with an empty-object row falls through to undefined", () => {
		// raw.get returns an EMPTY object `{}` for the user_version read. The
		// `simple` path's `if (!row)` is false (truthy `{}`), the
		// `for (const value of Object.values(row))` loop body never runs (no
		// enumerable keys), so the trailing `return;` fallthrough fires →
		// pragma returns undefined → runMigrations treats it as version 0.
		const cap = stageRaw({ get: () => ({}) });
		fsState.recordingsExists = true;
		const result = setupHistoryIpc({ userDataDir: "/mock/empty-pragma" });
		// undefined version → 0 → all migrations ran.
		expect(cap.execCalls.some((s) => s.includes("CREATE TABLE"))).toBe(true);
		result.dispose();
	});

	test("transaction brackets BEGIN/COMMIT on success and BEGIN/ROLLBACK on throw", () => {
		// Drive a populated preserveLimit sweep so the store's deleteEntries wraps
		// the deletes in db.transaction → adapter emits BEGIN … COMMIT.
		let deleteCount = 0;
		const cap = stageRaw({
			get: (sql) => (sql === "PRAGMA user_version" ? { user_version: 0 } : undefined),
			all: (sql) => {
				if (sql.includes("saved = 0")) {
					return [{ id: 1, file_name: "old1.wav" }];
				}
				return [];
			},
			run: (sql) => {
				if (sql.startsWith("DELETE")) {
					deleteCount += 1;
				}
				return { changes: 1, lastInsertRowid: 0 };
			},
		});
		fsState.recordingsExists = true;
		const result = setupHistoryIpc({
			userDataDir: "/mock/tx",
			getRetention: () => "preserveLimit",
			getLimit: () => 0,
		});
		// startup runSweep → deleteEntries → transaction → BEGIN/COMMIT bracket.
		expect(cap.execCalls).toContain("BEGIN");
		expect(cap.execCalls).toContain("COMMIT");
		expect(deleteCount).toBeGreaterThan(0);
		result.dispose();

		// ROLLBACK branch: a transaction body that throws must emit ROLLBACK and
		// rethrow. Stage a sweep whose DELETE throws inside the transaction.
		const cap2 = stageRaw({
			get: (sql) => (sql === "PRAGMA user_version" ? { user_version: 0 } : undefined),
			all: (sql) => (sql.includes("saved = 0") ? [{ id: 2, file_name: "old2.wav" }] : []),
			run: (sql) => {
				if (sql.startsWith("DELETE")) {
					throw new Error("delete blew up");
				}
				return { changes: 0, lastInsertRowid: 0 };
			},
		});
		fsState.recordingsExists = true;
		consoleLogLines.length = 0;
		// runSweep catches the rethrown error → logs "sweep raised".
		const result2 = setupHistoryIpc({
			userDataDir: "/mock/tx2",
			getRetention: () => "preserveLimit",
			getLimit: () => 0,
		});
		expect(cap2.execCalls).toContain("BEGIN");
		expect(cap2.execCalls).toContain("ROLLBACK");
		expect(cap2.execCalls).not.toContain("COMMIT");
		expect(recentLogContains("sweep raised")).toBe(true);
		result2.dispose();
	});

	test("user_version already at MIGRATIONS.length skips migration DDL", () => {
		const cap = stageRaw({
			get: (sql) =>
				sql === "PRAGMA user_version"
					? { user_version: MIGRATIONS_FROM_WRAPPER.length }
					: undefined,
		});
		fsState.recordingsExists = true;
		const result = setupHistoryIpc({ userDataDir: "/mock/adapt" });
		// No CREATE TABLE / ALTER DDL fired (already migrated).
		expect(cap.execCalls.some((s) => s.includes("CREATE TABLE"))).toBe(false);
		// No user_version bump either (migrations.length is not > current).
		expect(cap.execCalls.some((s) => s.startsWith("PRAGMA user_version ="))).toBe(false);
		// The two journal/synchronous write-pragmas always fire.
		expect(cap.execCalls).toContain("PRAGMA journal_mode = WAL");
		result.dispose();
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("setupHistoryIpc — full handler + callback integration", () => {
	function freshDeps(over: Partial<Parameters<typeof setupHistoryIpc>[0]> = {}) {
		// Programmable in-memory-ish fake store DB.
		const rowsById = new Map<number, Record<string, unknown>>();
		let nextId = 1;
		const fake = makeFakeDb({
			pragmaReturns: { user_version: 0 },
			stmt: (sql) => {
				if (sql.startsWith("INSERT")) {
					return {
						run: (...p) => {
							const id = nextId++;
							rowsById.set(id, {
								id,
								file_name: p[0],
								timestamp: p[1],
								saved: p[2],
								title: p[3],
								transcription_text: p[4],
								post_processed_text: p[5] ?? null,
								post_process_prompt: p[6] ?? null,
								post_process_requested: p[7] ?? 0,
							});
							return { changes: 1, lastInsertRowid: id };
						},
					};
				}
				if (sql.includes("WHERE id = ?") && sql.startsWith("SELECT")) {
					return { get: (id) => rowsById.get(id as number) };
				}
				if (sql.startsWith("DELETE")) {
					return {
						run: (id) => {
							const existed = rowsById.delete(id as number);
							return { changes: existed ? 1 : 0, lastInsertRowid: 0 };
						},
					};
				}
				if (sql.startsWith("UPDATE")) {
					return {
						run: (saved, id) => {
							const r = rowsById.get(id as number);
							if (r) {
								r.saved = saved;
							}
							return { changes: 1, lastInsertRowid: 0 };
						},
					};
				}
				if (sql.includes("ORDER BY id DESC")) {
					// list / recent
					return { all: () => [...rowsById.values()].reverse() };
				}
				if (sql.includes("saved = 0")) {
					// sweep candidates
					return {
						all: () =>
							[...rowsById.values()]
								.filter((r) => r.saved === 0)
								.map((r) => ({ id: r.id, file_name: r.file_name })),
					};
				}
				return {};
			},
		});
		const opener = () => fake.db;
		const result = setupHistoryIpc({
			userDataDir: "/mock/ipc",
			openDatabase: opener,
			now: () => 1000,
			...over,
		});
		return { result, fake, rowsById };
	}

	test("creates the recordings dir when it does not exist", () => {
		fsState.recordingsExists = false;
		fsState.mkdirCalls = [];
		const { result } = freshDeps();
		expect(fsState.mkdirCalls.some((p) => p.includes("recordings"))).toBe(true);
		result.dispose();
	});

	test("does NOT mkdir when the recordings dir already exists", () => {
		fsState.recordingsExists = true;
		fsState.mkdirCalls = [];
		const { result } = freshDeps();
		expect(fsState.mkdirCalls.length).toBe(0);
		result.dispose();
	});

	test("a throwing mkdir degrades gracefully — handlers still wire (Bug #3 regression)", async () => {
		// Bug #3 regression: an EACCES/EPERM/ENOSPC from mkdirSync used to throw
		// straight out of setupHistoryIpc, taking the WHOLE history subsystem (DB
		// open + every ipcMain handler + the retention sweeper) down at app boot.
		// The mkdir now sits in a try/catch: it logs and continues so the DB and
		// handlers — which don't need the recordings dir — stay alive.
		fsState.recordingsExists = false;
		fsState.mkdirCalls = [];
		fsState.mkdirThrows = true;
		consoleLogLines.length = 0;
		// Holder object (not a bare `let`): a variable assigned only inside the
		// `expect(() => …)` closure gets narrowed back to `null` by TS
		// control-flow, making `result?.dispose()` resolve to `never`. A property
		// assignment is exempt from that narrowing.
		const captured: { result: ReturnType<typeof setupHistoryIpc> | null } = { result: null };
		try {
			// MUST NOT throw despite the mkdir blowing up.
			expect(() => {
				captured.result = freshDeps().result;
			}).not.toThrow();
			expect(recentLogContains("mkdir recordings dir")).toBe(true);
			// The subsystem is fully wired — a handler round-trips normally.
			const added = (await base.ipcMain.invokeHandler("history:add", {
				fileName: "after-mkdir-fail.wav",
				transcriptionText: "still works",
			})) as { id: number };
			expect(added.id).toBeGreaterThan(0);
		} finally {
			fsState.mkdirThrows = false;
			captured.result?.dispose();
		}
	});

	test("HISTORY_ADD inserts and broadcasts ROW_ADDED via the default broadcast", async () => {
		fsState.recordingsExists = true;
		// Drive defaultBroadcast: one healthy window, one destroyed (skipped),
		// one throwing (logged but not fatal).
		const sent: Array<{ channel: string; payload: unknown }> = [];
		fakeWindows.length = 0;
		fakeWindows.push(
			{
				webContents: { send: (c, p) => sent.push({ channel: c, payload: p }) },
				isDestroyed: () => false,
			},
			{
				webContents: {
					send: () => {
						throw new Error("renderer-hung");
					},
				},
				isDestroyed: () => false,
			},
			{
				webContents: { send: () => sent.push({ channel: "x", payload: 1 }) },
				isDestroyed: () => true,
			}
		);
		consoleLogLines.length = 0;

		// freshDeps with NO broadcast override → uses defaultBroadcast.
		const { result } = freshDeps({});
		const added = (await base.ipcMain.invokeHandler("history:add", {
			fileName: "a.wav",
			transcriptionText: "hello world",
		})) as { id: number };
		expect(added.id).toBeGreaterThan(0);
		// Healthy window received the row-added broadcast.
		expect(sent.some((m) => m.channel === "history:row-added")).toBe(true);
		// Destroyed window was skipped (its send pushes channel "x" — must be absent).
		expect(sent.some((m) => m.channel === "x")).toBe(false);
		// The throwing window's failure was caught + logged by defaultBroadcast.
		expect(recentLogContains("broadcast history:row-added failed")).toBe(true);
		result.dispose();
		fakeWindows.length = 0;
	});

	test("defaultBroadcast survives a window whose isDestroyed() itself throws (Bug #5)", async () => {
		// Bug #5 regression: a window can be torn down between getAllWindows() and
		// the per-window check, so even `bw.isDestroyed()` (or reading
		// `bw.webContents`) throws "Object has been destroyed". That access used to
		// sit OUTSIDE the try → the throw aborted the whole loop, starving every
		// healthy window AFTER the dead one. The guard now lives inside the try, so
		// the dead window is logged and the next healthy window still receives the
		// broadcast.
		fsState.recordingsExists = true;
		const sent: Array<{ channel: string; payload: unknown }> = [];
		fakeWindows.length = 0;
		fakeWindows.push(
			{
				// Dead window: isDestroyed() throws (accessed first in the loop).
				webContents: {
					send: () => sent.push({ channel: "should-not-reach", payload: 1 }),
				},
				isDestroyed: () => {
					throw new Error("Object has been destroyed");
				},
			},
			{
				// Healthy window that comes AFTER the dead one — must still get the row.
				webContents: { send: (c, p) => sent.push({ channel: c, payload: p }) },
				isDestroyed: () => false,
			}
		);
		consoleLogLines.length = 0;

		const { result } = freshDeps({});
		const added = (await base.ipcMain.invokeHandler("history:add", {
			fileName: "guard.wav",
			transcriptionText: "after dead window",
		})) as { id: number };
		expect(added.id).toBeGreaterThan(0);
		// The dead window's throwing isDestroyed() was caught + logged.
		expect(recentLogContains("broadcast history:row-added failed")).toBe(true);
		// The throwing window never sent anything.
		expect(sent.some((m) => m.channel === "should-not-reach")).toBe(false);
		// Crucially: the healthy window AFTER it still received the broadcast.
		expect(sent.some((m) => m.channel === "history:row-added")).toBe(true);
		result.dispose();
		fakeWindows.length = 0;
	});

	test("HISTORY_ADD returns null for invalid payload", async () => {
		fsState.recordingsExists = true;
		const { result } = freshDeps();
		const out = await base.ipcMain.invokeHandler("history:add", { nope: true });
		expect(out).toBeNull();
		result.dispose();
	});

	test("HISTORY_LIST parses page args and returns entries", async () => {
		fsState.recordingsExists = true;
		const broadcasts: Array<{ channel: string; payload: unknown }> = [];
		const { result } = freshDeps({
			broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
		});
		await base.ipcMain.invokeHandler("history:add", {
			fileName: "a.wav",
			transcriptionText: "one",
		});
		const list = (await base.ipcMain.invokeHandler("history:list", { offset: 0, limit: 10 })) as {
			entries: unknown[];
			hasMore: boolean;
		};
		expect(Array.isArray(list.entries)).toBe(true);
		expect(list.entries.length).toBe(1);
		// onAdded routed through the injected broadcast.
		expect(broadcasts.some((b) => b.channel === "history:row-added")).toBe(true);
		result.dispose();
	});

	test("HISTORY_DELETE_ROW: non-number id → {deleted:false}; valid id deletes + broadcasts", async () => {
		fsState.recordingsExists = true;
		const broadcasts: Array<{ channel: string; payload: unknown }> = [];
		fspState.unlinkPaths = [];
		fspState.unlinkError = null;
		const { result } = freshDeps({
			broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
		});
		const added = (await base.ipcMain.invokeHandler("history:add", {
			fileName: "del.wav",
			transcriptionText: "del me",
		})) as { id: number };

		const bad = await base.ipcMain.invokeHandler("history:delete-row", "not-a-number");
		expect(bad).toEqual({ deleted: false });

		const ok = await base.ipcMain.invokeHandler("history:delete-row", added.id);
		expect(ok).toEqual({ deleted: true });
		expect(broadcasts.some((b) => b.channel === "history:row-deleted")).toBe(true);
		// onWavDelete fired → unlink called with the recordings-dir-joined path.
		await new Promise((r) => setTimeout(r, 0)); // let the emitWavDelete microtask settle
		expect(fspState.unlinkPaths.some((p) => p.includes("del.wav"))).toBe(true);
		result.dispose();
	});

	test("HISTORY_TOGGLE: non-number id → {saved:null}; valid id flips + broadcasts", async () => {
		fsState.recordingsExists = true;
		const broadcasts: Array<{ channel: string; payload: unknown }> = [];
		const { result } = freshDeps({
			broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
		});
		const added = (await base.ipcMain.invokeHandler("history:add", {
			fileName: "t.wav",
			transcriptionText: "toggle me",
		})) as { id: number };

		const bad = await base.ipcMain.invokeHandler("history:toggle", "nope");
		expect(bad).toEqual({ saved: null });

		const ok = (await base.ipcMain.invokeHandler("history:toggle", added.id)) as {
			saved: boolean | null;
		};
		expect(ok.saved).toBe(true);
		expect(broadcasts.some((b) => b.channel === "history:row-toggled")).toBe(true);
		result.dispose();
	});

	test("HISTORY_RECENT: defaults to 5 for non-number, honours number arg", async () => {
		fsState.recordingsExists = true;
		const { result } = freshDeps();
		await base.ipcMain.invokeHandler("history:add", {
			fileName: "r.wav",
			transcriptionText: "recent",
		});
		const def = (await base.ipcMain.invokeHandler("history:recent", "not-a-number")) as unknown[];
		expect(Array.isArray(def)).toBe(true);
		const n = (await base.ipcMain.invokeHandler("history:recent", 3)) as unknown[];
		expect(Array.isArray(n)).toBe(true);
		result.dispose();
	});

	test("HISTORY_LOAD_AUDIO_BY_ROW: non-number → null", async () => {
		fsState.recordingsExists = true;
		const { result } = freshDeps();
		const out = await base.ipcMain.invokeHandler("history:load-audio-by-row", "x");
		expect(out).toBeNull();
		result.dispose();
	});

	test("HISTORY_LOAD_AUDIO_BY_ROW: missing row → null", async () => {
		fsState.recordingsExists = true;
		const { result } = freshDeps();
		const out = await base.ipcMain.invokeHandler("history:load-audio-by-row", 9999);
		expect(out).toBeNull();
		result.dispose();
	});

	test("HISTORY_LOAD_AUDIO_BY_ROW: empty fileName → null", async () => {
		fsState.recordingsExists = true;
		const { result } = freshDeps();
		const added = (await base.ipcMain.invokeHandler("history:add", {
			fileName: "",
			transcriptionText: "no file",
		})) as { id: number };
		const out = await base.ipcMain.invokeHandler("history:load-audio-by-row", added.id);
		expect(out).toBeNull();
		result.dispose();
	});

	test("HISTORY_LOAD_AUDIO_BY_ROW: reads file → base64 data URL", async () => {
		fsState.recordingsExists = true;
		fspState.readFileError = null;
		fspState.readFileResult = Buffer.from("RIFFWAVE");
		const { result } = freshDeps();
		const added = (await base.ipcMain.invokeHandler("history:add", {
			fileName: "play.wav",
			transcriptionText: "audio",
		})) as { id: number };
		const out = (await base.ipcMain.invokeHandler("history:load-audio-by-row", added.id)) as string;
		expect(out).toBe(`data:audio/wav;base64,${Buffer.from("RIFFWAVE").toString("base64")}`);
		result.dispose();
	});

	test("HISTORY_LOAD_AUDIO_BY_ROW: ENOENT on read → null (isEnoent true branch)", async () => {
		fsState.recordingsExists = true;
		fspState.readFileError = enoent();
		const { result } = freshDeps();
		const added = (await base.ipcMain.invokeHandler("history:add", {
			fileName: "gone.wav",
			transcriptionText: "missing",
		})) as { id: number };
		const out = await base.ipcMain.invokeHandler("history:load-audio-by-row", added.id);
		expect(out).toBeNull();
		fspState.readFileError = null;
		result.dispose();
	});

	test("HISTORY_LOAD_AUDIO_BY_ROW: non-ENOENT read error → null + logged (isEnoent false branch)", async () => {
		fsState.recordingsExists = true;
		fspState.readFileError = new Error("EACCES denied");
		consoleLogLines.length = 0;
		const { result } = freshDeps();
		const added = (await base.ipcMain.invokeHandler("history:add", {
			fileName: "locked.wav",
			transcriptionText: "perm",
		})) as { id: number };
		const out = await base.ipcMain.invokeHandler("history:load-audio-by-row", added.id);
		expect(out).toBeNull();
		expect(recentLogContains("load-audio failed for locked.wav")).toBe(true);
		fspState.readFileError = null;
		result.dispose();
	});

	test("onWavDelete swallows ENOENT (no log), PROPAGATES non-ENOENT to onSweepError", async () => {
		fsState.recordingsExists = true;
		// ENOENT path: deletion of a row whose wav is already gone → swallowed
		// silently (the row delete already succeeded, the file simply wasn't there).
		fspState.unlinkError = enoent();
		fspState.unlinkPaths = [];
		consoleLogLines.length = 0;
		const a = freshDeps();
		const added = (await base.ipcMain.invokeHandler("history:add", {
			fileName: "enoent.wav",
			transcriptionText: "x",
		})) as { id: number };
		await base.ipcMain.invokeHandler("history:delete-row", added.id);
		await new Promise((r) => setTimeout(r, 0));
		expect(fspState.unlinkPaths.some((p) => p.includes("enoent.wav"))).toBe(true);
		// No error surfaced for the ENOENT case.
		expect(recentLogContains("sweep/WAV error")).toBe(false);
		a.result.dispose();

		// Bug #4 regression: a non-ENOENT unlink failure (EBUSY/EPERM/EACCES) must
		// be RE-THROWN out of onWavDelete so it reaches the store's onSweepError
		// sink, instead of being absorbed by onWavDelete's own catch (which used to
		// log `unlink <file> raised` and then resolve as if the unlink had worked,
		// hiding the failure from every error consumer). setupHistoryIpc's
		// onSweepError logs `sweep/WAV error`.
		fspState.unlinkError = new Error("EBUSY");
		fspState.unlinkPaths = [];
		consoleLogLines.length = 0;
		const b = freshDeps();
		const added2 = (await base.ipcMain.invokeHandler("history:add", {
			fileName: "busy.wav",
			transcriptionText: "y",
		})) as { id: number };
		await base.ipcMain.invokeHandler("history:delete-row", added2.id);
		await new Promise((r) => setTimeout(r, 0));
		expect(recentLogContains("sweep/WAV error")).toBe(true);
		// The old absorb-and-log line is gone — the failure no longer stops at
		// onWavDelete's catch.
		expect(recentLogContains("unlink busy.wav raised")).toBe(false);
		fspState.unlinkError = null;
		b.result.dispose();
	});

	test("runSweep runs at startup and logs when rows are removed", async () => {
		fsState.recordingsExists = true;
		fspState.unlinkError = null;
		consoleLogLines.length = 0;
		// getRetention=preserveLimit, getLimit=1, and we seed 2 transient rows so
		// the startup sweep deletes 1 → logs "retention swept N rows".
		// Insert BEFORE setup isn't possible (store is created inside setup), so
		// instead we rely on the sweep candidate query returning seeded rows. We
		// pre-populate via a custom fake whose sweep-candidate `all` yields rows.
		const fake = makeFakeDb({
			pragmaReturns: { user_version: 0 },
			stmt: (sql) => {
				if (sql.includes("saved = 0")) {
					return { all: () => [{ id: 7, file_name: "old.wav" }] };
				}
				if (sql.startsWith("DELETE")) {
					return { run: () => ({ changes: 1, lastInsertRowid: 0 }) };
				}
				return {};
			},
		});
		const result = setupHistoryIpc({
			userDataDir: "/mock/ipc",
			openDatabase: () => fake.db,
			getRetention: () => "preserveLimit",
			getLimit: () => 1,
			broadcast: () => undefined,
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(recentLogContains("retention swept")).toBe(true);
		result.dispose();
	});

	test("runSweep catches a throwing store.sweep and logs 'sweep raised'", () => {
		fsState.recordingsExists = true;
		consoleLogLines.length = 0;
		// Make the sweep-candidate query throw → store.sweep throws → runSweep
		// catch fires.
		const fake = makeFakeDb({
			pragmaReturns: { user_version: 0 },
			stmt: (sql) => {
				if (sql.includes("saved = 0")) {
					return {
						all: () => {
							throw new Error("sweep query exploded");
						},
					};
				}
				return {};
			},
		});
		const result = setupHistoryIpc({
			userDataDir: "/mock/ipc",
			openDatabase: () => fake.db,
			getRetention: () => "days3",
			getLimit: () => 5,
			broadcast: () => undefined,
		});
		expect(recentLogContains("sweep raised")).toBe(true);
		result.dispose();
	});

	test("runSweep uses defaults (preserveLimit / limit 5) when getters omitted", () => {
		fsState.recordingsExists = true;
		let sweepArgs: { period: string; offset: unknown } | null = null;
		const fake = makeFakeDb({
			pragmaReturns: { user_version: 0 },
			stmt: (sql) => {
				if (sql.includes("saved = 0")) {
					return {
						all: (offset) => {
							sweepArgs = { period: "preserveLimit", offset };
							return [];
						},
					};
				}
				return {};
			},
		});
		const result = setupHistoryIpc({
			userDataDir: "/mock/ipc",
			openDatabase: () => fake.db,
			broadcast: () => undefined,
		});
		// Default limit 5 → sweepByCount queried with OFFSET 5.
		expect(sweepArgs).not.toBeNull();
		expect((sweepArgs as unknown as { offset: number }).offset).toBe(5);
		result.dispose();
	});

	test("setupHistoryIpc populates getActiveHistoryStore; dispose clears it", () => {
		fsState.recordingsExists = true;
		const { result } = freshDeps();
		expect(getActiveHistoryStore()).toBe(result.store);
		result.dispose();
		expect(getActiveHistoryStore()).toBeNull();
	});

	test("dispose removes every history:* handler and closes the store", async () => {
		fsState.recordingsExists = true;
		const { result, fake } = freshDeps();
		// Handlers exist before dispose.
		expect(base.ipcMain._handlers.has("history:list")).toBe(true);
		result.dispose();
		// All six handlers removed.
		for (const ch of [
			"history:list",
			"history:add",
			"history:delete-row",
			"history:toggle",
			"history:recent",
			"history:load-audio-by-row",
		]) {
			expect(base.ipcMain._handlers.has(ch)).toBe(false);
		}
		// Store close called once.
		expect(fake.closedCount()).toBe(1);
	});

	test("dispose: a throwing store.close is caught and logged", () => {
		fsState.recordingsExists = true;
		consoleLogLines.length = 0;
		const fake = makeFakeDb({ pragmaReturns: { user_version: 0 }, closeThrows: true });
		const result = setupHistoryIpc({
			userDataDir: "/mock/ipc",
			openDatabase: () => fake.db,
			broadcast: () => undefined,
		});
		result.dispose();
		expect(recentLogContains("db close raised")).toBe(true);
	});

	test("dispose does NOT null a newer active store when called out of order", () => {
		fsState.recordingsExists = true;
		const first = freshDeps();
		const second = freshDeps(); // overwrites _activeHistoryStore with second.store
		expect(getActiveHistoryStore()).toBe(second.result.store);
		// Disposing the FIRST must NOT clear the second's active handle
		// (the `_activeHistoryStore === store` guard).
		first.result.dispose();
		expect(getActiveHistoryStore()).toBe(second.result.store);
		second.result.dispose();
		expect(getActiveHistoryStore()).toBeNull();
	});

	test("returns the resolved dbPath and recordingsDir", () => {
		fsState.recordingsExists = true;
		const { result } = freshDeps();
		expect(result.dbPath.includes("history.db")).toBe(true);
		expect(result.recordingsDir.includes("recordings")).toBe(true);
		result.dispose();
	});
});
