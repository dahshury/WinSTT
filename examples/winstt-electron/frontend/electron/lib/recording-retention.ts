/**
 * Pure resolvers for the history recordings retention settings.
 *
 * Both the retention period and the history limit are read from a NEW settings
 * key with fallback to a LEGACY key, then validated. Extracted from main.ts's
 * inline `getRetention`/`getLimit` IPC closures so the (branchy) validation is
 * unit-testable and main.ts stays thin.
 */

import type { RecordingRetentionPeriod } from "../ipc/history-store";

const RETENTION_PERIODS: ReadonlySet<RecordingRetentionPeriod> = new Set([
	"never",
	"preserveLimit",
	"cap",
	"days3",
	"weeks2",
	"months3",
]);

const DEFAULT_RETENTION: RecordingRetentionPeriod = "preserveLimit";
const DEFAULT_LIMIT = 5;

/**
 * Resolve the retention period: prefer the new key when it is a string, fall
 * back to the legacy key, then validate against the known set. Anything
 * unrecognized (including non-strings) resolves to `preserveLimit`.
 */
export function resolveRetentionPeriod(
	rawNew: unknown,
	rawLegacy: unknown
): RecordingRetentionPeriod {
	const candidate = typeof rawNew === "string" ? rawNew : rawLegacy;
	return typeof candidate === "string" &&
		RETENTION_PERIODS.has(candidate as RecordingRetentionPeriod)
		? (candidate as RecordingRetentionPeriod)
		: DEFAULT_RETENTION;
}

/**
 * Resolve the history limit: first positive finite value among the new key then
 * the legacy key wins (floored); otherwise the default of 5.
 */
export function resolveHistoryLimit(rawNew: unknown, rawLegacy: unknown): number {
	const fromNew = Number(rawNew);
	if (Number.isFinite(fromNew) && fromNew > 0) {
		return Math.floor(fromNew);
	}
	const legacy = Number(rawLegacy);
	if (Number.isFinite(legacy) && legacy > 0) {
		return Math.floor(legacy);
	}
	return DEFAULT_LIMIT;
}
