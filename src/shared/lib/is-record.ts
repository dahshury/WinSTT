/**
 * Narrow an `unknown` to an indexable object. Arrays satisfy this (they are
 * `typeof === "object"`), matching the guard the JSON-shape probes around the
 * app rely on — they only ever index string keys off the result.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Stricter {@link isRecord} that EXCLUDES arrays — for callers that then merge
 * the value key-by-key (`Object.keys`) and must not treat an array as a record
 * (e.g. settings-section merge in update-settings/sync-helpers).
 */
export function isPlainRecord(
	value: unknown,
): value is Record<string, unknown> {
	return isRecord(value) && !Array.isArray(value);
}
