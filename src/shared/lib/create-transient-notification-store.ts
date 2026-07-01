import { create } from "zustand";

/**
 * Stamped fields the factory adds to every notification on `show`. Concrete
 * notification types extend this so consumers can read `id` / `createdAt`.
 */
export interface TransientNotificationMeta {
	createdAt: number;
	id: string;
}

/**
 * Public surface of a single-slot transient-notification store: holds at most
 * one entry (`current`), newer `show` calls overwrite older ones, and the
 * consumer is responsible for auto-clearing on a timer via `clear`.
 */
export interface TransientNotificationState<
	T extends TransientNotificationMeta,
> {
	clear: () => void;
	current: T | null;
	show: (notification: Omit<T, "createdAt" | "id">) => void;
}

/**
 * Builds a zustand store for a transient, single-slot toast notification.
 *
 * The swap- and transform-notification stores were byte-identical aside from
 * the entry type `T`, so this factory captures the shared shape: a per-store
 * monotonic counter stamps each `show` with an `id` (`${Date.now()}-${++n}`)
 * and a `createdAt` timestamp, `show` overwrites `current`, and `clear` resets
 * it to `null`.
 */
export function createTransientNotificationStore<
	T extends TransientNotificationMeta,
>() {
	let nextId = 0;
	return create<TransientNotificationState<T>>((set) => ({
		current: null,
		show: (n) =>
			set({
				current: {
					...n,
					id: `${Date.now()}-${++nextId}`,
					createdAt: Date.now(),
				} as T,
			}),
		clear: () => set({ current: null }),
	}));
}
