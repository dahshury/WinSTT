import { create } from "zustand";
import type { ModelSwapFailedCategory, ModelSwapKind } from "@/shared/api/ipc-client";

/**
 * Transient in-memory notification for a model-swap failure (and only
 * for failures — success is already conveyed by the StatusBar chip
 * flipping out of its "Switching to {name}..." state).
 *
 * Mirrors the shape of ``transform-notifications-store``: at most one
 * entry at a time, newer events overwrite older ones, consumer is
 * responsible for auto-clearing on a timer. The store stays out of the
 * model-swap-store (which only tracks in-flight state) so the toast can
 * persist for its 5-second display after the swap has resolved.
 */
export interface SwapFailureNotification {
	category: ModelSwapFailedCategory;
	createdAt: number;
	detail: string;
	id: string;
	kind: ModelSwapKind;
	modelName: string;
	reason: string;
}

interface SwapNotificationState {
	clear: () => void;
	current: SwapFailureNotification | null;
	show: (notification: Omit<SwapFailureNotification, "createdAt" | "id">) => void;
}

let nextId = 0;

export const useSwapNotifications = create<SwapNotificationState>((set) => ({
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
}));
