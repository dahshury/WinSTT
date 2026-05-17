/**
 * Shared `electron-store` mock for tests.
 *
 * Tests that exercise `electron/lib/store.ts` (or any source that transitively
 * imports it) need a stable in-memory replacement for the `electron-store`
 * library. This shim implements the get/set/delete/has/onDidChange surface
 * with dot-path support, mirroring the real library.
 */

function getByPath(obj: Record<string, unknown>, key: string): unknown {
	if (key in obj) {
		return obj[key];
	}
	const parts = key.split(".");
	let cur: unknown = obj;
	for (const p of parts) {
		if (cur != null && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
			cur = (cur as Record<string, unknown>)[p];
		} else {
			return;
		}
	}
	return cur;
}

function setByPath(obj: Record<string, unknown>, key: string, value: unknown): void {
	const parts = key.split(".");
	if (parts.length === 1) {
		obj[key] = value;
		return;
	}
	let cur: Record<string, unknown> = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const p = parts[i] as string;
		if (cur[p] == null || typeof cur[p] !== "object" || Array.isArray(cur[p])) {
			cur[p] = {};
		}
		cur = cur[p] as Record<string, unknown>;
	}
	cur[parts.at(-1) as string] = value;
}

function deleteByPath(obj: Record<string, unknown>, key: string): void {
	const parts = key.split(".");
	if (parts.length === 1) {
		delete obj[key];
		return;
	}
	let cur: Record<string, unknown> = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const p = parts[i] as string;
		if (cur[p] == null || typeof cur[p] !== "object" || Array.isArray(cur[p])) {
			return;
		}
		cur = cur[p] as Record<string, unknown>;
	}
	delete cur[parts.at(-1) as string];
}

export class MockStore<T extends Record<string, unknown> = Record<string, unknown>> {
	store: Record<string, unknown>;
	private readonly listeners = new Map<string, Array<(value: unknown, prev: unknown) => void>>();

	constructor(opts?: { defaults?: T }) {
		this.store = opts?.defaults ? { ...(opts.defaults as Record<string, unknown>) } : {};
	}

	get(key: string): unknown {
		return getByPath(this.store, key);
	}

	set(key: string, value: unknown): void {
		const prev = getByPath(this.store, key);
		setByPath(this.store, key, value);
		const watchers = this.listeners.get(key) ?? [];
		for (const cb of watchers) {
			cb(value, prev);
		}
	}

	delete(key: string): void {
		deleteByPath(this.store, key);
	}

	has(key: string): boolean {
		return getByPath(this.store, key) !== undefined;
	}

	onDidChange(key: string, cb: (value: unknown, prev: unknown) => void): () => void {
		const list = this.listeners.get(key) ?? [];
		list.push(cb);
		this.listeners.set(key, list);
		return () => {
			this.listeners.set(
				key,
				(this.listeners.get(key) ?? []).filter((x) => x !== cb)
			);
		};
	}
}

export function electronStoreMock() {
	return { default: MockStore };
}
