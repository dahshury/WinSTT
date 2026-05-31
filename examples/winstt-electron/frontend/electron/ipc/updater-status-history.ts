type UpdaterStatus =
	| "idle"
	| "checking"
	| "available"
	| "downloading"
	| "not-available"
	| "downloaded"
	| "error";

export interface UpdaterStatusEntryInput {
	/** Only present when status === "downloading". From electron-updater's
	 *  `download-progress` payload — all four fields are numeric and exposed
	 *  unmodified so the renderer can format them however suits the UI. */
	bytesPerSecond?: number;
	message?: string;
	percent?: number;
	status: UpdaterStatus;
	total?: number;
	transferred?: number;
	version?: string;
}

export interface UpdaterStatusEntry extends UpdaterStatusEntryInput {
	timestamp: number;
}

interface UpdaterStatusHistoryOptions {
	maxEntries: number;
	now?: () => number;
}

export interface UpdaterStatusHistory {
	clear(): void;
	getHistory(): UpdaterStatusEntry[];
	record(entry: UpdaterStatusEntryInput): UpdaterStatusEntry;
}

/**
 * Optional fields stripped via `assignDefined` so `buildEntry` stays
 * branch-free (CRAP gate is strict about cyclomatic complexity). `number`
 * keys honor 0 (the first download-progress tick); string keys drop empties.
 */
const OPTIONAL_NUMBER_KEYS = ["percent", "transferred", "total", "bytesPerSecond"] as const;
const OPTIONAL_STRING_KEYS = ["version", "message"] as const;

function copyDefinedNumbers(target: UpdaterStatusEntry, source: UpdaterStatusEntryInput): void {
	for (const key of OPTIONAL_NUMBER_KEYS) {
		const value = source[key];
		if (typeof value === "number") {
			target[key] = value;
		}
	}
}

function copyDefinedStrings(target: UpdaterStatusEntry, source: UpdaterStatusEntryInput): void {
	for (const key of OPTIONAL_STRING_KEYS) {
		const value = source[key];
		if (value) {
			target[key] = value;
		}
	}
}

function buildEntry(entry: UpdaterStatusEntryInput, timestamp: number): UpdaterStatusEntry {
	const result: UpdaterStatusEntry = { status: entry.status, timestamp };
	copyDefinedNumbers(result, entry);
	copyDefinedStrings(result, entry);
	return result;
}

export function createUpdaterStatusHistory(
	options: UpdaterStatusHistoryOptions
): UpdaterStatusHistory {
	const now = options.now ?? Date.now;
	const maxEntries = Math.max(1, options.maxEntries);
	const entries: UpdaterStatusEntry[] = [];

	return {
		record(entry) {
			const value = buildEntry(entry, now());
			entries.push(value);

			// Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — both `if (true)` and `>=` only deviate when entries.length <= maxEntries, but in those cases `entries.length - maxEntries` is non-positive and `splice(0, n<=0)` is a no-op
			if (entries.length > maxEntries) {
				entries.splice(0, entries.length - maxEntries);
			}
			return value;
		},
		getHistory() {
			return [...entries];
		},
		clear() {
			entries.splice(0, entries.length);
		},
	};
}
