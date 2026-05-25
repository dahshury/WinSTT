type UpdaterStatus = "idle" | "checking" | "available" | "not-available" | "downloaded" | "error";

export interface UpdaterStatusEntryInput {
	message?: string;
	status: UpdaterStatus;
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
 * Build an {@link UpdaterStatusEntry} from an input + timestamp. Lifted to
 * module scope so the conditional spreads (which each add a branch to the
 * cyclomatic counter) don't inflate the `record` method's CRAP score.
 */
function buildEntry(entry: UpdaterStatusEntryInput, timestamp: number): UpdaterStatusEntry {
	return {
		status: entry.status,
		timestamp,
		...(entry.version ? { version: entry.version } : {}),
		...(entry.message ? { message: entry.message } : {}),
	};
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
