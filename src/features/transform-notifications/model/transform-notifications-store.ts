import { create } from "zustand";

/**
 * Transient in-memory notifications surfaced when a Transform finishes
 * (success or failure). Auto-cleared by a timeout in the consumer, so the
 * store doesn't persist; it just holds one entry at a time — newer events
 * overwrite older ones.
 */
export interface TransformNotification {
	after?: string;
	before?: string;
	createdAt: number;
	id: string;
	kind: "applied" | "failed" | "no-selection";
	reason?: string;
}

interface TransformNotificationState {
	clear: () => void;
	current: TransformNotification | null;
	show: (notification: Omit<TransformNotification, "createdAt" | "id">) => void;
}

let nextId = 0;

export const useTransformNotifications = create<TransformNotificationState>(
	(set) => ({
		current: null,
		show: (n) =>
			set({
				current: {
					...n,
					id: `${Date.now()}-${++nextId}`,
					createdAt: Date.now(),
				},
			}),
		clear: () => set({ current: null }),
	}),
);
