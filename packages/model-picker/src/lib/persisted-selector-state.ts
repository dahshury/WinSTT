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

export function writePersistedSelectorState(
	storageKey: string,
	value: unknown,
): void {
	if (typeof window === "undefined") {
		return;
	}
	try {
		window.localStorage.setItem(storageKey, JSON.stringify(value));
	} catch {
		// Ignore storage failures; selector state should remain usable in-memory.
	}
}

export function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}
