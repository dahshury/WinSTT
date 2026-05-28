/**
 * Pure SQLite-history domain logic — no electron imports. Imported by
 * `history.ts` (which wires it to ipcMain / BrowserWindow) and by tests that
 * use a fake DB driver.
 *
 * The shape mirrors Handy's `src-tauri/src/managers/history.rs` so we can
 * reuse its data conventions without paying the Rust runtime cost:
 *
 *   - `transcription_history` table with autoincrement PK, `saved` pin flag,
 *     pre/post-LLM text + prompt, and a `post_process_requested` boolean.
 *   - Migrations applied as an ordered list of SQL strings, tracked via
 *     SQLite's `PRAGMA user_version` (no schema-history table needed).
 *   - Retention sweeper honours the `RecordingRetentionPeriod` enum:
 *     never / preserveLimit (alias: cap) / days3 / weeks2 / months3.
 *   - Saved entries are never auto-deleted; only "transient" rows age out.
 */

export type RecordingRetentionPeriod =
	| "never"
	| "preserveLimit"
	| "cap"
	| "days3"
	| "weeks2"
	| "months3";

export interface HistoryEntryRow {
	fileName: string;
	id: number;
	postProcessedText: string | null;
	postProcessPrompt: string | null;
	postProcessRequested: boolean;
	saved: boolean;
	timestamp: number;
	title: string;
	transcriptionText: string;
}

export interface PaginatedHistory {
	entries: HistoryEntryRow[];
	hasMore: boolean;
}

export interface HistoryAddInput {
	fileName: string;
	postProcessedText?: string | null;
	postProcessPrompt?: string | null;
	postProcessRequested?: boolean;
	saved?: boolean;
	timestamp?: number;
	title?: string;
	transcriptionText: string;
}

/**
 * Migrations are applied in order. The version equals the array length; this
 * matches `rusqlite_migration`'s contract used by Handy and keeps the system
 * forward-only (no `down` paths — broken migrations are fixed by appending a
 * corrective migration).
 */
