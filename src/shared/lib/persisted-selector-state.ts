export function readPersistedSelectorState<T>(
	storageKey: string,
	isValue: (value: unknown) => value is T,
	fallback: T,
): T {
	if (typeof window === "undefined") {
		return fallback;
	}
	try {
		const raw = window.localStorage.getItem(storageKey);
		if (!raw) {
			return fallback;
		}
		const parsed: unknown = JSON.parse(raw);
		return isValue(parsed) ? parsed : fallback;
	} catch {
		return fallback;
	}
}

/** Persist `value` under `storageKey`. Returns `true` when the write actually
 *  reached localStorage, `false` when it was skipped (no `window`) or threw
 *  (quota exceeded, serialization error, storage disabled). Callers that must
 *  not falsely claim success — e.g. "saved" UI — inspect the result instead of
 *  assuming the write landed. Loose selector state can still ignore it. */
export function writePersistedSelectorState(
	storageKey: string,
	value: unknown,
): boolean {
	if (typeof window === "undefined") {
		return false;
	}
	try {
		window.localStorage.setItem(storageKey, JSON.stringify(value));
		return true;
	} catch {
		// Storage failure — the in-memory value is still usable this session, but
		// the caller is told the write did not persist so it can surface it.
		return false;
	}
}

export function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}
