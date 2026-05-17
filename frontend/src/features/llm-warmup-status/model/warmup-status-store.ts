import { create } from "zustand";
import type { LlmWarmupStatus } from "@/shared/api/ipc-client";

interface WarmupStatusState {
	clear: () => void;
	setStatus: (status: LlmWarmupStatus | null) => void;
	status: LlmWarmupStatus | null;
}

/**
 * Last known warmup status broadcast from the main process. `null` until
 * the first broadcast arrives; UI uses `null` to mean "no information yet,
 * don't render banners".
 *
 * Driven by the IPC feed in `use-warmup-status-feed.ts` — keep this store
 * passive (no IPC subscriptions in the store itself).
 */
export const useWarmupStatusStore = create<WarmupStatusState>()((set) => ({
	status: null,
	setStatus: (status) => set({ status }),
	clear: () => set({ status: null }),
}));
