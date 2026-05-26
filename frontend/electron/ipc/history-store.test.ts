import { describe, expect, test } from "bun:test";
import {
	__test__,
	createHistoryStore,
	type DatabaseLike,
	type HistoryEntryRow,
	MIGRATIONS,
	type PaginatedHistory,
	parseAddInput,
	parsePageArgs,
	runMigrations,
	type StatementLike,
} from "./history-store";

/**
 * In-memory fake of the better-sqlite3 surface our history module touches.
 * Implements just enough of the API to validate migrations, CRUD, list
 * pagination, and retention sweeps without booting the native binding.
 */
interface FakeRow {
	file_name: string;
	id: number;
	post_process_prompt: string | null;
	post_process_requested: number;
	post_processed_text: string | null;
	saved: number;
	timestamp: number;
	title: string;
	transcription_text: string;
}

function makeFakeDb(): DatabaseLike & { _rows: FakeRow[]; _version: number; _execLog: string[] } {
	const rows: FakeRow[] = [];
	let nextId = 1;
	let userVersion = 0;
	const execLog: string[] = [];

	function pragma(text: string, opts?: { simple?: boolean }): unknown {
		if (text === "user_version") {
			return opts?.simple ? userVersion : [{ user_version: userVersion }];
		}
		const m = /^user_version\s*=\s*(\d+)$/.exec(text);
		if (m) {
			userVersion = Number(m[1]);
			return;
		}
		return;
	}

	function exec(sql: string): void {
		execLog.push(sql);
	}

	function prepare(sql: string): StatementLike {
		const isInsert = /INSERT INTO transcription_history/i.test(sql);
		const isSelectById = /WHERE id = \?$/i.test(sql) && /^SELECT/i.test(sql);
		const isDelete = /^DELETE FROM transcription_history WHERE id = \?$/i.test(sql);
		const isToggle = /^UPDATE transcription_history SET saved = \? WHERE id = \?$/i.test(sql);
		const isListPage = /ORDER BY id DESC\s+LIMIT \? OFFSET \?/i.test(sql);
		const isRecent = /ORDER BY id DESC\s+LIMIT \?$/i.test(sql) && !isListPage;
		const isSweepCount =
			/SELECT id, file_name FROM transcription_history\s+WHERE saved = 0\s+ORDER BY timestamp DESC\s+LIMIT -1 OFFSET \?/i.test(
				sql
			);
		const isSweepTime =
			/SELECT id, file_name FROM transcription_history\s+WHERE saved = 0 AND timestamp < \?$/i.test(
				sql
			);

		return {
			run(...params: unknown[]) {
				if (isInsert) {
					const id = nextId++;
					rows.push({
						id,
						file_name: String(params[0]),
						timestamp: Number(params[1]),
						saved: Number(params[2]),
						title: String(params[3]),
						transcription_text: String(params[4]),
						post_processed_text: (params[5] as string | null) ?? null,
						post_process_prompt: (params[6] as string | null) ?? null,
						post_process_requested: Number(params[7]),
					});
					return { changes: 1, lastInsertRowid: id };
				}
				if (isDelete) {
					const id = Number(params[0]);
					const idx = rows.findIndex((r) => r.id === id);
					if (idx < 0) {
						return { changes: 0, lastInsertRowid: 0 };
					}
					rows.splice(idx, 1);
					return { changes: 1, lastInsertRowid: 0 };
				}
				if (isToggle) {
					const next = Number(params[0]);
					const id = Number(params[1]);
					const row = rows.find((r) => r.id === id);
					if (!row) {
						return { changes: 0, lastInsertRowid: 0 };
					}
					row.saved = next;
					return { changes: 1, lastInsertRowid: 0 };
				}
				return { changes: 0, lastInsertRowid: 0 };
			},
			get(...params: unknown[]) {
				if (isSelectById) {
					const id = Number(params[0]);
					return rows.find((r) => r.id === id) ?? undefined;
				}
				return;
			},
			all(...params: unknown[]) {
				if (isListPage) {
					const limit = Number(params[0]);
					const offset = Number(params[1]);
					return [...rows].sort((a, b) => b.id - a.id).slice(offset, offset + limit);
				}
				if (isRecent) {
					const limit = Number(params[0]);
					return [...rows].sort((a, b) => b.id - a.id).slice(0, limit);
				}
				if (isSweepCount) {
					const offset = Number(params[0]);
					return [...rows]
						.filter((r) => r.saved === 0)
						.sort((a, b) => b.timestamp - a.timestamp)
						.slice(offset)
						.map((r) => ({ id: r.id, file_name: r.file_name }));
				}
				if (isSweepTime) {
					const cutoff = Number(params[0]);
					return rows
						.filter((r) => r.saved === 0 && r.timestamp < cutoff)
						.map((r) => ({ id: r.id, file_name: r.file_name }));
				}
				return [];
			},
		};
	}

	function transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
		return (...args: Args) => fn(...args);
	}

	return {
		pragma,
		exec,
		prepare,
		close() {
			/* noop */
		},
		transaction,
		_rows: rows,
		_version: userVersion,
		_execLog: execLog,
	};
}