export const MIGRATIONS: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS transcription_history (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		file_name TEXT NOT NULL,
		timestamp INTEGER NOT NULL,
		saved INTEGER NOT NULL DEFAULT 0,
		title TEXT NOT NULL,
		transcription_text TEXT NOT NULL
	)`,
	"ALTER TABLE transcription_history ADD COLUMN post_processed_text TEXT",
	"ALTER TABLE transcription_history ADD COLUMN post_process_prompt TEXT",
	"ALTER TABLE transcription_history ADD COLUMN post_process_requested INTEGER NOT NULL DEFAULT 0",
	// Composite index for the saved-flag retention queries — both `preserveLimit`
	// and time-window sweeps filter on `saved=0` then order/restrict by id or
	// timestamp.
	"CREATE INDEX IF NOT EXISTS idx_history_saved_timestamp ON transcription_history(saved, timestamp DESC)",
];

/**
 * Minimal subset of the SQLite Database API we depend on (a `pragma` +
 * `transaction` superset of `node:sqlite`, synthesized by the adapter in
 * `history.ts`). Defined as an interface so the test suite can supply an
 * in-memory fake without booting any SQLite engine under Bun's runtime.
 */
export interface DatabaseLike {
	close: () => void;
	exec: (sql: string) => void;
	pragma: (text: string, options?: { simple?: boolean }) => unknown;
	prepare: (sql: string) => StatementLike;
	transaction: <Args extends unknown[], R>(fn: (...args: Args) => R) => (...args: Args) => R;
}

export interface StatementLike {
	all: (...params: unknown[]) => unknown[];
	get: (...params: unknown[]) => unknown;
	run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
}

interface DbRow {
	file_name: string;
	id: number | bigint;
	post_process_prompt: string | null;
	post_process_requested: number;
	post_processed_text: string | null;
	saved: number;
	timestamp: number | bigint;
	title: string;
	transcription_text: string;
}

function isDbRow(value: unknown): value is DbRow {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const r = value as Record<string, unknown>;
	const idOk = typeof r.id === "number" || typeof r.id === "bigint";
	const tsOk = typeof r.timestamp === "number" || typeof r.timestamp === "bigint";
	return (
		idOk &&
		tsOk &&
		typeof r.file_name === "string" &&
		typeof r.saved === "number" &&
		typeof r.title === "string" &&
		typeof r.transcription_text === "string"
	);
}

function toNumber(value: number | bigint): number {
	return typeof value === "bigint" ? Number(value) : value;
}

function mapRow(row: DbRow): HistoryEntryRow {
	return {
		id: toNumber(row.id),
		fileName: row.file_name,
		timestamp: toNumber(row.timestamp),
		saved: row.saved !== 0,
		title: row.title,
		transcriptionText: row.transcription_text,
		postProcessedText: row.post_processed_text,
		postProcessPrompt: row.post_process_prompt,
		postProcessRequested: row.post_process_requested !== 0,
	};
}

function formatTimestampTitle(timestamp: number): string {
	// Match Handy: "Month D, YYYY - H:MMam/pm" in the user's local time. Falls
	// back to a Unix-stamp string if Date can't parse (e.g. ts=-1 in a test).
	const d = new Date(timestamp * 1000);
	if (Number.isNaN(d.getTime())) {
		return `Recording ${timestamp}`;
	}
	const month = d.toLocaleString("en-US", { month: "long" });
	const day = d.getDate();
	const year = d.getFullYear();
	const hour12 = ((d.getHours() + 11) % 12) + 1;
	const minute = d.getMinutes().toString().padStart(2, "0");
	const ampm = d.getHours() < 12 ? "am" : "pm";
	return `${month} ${day}, ${year} - ${hour12}:${minute}${ampm}`;
}

/**
 * Apply pending migrations under the `PRAGMA user_version` contract used by
 * Handy. Runs every migration whose 1-indexed position is greater than the
 * current version; bumps `user_version` to `MIGRATIONS.length` on completion.
 */
export function runMigrations(db: DatabaseLike, migrations: readonly string[] = MIGRATIONS): void {
	const currentRaw = db.pragma("user_version", { simple: true });
	const current = typeof currentRaw === "number" ? currentRaw : 0;
	for (let i = current; i < migrations.length; i += 1) {
		db.exec(migrations[i] ?? "");
	}
	if (migrations.length > current) {
		db.pragma(`user_version = ${migrations.length}`);
	}
}

export interface HistoryStore {
	add(entry: HistoryAddInput): HistoryEntryRow;
	close(): void;
	deleteById(id: number): boolean;
	getById(id: number): HistoryEntryRow | null;
	list(options: { offset?: number; limit?: number }): PaginatedHistory;
	recent(n: number): HistoryEntryRow[];
	sweep(period: RecordingRetentionPeriod, limit: number, nowSeconds?: number): number;
	toggle(id: number): boolean | null;
}

export interface HistoryStoreOptions {
	db: DatabaseLike;
	now?: () => number;
	onAdded?: (entry: HistoryEntryRow) => void;
	onDeleted?: (id: number) => void;
	onSweepError?: (err: unknown) => void;
	onToggled?: (id: number, saved: boolean) => void;
	onWavDelete?: (fileName: string) => Promise<void> | void;
}

/**
 * Build a `HistoryStore` wired to an already-open `DatabaseLike`. Migrations
 * are NOT applied here — callers do that explicitly via `runMigrations` so the
 * test surface can stage half-migrated schemas if needed.
 */
export function createHistoryStore(options: HistoryStoreOptions): HistoryStore {
	const { db } = options;
	const now = options.now ?? (() => Math.floor(Date.now() / 1000));

	const insertStmt = db.prepare(
		`INSERT INTO transcription_history (
			file_name, timestamp, saved, title, transcription_text,
			post_processed_text, post_process_prompt, post_process_requested
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const selectByIdStmt = db.prepare(
		`SELECT id, file_name, timestamp, saved, title, transcription_text,
			post_processed_text, post_process_prompt, post_process_requested
		FROM transcription_history WHERE id = ?`
	);
	const deleteByIdStmt = db.prepare("DELETE FROM transcription_history WHERE id = ?");
	const toggleStmt = db.prepare("UPDATE transcription_history SET saved = ? WHERE id = ?");
	const listPageStmt = db.prepare(
		`SELECT id, file_name, timestamp, saved, title, transcription_text,
			post_processed_text, post_process_prompt, post_process_requested
		FROM transcription_history
		ORDER BY id DESC
		LIMIT ? OFFSET ?`
	);
	const recentStmt = db.prepare(
		`SELECT id, file_name, timestamp, saved, title, transcription_text,
			post_processed_text, post_process_prompt, post_process_requested
		FROM transcription_history
		ORDER BY id DESC
		LIMIT ?`
	);
	const sweepByCountStmt = db.prepare(
		`SELECT id, file_name FROM transcription_history
		WHERE saved = 0
		ORDER BY timestamp DESC
		LIMIT -1 OFFSET ?`
	);
	const sweepByTimeStmt = db.prepare(
		`SELECT id, file_name FROM transcription_history
		WHERE saved = 0 AND timestamp < ?`
	);

	function emitWavDelete(fileName: string): void {
		if (!options.onWavDelete || fileName === "") {
			return;
		}
		Promise.resolve(options.onWavDelete(fileName)).catch((err: unknown) => {
			options.onSweepError?.(err);
		});
	}

	function deleteEntries(rows: { id: number; file_name: string }[]): number {
		if (rows.length === 0) {
			return 0;
		}
		const tx = db.transaction((batch: { id: number; file_name: string }[]) => {
			for (const row of batch) {
				deleteByIdStmt.run(row.id);
			}
		});
		tx(rows);
		for (const row of rows) {
			emitWavDelete(row.file_name);
			options.onDeleted?.(row.id);
		}
		return rows.length;
	}

	return {
		add(entry: HistoryAddInput): HistoryEntryRow {
			const timestamp = entry.timestamp ?? now();
			const title = entry.title ?? formatTimestampTitle(timestamp);
			const result = insertStmt.run(
				entry.fileName,
				timestamp,
				entry.saved === true ? 1 : 0,
				title,
				entry.transcriptionText,
				entry.postProcessedText ?? null,
				entry.postProcessPrompt ?? null,
				entry.postProcessRequested === true ? 1 : 0
			);
			const row: HistoryEntryRow = {
				id: toNumber(result.lastInsertRowid),
				fileName: entry.fileName,
				timestamp,
				saved: entry.saved === true,
				title,
				transcriptionText: entry.transcriptionText,
				postProcessedText: entry.postProcessedText ?? null,
				postProcessPrompt: entry.postProcessPrompt ?? null,
				postProcessRequested: entry.postProcessRequested === true,
			};
			options.onAdded?.(row);
			return row;
		},
		list({ offset = 0, limit = 50 }: { offset?: number; limit?: number }): PaginatedHistory {
			const cappedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
			const safeOffset = Math.max(0, Math.floor(offset));
			// Over-fetch by one to determine `hasMore` without a separate COUNT.
			const fetched = listPageStmt.all(cappedLimit + 1, safeOffset);
			const rows = fetched.filter(isDbRow).map(mapRow);
			const hasMore = rows.length > cappedLimit;
			if (hasMore) {
				rows.pop();
			}
			return { entries: rows, hasMore };
		},
		recent(n: number): HistoryEntryRow[] {
			const capped = Math.max(1, Math.min(50, Math.floor(n)));
			const rows = recentStmt.all(capped);
			return rows.filter(isDbRow).map(mapRow);
		},
		getById(id: number): HistoryEntryRow | null {
			const row = selectByIdStmt.get(id);
			if (!isDbRow(row)) {
				return null;
			}
			return mapRow(row);
		},
		deleteById(id: number): boolean {
			const row = selectByIdStmt.get(id);
			if (!isDbRow(row)) {
				return false;
			}
			const mapped = mapRow(row);
			const res = deleteByIdStmt.run(id);
			const changed = res.changes > 0;
			if (changed) {
				emitWavDelete(mapped.fileName);
				options.onDeleted?.(mapped.id);
			}
			return changed;
		},
		toggle(id: number): boolean | null {
			const row = selectByIdStmt.get(id);
			if (!isDbRow(row)) {
				return null;
			}
			const next = row.saved === 0 ? 1 : 0;
			toggleStmt.run(next, id);
			const saved = next === 1;
			options.onToggled?.(toNumber(row.id), saved);
			return saved;
		},
		sweep(period: RecordingRetentionPeriod, limit: number, nowSeconds: number = now()): number {
			if (period === "never") {
				return 0;
			}
			if (period === "preserveLimit" || period === "cap") {
				const cap = Math.max(1, Math.floor(limit));
				const stale = sweepByCountStmt.all(cap);
				return deleteEntries(stale.filter(isCountRow));
			}
			const cutoff = computeCutoff(period, nowSeconds);
			if (cutoff === null) {
				return 0;
			}
			const stale = sweepByTimeStmt.all(cutoff);
			return deleteEntries(stale.filter(isCountRow));
		},
		close(): void {
			db.close();
		},
	};
}

