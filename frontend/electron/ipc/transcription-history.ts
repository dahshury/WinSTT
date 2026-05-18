import { isRecord } from "../lib/ipc-helpers";

export interface TranscriptionHistoryEntry {
	durationMs: number;
	id: string;
	/** Pre-LLM text (post-processing applied). Omitted when no LLM ran. */
	originalText?: string;
	/** Final text (after LLM correction if configured). */
	text: string;
	timestamp: number;
	wordCount: number;
}

export interface TranscriptionHistoryStore {
	clear(): void;
	getHistory(): TranscriptionHistoryEntry[];
	/**
	 * Persist a new history entry.
	 *
	 * `originalText` is the pre-LLM text (post-dictionary substitution).
	 * `llmRan` distinguishes "LLM was invoked" (even if it returned the
	 * input unchanged — e.g. a reasoning model exhausting its budget on
	 * thought tokens) from "LLM wasn't invoked at all" (dictation cleanup
	 * disabled). When LLM ran, `originalText` is always preserved so the
	 * history UI can offer "Copy Original" as a deterministic affordance
	 * tied to LLM invocation, not to text-equality.
	 */
	record(
		text: string,
		durationMs: number,
		originalText?: string,
		llmRan?: boolean
	): TranscriptionHistoryEntry | null;
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
	if (!isRecord(value)) {
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
		record(text, durationMs, originalText, llmRan) {
			const trimmed = text.trim();
			if (trimmed.length === 0) {
				return null;
			}
			const trimmedOriginal = originalText?.trim();
			const entry: TranscriptionHistoryEntry = {
				id: makeId(),
				timestamp: now(),
				text: trimmed,
				wordCount: countWords(trimmed),
				durationMs: Math.max(0, Math.floor(durationMs)),
			};
			// "Copy Original" is meaningful whenever the LLM was actually
			// invoked — even when the model returned the input unchanged
			// (e.g. a reasoning model exhausted its budget on thought
			// tokens, or the user picked a preset that happened to be a
			// no-op for this input). Without the `llmRan` signal we'd hide
			// the affordance for any LLM run that didn't strictly transform
			// the text, which the user reads as "the LLM never ran."
			// When LLM didn't run, fall back to the legacy diff gate so
			// dictionary-only entries don't carry a redundant originalText.
			const shouldKeepOriginal = trimmedOriginal
				? llmRan === true || trimmedOriginal !== trimmed
				: false;
			if (trimmedOriginal && shouldKeepOriginal) {
				entry.originalText = trimmedOriginal;
			}
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