function setupStore(now = 1_700_000_000) {
	const db = makeFakeDb();
	runMigrations(db);
	const added: number[] = [];
	const deleted: number[] = [];
	const toggled: { id: number; saved: boolean }[] = [];
	const unlinked: string[] = [];
	const store = createHistoryStore({
		db,
		now: () => now,
		onAdded: (row) => added.push(row.id),
		onDeleted: (id) => deleted.push(id),
		onToggled: (id, saved) => toggled.push({ id, saved }),
		onWavDelete: (fileName) => {
			unlinked.push(fileName);
		},
	});
	return { db, store, added, deleted, toggled, unlinked };
}

describe("runMigrations", () => {
	test("applies all migrations on a fresh DB and bumps user_version", () => {
		const db = makeFakeDb();
		runMigrations(db);
		expect(db._execLog.length).toBe(MIGRATIONS.length);
		expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
	});

	test("re-running is a no-op once user_version matches", () => {
		const db = makeFakeDb();
		runMigrations(db);
		const after = db._execLog.length;
		runMigrations(db);
		expect(db._execLog.length).toBe(after);
	});

	test("partial schemas resume from the recorded user_version", () => {
		const db = makeFakeDb();
		db.pragma(`user_version = ${MIGRATIONS.length - 1}`);
		runMigrations(db);
		expect(db._execLog.length).toBe(1);
		expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
	});
});

describe("createHistoryStore.add", () => {
	test("inserts a row + emits onAdded and assigns the default title", () => {
		const { store, added } = setupStore(1_700_000_000);
		const row = store.add({
			fileName: "winstt-1700000000.wav",
			transcriptionText: "hello world",
		});
		expect(row.id).toBe(1);
		expect(row.timestamp).toBe(1_700_000_000);
		expect(row.fileName).toBe("winstt-1700000000.wav");
		expect(row.saved).toBe(false);
		expect(row.title).toContain(",");
		expect(added).toEqual([1]);
	});

	test("respects an explicit timestamp + title + saved flag", () => {
		const { store } = setupStore();
		const row = store.add({
			fileName: "x.wav",
			transcriptionText: "pinned",
			timestamp: 123_456,
			title: "Manual",
			saved: true,
			postProcessRequested: true,
			postProcessedText: "Pinned.",
			postProcessPrompt: "Be terse.",
		});
		expect(row.timestamp).toBe(123_456);
		expect(row.title).toBe("Manual");
		expect(row.saved).toBe(true);
		expect(row.postProcessRequested).toBe(true);
		expect(row.postProcessedText).toBe("Pinned.");
		expect(row.postProcessPrompt).toBe("Be terse.");
	});
});