function isCountRow(value: unknown): value is { id: number; file_name: string } {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const r = value as Record<string, unknown>;
	return (typeof r.id === "number" || typeof r.id === "bigint") && typeof r.file_name === "string";
}

function computeCutoff(period: RecordingRetentionPeriod, nowSeconds: number): number | null {
	const day = 24 * 60 * 60;
	if (period === "days3") {
		return nowSeconds - 3 * day;
	}
	if (period === "weeks2") {
		return nowSeconds - 14 * day;
	}
	if (period === "months3") {
		return nowSeconds - 90 * day;
	}
	return null;
}

export function parsePageArgs(payload: unknown): { offset: number; limit: number } {
	if (payload === null || typeof payload !== "object") {
		return { offset: 0, limit: 50 };
	}
	const obj = payload as { offset?: unknown; limit?: unknown };
	const offset = typeof obj.offset === "number" ? obj.offset : 0;
	const limit = typeof obj.limit === "number" ? obj.limit : 50;
	return { offset, limit };
}

export function parseAddInput(payload: unknown): HistoryAddInput | null {
	if (payload === null || typeof payload !== "object") {
		return null;
	}
	const obj = payload as Record<string, unknown>;
	const fileName = typeof obj.fileName === "string" ? obj.fileName : null;
	const transcriptionText =
		typeof obj.transcriptionText === "string" ? obj.transcriptionText : null;
	if (fileName === null || transcriptionText === null) {
		return null;
	}
	const out: HistoryAddInput = { fileName, transcriptionText };
	if (typeof obj.postProcessedText === "string" || obj.postProcessedText === null) {
		out.postProcessedText = obj.postProcessedText as string | null;
	}
	if (typeof obj.postProcessPrompt === "string" || obj.postProcessPrompt === null) {
		out.postProcessPrompt = obj.postProcessPrompt as string | null;
	}
	if (typeof obj.postProcessRequested === "boolean") {
		out.postProcessRequested = obj.postProcessRequested;
	}
	if (typeof obj.title === "string") {
		out.title = obj.title;
	}
	if (typeof obj.timestamp === "number") {
		out.timestamp = obj.timestamp;
	}
	if (typeof obj.saved === "boolean") {
		out.saved = obj.saved;
	}
	return out;
}

/** Test hook — exposes private helpers for unit-level coverage. */
export const __test__ = {
	computeCutoff,
	formatTimestampTitle,
	mapRow,
	isCountRow,
	isDbRow,
};
