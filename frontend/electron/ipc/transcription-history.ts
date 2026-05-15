export interface TranscriptionHistoryEntry {
	durationMs: number;
	id: string;
	text: string;
	timestamp: number;
	wordCount: number;
}

export interface TranscriptionHistoryStore {
	clear(): void;
	getHistory(): TranscriptionHistoryEntry[];
	record(text: string, durationMs: number): TranscriptionHistoryEntry | null;
}

/**
 * Minimal store contract — `Pick<Store, "get" | "set">` from electron-store v11
 * narrows keys via `DotNotationKeyOf<T>` which collides with our generic
 * "transcriptionHistory" key, so we accept any string-keyed get/set instead.
 */
export interface HistoryPersistence {
	get(key: string): unknown;
	set(key: string, value: unknown): void;
}

interface CreateOptions {
	makeId?: () => string;
	maxEntries: number;
	now?: () => number;
	store: HistoryPersistence;
	storeKey: string;
}

const WORD_RE = /\S+/g;

export function countWords(text: string): number {
	const matches = text.match(WORD_RE);
	return matches ? matches.length : 0;
}

type UnknownRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is UnknownRecord {
	if (typeof value !== "object") {
		return false;
	}
	return value !== null;
}

function hasStringId(v: UnknownRecord): boolean {
	return typeof v.id === "string";
}

function hasNumberTimestamp(v: UnknownRecord): boolean {
	return typeof v.timestamp === "number";
}

function hasStringText(v: UnknownRecord): boolean {
	return typeof v.text === "string";
}

function hasNumberWordCount(v: UnknownRecord): boolean {
	return typeof v.wordCount === "number";
}

function hasNumberDurationMs(v: UnknownRecord): boolean {
	return typeof v.durationMs === "number";
}

// Field predicates iterated by `.every()` so the orchestrator stays CC=2.
// A short-circuit `&&` chain would count one branch per operand under
// strict cyclomatic-complexity rules; the loop is a single branch instead.
const FIELD_PREDICATES: ReadonlyArray<(v: UnknownRecord) => boolean> = [
	hasStringId,
	hasNumberTimestamp,
	hasStringText,
	hasNumberWordCount,
	hasNumberDurationMs,
];

function isEntry(value: unknown): value is TranscriptionHistoryEntry {
	if (!isPlainObject(value)) {
		return false;
	}
	return FIELD_PREDICATES.every((pred) => pred(value));
}

function readPersisted(store: CreateOptions["store"], key: string): TranscriptionHistoryEntry[] {
	const raw = store.get(key);
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.filter(isEntry);
}

export function createTranscriptionHistoryStore(options: CreateOptions): TranscriptionHistoryStore {
	const now = options.now ?? Date.now;
	const makeId = options.makeId ?? (() => globalThis.crypto.randomUUID());
	const maxEntries = Math.max(1, options.maxEntries);
	const entries: TranscriptionHistoryEntry[] = readPersisted(options.store, options.storeKey);

	function persist(): void {
		options.store.set(options.storeKey, entries);
	}

	return {
		record(text, durationMs) {
			const trimmed = text.trim();
			if (trimmed.length === 0) {
				return null;
			}
			const entry: TranscriptionHistoryEntry = {
				id: makeId(),
				timestamp: now(),
				text: trimmed,
				wordCount: countWords(trimmed),
				durationMs: Math.max(0, Math.floor(durationMs)),
			};
			entries.push(entry);
			if (entries.length > maxEntries) {
				entries.splice(0, entries.length - maxEntries);
			}
			persist();
			return entry;
		},
		getHistory() {
			return [...entries];
		},
		clear() {
			entries.splice(0, entries.length);
			persist();
		},
	};
}