describe("createHistoryStore.list pagination", () => {
	test("returns newest-first slices and exposes hasMore via over-fetch", () => {
		const { store } = setupStore();
		for (let i = 0; i < 7; i += 1) {
			store.add({ fileName: `f${i}.wav`, transcriptionText: `t${i}`, timestamp: 1000 + i });
		}
		const page1: PaginatedHistory = store.list({ offset: 0, limit: 3 });
		const ids: number[] = page1.entries.map((e: HistoryEntryRow) => e.id);
		expect(ids).toEqual([7, 6, 5]);
		expect(page1.hasMore).toBe(true);

		const lastPage = store.list({ offset: 6, limit: 3 });
		expect(lastPage.entries.map((e) => e.id)).toEqual([1]);
		expect(lastPage.hasMore).toBe(false);
	});

	test("clamps limit into [1, 100] and offset to >= 0", () => {
		const { store } = setupStore();
		for (let i = 0; i < 3; i += 1) {
			store.add({ fileName: `${i}.wav`, transcriptionText: `t${i}` });
		}
		const tooLow = store.list({ offset: -5, limit: 0 });
		expect(tooLow.entries.length).toBe(1);
		const tooHigh = store.list({ offset: 0, limit: 999 });
		expect(tooHigh.entries.length).toBe(3);
	});
});

describe("createHistoryStore.delete + toggle", () => {
	test("delete removes the row and fires the WAV unlink hook", () => {
		const { store, deleted, unlinked } = setupStore();
		const row = store.add({ fileName: "byebye.wav", transcriptionText: "x" });
		expect(store.deleteById(row.id)).toBe(true);
		expect(deleted).toEqual([row.id]);
		expect(unlinked).toEqual(["byebye.wav"]);
		expect(store.deleteById(row.id)).toBe(false);
	});

	test("toggle flips saved + emits broadcast; unknown id returns null", () => {
		const { store, toggled } = setupStore();
		const row = store.add({ fileName: "a.wav", transcriptionText: "y" });
		expect(store.toggle(row.id)).toBe(true);
		expect(store.toggle(row.id)).toBe(false);
		expect(store.toggle(99)).toBeNull();
		expect(toggled).toEqual([
			{ id: row.id, saved: true },
			{ id: row.id, saved: false },
		]);
	});
});

describe("createHistoryStore.recent", () => {
	test("returns the N newest rows + clamps the cap", () => {
		const { store } = setupStore();
		for (let i = 0; i < 8; i += 1) {
			store.add({ fileName: `${i}.wav`, transcriptionText: `t${i}`, timestamp: 100 + i });
		}
		expect(store.recent(3).map((e) => e.id)).toEqual([8, 7, 6]);
		expect(store.recent(0).length).toBe(1); // floored to 1
	});
});

describe("createHistoryStore.sweep retention", () => {
	test("never policy returns 0 and keeps every row", () => {
		const { store } = setupStore();
		for (let i = 0; i < 5; i += 1) {
			store.add({ fileName: `${i}.wav`, transcriptionText: `t${i}`, timestamp: i });
		}
		expect(store.sweep("never", 1)).toBe(0);
		expect(store.list({ offset: 0, limit: 100 }).entries.length).toBe(5);
	});

	test("preserveLimit keeps the N most-recent unsaved rows and trashes the rest", () => {
		const { store, unlinked } = setupStore();
		for (let i = 0; i < 5; i += 1) {
			store.add({ fileName: `${i}.wav`, transcriptionText: `t${i}`, timestamp: i });
		}
		const removed = store.sweep("preserveLimit", 2);
		expect(removed).toBe(3);
		expect(unlinked).toEqual(expect.arrayContaining(["0.wav", "1.wav", "2.wav"]));
	});

	test("cap is treated as preserveLimit (legacy alias)", () => {
		const { store } = setupStore();
		for (let i = 0; i < 4; i += 1) {
			store.add({ fileName: `${i}.wav`, transcriptionText: `t${i}`, timestamp: i });
		}
		expect(store.sweep("cap", 1)).toBe(3);
	});

	test("days3 cutoff deletes rows older than the window; saved rows are pinned", () => {
		const now = 10 * 24 * 60 * 60; // 10 days expressed in seconds
		const { store, unlinked } = setupStore(now);
		const stale = store.add({
			fileName: "stale.wav",
			transcriptionText: "old",
			timestamp: 0,
		});
		const fresh = store.add({
			fileName: "fresh.wav",
			transcriptionText: "new",
			timestamp: now - 60,
		});
		store.toggle(fresh.id); // pin
		const pinnedStale = store.add({
			fileName: "pinned.wav",
			transcriptionText: "pinned",
			timestamp: 0,
			saved: true,
		});

		const removed = store.sweep("days3", 5);
		expect(removed).toBe(1);
		expect(unlinked).toEqual(["stale.wav"]);
		expect(store.getById(stale.id)).toBeNull();
		expect(store.getById(fresh.id)).not.toBeNull();
		expect(store.getById(pinnedStale.id)).not.toBeNull();
	});

	test("weeks2 / months3 use their respective cutoffs", () => {
		const now = 365 * 24 * 60 * 60;
		const { store: storeA } = setupStore(now);
		storeA.add({
			fileName: "older.wav",
			transcriptionText: "x",
			timestamp: now - 15 * 24 * 60 * 60,
		});
		storeA.add({
			fileName: "newer.wav",
			transcriptionText: "y",
			timestamp: now - 13 * 24 * 60 * 60,
		});
		expect(storeA.sweep("weeks2", 50)).toBe(1);

		const { store: storeB } = setupStore(now);
		storeB.add({
			fileName: "older.wav",
			transcriptionText: "x",
			timestamp: now - 100 * 24 * 60 * 60,
		});
		storeB.add({
			fileName: "newer.wav",
			transcriptionText: "y",
			timestamp: now - 80 * 24 * 60 * 60,
		});
		expect(storeB.sweep("months3", 50)).toBe(1);
	});
});

