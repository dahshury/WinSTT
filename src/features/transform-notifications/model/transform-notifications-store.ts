import {
	createTransientNotificationStore,
	type TransientNotificationMeta,
} from "@/shared/lib/create-transient-notification-store";

/**
 * Transient in-memory notifications surfaced when a Transform finishes
 * (success or failure). Auto-cleared by a timeout in the consumer, so the
 * store doesn't persist; it just holds one entry at a time — newer events
 * overwrite older ones.
 */
export interface TransformNotification extends TransientNotificationMeta {
	after?: string;
	before?: string;
	kind: "applied" | "failed" | "no-selection";
	reason?: string;
}

export const useTransformNotifications =
	createTransientNotificationStore<TransformNotification>();
