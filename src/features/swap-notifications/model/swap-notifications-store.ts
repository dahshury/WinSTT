import type {
	ModelSwapFailedCategory,
	ModelSwapKind,
} from "@/shared/api/ipc-client";
import {
	createTransientNotificationStore,
	type TransientNotificationMeta,
} from "@/shared/lib/create-transient-notification-store";

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
interface SwapFailureNotification extends TransientNotificationMeta {
	category: ModelSwapFailedCategory;
	detail: string;
	kind: ModelSwapKind;
	modelName: string;
	reason: string;
}

export const useSwapNotifications =
	createTransientNotificationStore<SwapFailureNotification>();
