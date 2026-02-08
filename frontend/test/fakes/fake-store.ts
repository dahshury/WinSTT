export function createFakeStore<T extends Record<string, unknown>>(defaults: T) {
	const store = new Map<string, unknown>(Object.entries(defaults));

	return {
		get<K extends keyof T>(key: K): T[K] {
			return store.get(key as string) as T[K];
		},
		set<K extends keyof T>(key: K, value: T[K]) {
			store.set(key as string, value);
		},
		delete(key: keyof T) {
			store.delete(key as string);
		},
		clear() {
			store.clear();
		},
		has(key: keyof T) {
			return store.has(key as string);
		},
		get store() {
			return Object.fromEntries(store) as T;
		},
	};
}
