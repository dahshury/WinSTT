import { create } from "zustand";
import {
	fetchModelsWithState,
	type ModelStateEntry,
	onModelCacheChanged,
	onModelSwapCompleted,
	type SystemInfoEntry,
} from "@/shared/api/ipc-client";

/**
 * Per-model cache + fitness state from the server, keyed by model id.
 *
 * Backs the model picker's badges: "Downloaded" / "47%" / "Not downloaded"
 * + the ⚠ icon when the chosen model is too big for the user's hardware.
 *
 * Refreshed on settings-panel mount via ``fetchModelsWithState``; live
 * updates come through ``stt:model-cache-changed`` (push) and
 * ``stt:model-swap-completed`` (push) so badges flip without polling
 * after a download finishes.
 */
interface ModelStateStore {
	getState: (id: string) => ModelStateEntry | undefined;
	isLoaded: boolean;
	refresh: () => Promise<void>;
	setAll: (entries: ModelStateEntry[], systemInfo: SystemInfoEntry) => void;
	statesById: Record<string, ModelStateEntry>;
	systemInfo: SystemInfoEntry | null;
}

function toMap(entries: ModelStateEntry[]): Record<string, ModelStateEntry> {
	const out: Record<string, ModelStateEntry> = {};
	for (const e of entries) {
		out[e.id] = e;
	}
	return out;
}

// In-flight refresh promise. Multiple callers (settings panel mount,
// model-picker window mount, push events from `onModelCacheChanged` /
// `onModelSwapCompleted`) used to fire parallel IPC round-trips that all
// queued behind the same blocked control-channel handler and timed out
// together. Sharing a single pending promise collapses bursts into one
// request without changing the contract — every caller still awaits a
// fresh result.
let pendingRefresh: Promise<void> | null = null;

export const useModelStateStore = create<ModelStateStore>()((set, get) => ({
	statesById: {},
	systemInfo: null,
	isLoaded: false,
	setAll: (entries, systemInfo) => set({ statesById: toMap(entries), systemInfo, isLoaded: true }),
	refresh: () => {
		if (pendingRefresh) {
			return pendingRefresh;
		}
		const run = async () => {
			const payload = await fetchModelsWithState();
			if (payload && Array.isArray(payload.states)) {
				set({
					statesById: toMap(payload.states),
					systemInfo: payload.system_info,
					isLoaded: true,
				});
			}
		};
		pendingRefresh = run().finally(() => {
			pendingRefresh = null;
		});
		return pendingRefresh;
	},
	getState: (id) => get().statesById[id],
}));

/**
 * Subscribe to push invalidations. Called once on module load alongside
 * the catalog-store init; safe to call again from tests.
 */
export function initModelStateStore(): () => void {
	const unsubCache = onModelCacheChanged(() => {
		// A model just finished downloading — re-fetch the full state map
		// rather than trying to patch a single entry, because finishing
		// the download also moves fitness from "estimated" to "verified"
		// (we may include disk-size totals in the future, etc.).
		useModelStateStore.getState().refresh();
	});
	const unsubSwap = onModelSwapCompleted(() => {
		// A swap completing implies the new model is cached.
		useModelStateStore.getState().refresh();
	});
	return () => {
		unsubCache();
		unsubSwap();
	};
}

if (typeof window !== "undefined" && window.electronAPI != null) {
	useModelStateStore.getState().refresh();
	initModelStateStore();
}
