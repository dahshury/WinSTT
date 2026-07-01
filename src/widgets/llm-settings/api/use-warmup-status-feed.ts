import { useEffect } from "react";
import { getLlmWarmupStatus, onLlmWarmupStatus } from "@/shared/api/ipc-client";
import { fireAndForget } from "@/shared/lib/fire-and-forget";
import { useWarmupStatusStore } from "../model/warmup-status-store";

/**
 * Subscribe to warmup-status broadcasts from the main process AND pull the
 * last known snapshot on mount (so a freshly opened settings window
 * doesn't need to wait up to 4 minutes for the next interval to fire).
 *
 * Mount this once at the top of any window that wants to surface warmup
 * status — currently the settings window. Idempotent across remounts;
 * the IPC subscriber + store setter are the only side effects.
 */
export function useWarmupStatusFeed(): void {
	const setStatus = useWarmupStatusStore((s) => s.setStatus);

	useEffect(() => {
		fireAndForget(
			getLlmWarmupStatus().then((snapshot) => {
				setStatus(snapshot);
			}),
			"warmupStatusFeed.getLlmWarmupStatus",
		);
		const unsubscribe = onLlmWarmupStatus(setStatus);
		return unsubscribe;
	}, [setStatus]);
}