describe("__test__ helpers", () => {
	test("computeCutoff matches the day-windowed retention math", () => {
		expect(__test__.computeCutoff("days3", 100 * 86_400)).toBe(97 * 86_400);
		expect(__test__.computeCutoff("weeks2", 100 * 86_400)).toBe(86 * 86_400);
		expect(__test__.computeCutoff("months3", 100 * 86_400)).toBe(10 * 86_400);
		expect(__test__.computeCutoff("never", 100)).toBeNull();
		expect(__test__.computeCutoff("preserveLimit", 100)).toBeNull();
	});

	test("formatTimestampTitle returns a stable fallback for invalid epochs", () => {
		// `Number.MAX_SAFE_INTEGER * 1000` overflows the Date range; the fallback
		// branch produces a deterministic stub.
		const title = __test__.formatTimestampTitle(Number.MAX_SAFE_INTEGER);
		expect(title).toContain(String(Number.MAX_SAFE_INTEGER));
	});

	test("formatTimestampTitle formats a known epoch in a stable shape", () => {
		const title = __test__.formatTimestampTitle(1_700_000_000);
		// Should contain a comma (date) and an am/pm marker.
		expect(title).toMatch(/,/);
		expect(title.toLowerCase()).toMatch(/(am|pm)/);
	});

	test("parseAddInput rejects non-objects and missing keys", () => {
		expect(parseAddInput(null)).toBeNull();
		expect(parseAddInput("string")).toBeNull();
		expect(parseAddInput({ fileName: "x" })).toBeNull();
		expect(parseAddInput({ transcriptionText: "y" })).toBeNull();
		const ok = parseAddInput({ fileName: "x", transcriptionText: "y" });
		expect(ok).toEqual({ fileName: "x", transcriptionText: "y" });
	});

	test("parseAddInput threads optional fields through", () => {
		const ok = parseAddInput({
			fileName: "x",
			transcriptionText: "y",
			postProcessedText: "Y!",
			postProcessPrompt: "p",
			postProcessRequested: true,
			title: "T",
			timestamp: 1,
			saved: true,
		});
		expect(ok).toEqual({
			fileName: "x",
			transcriptionText: "y",
			postProcessedText: "Y!",
			postProcessPrompt: "p",
			postProcessRequested: true,
			title: "T",
			timestamp: 1,
			saved: true,
		});
	});

	test("parsePageArgs falls back to defaults", () => {
		expect(parsePageArgs(null)).toEqual({ offset: 0, limit: 50 });
		expect(parsePageArgs({ offset: 10 })).toEqual({ offset: 10, limit: 50 });
	});

	test("isDbRow / isCountRow guards reject malformed shapes", () => {
		expect(__test__.isDbRow(null)).toBe(false);
		expect(__test__.isDbRow({})).toBe(false);
		expect(__test__.isCountRow({ id: 1, file_name: "x" })).toBe(true);
		expect(__test__.isCountRow({ id: "1" })).toBe(false);
	});
});
