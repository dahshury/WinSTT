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
let unsubscribeModelStateEvents: (() => void) | null = null;

// Retry-on-failure schedule, kept as belt-and-suspenders. ``list_models_with_state``
// is now a ``pre_ready`` server command (it reads only the catalog + local HF-cache
// probe + system info, none of which needs the loaded recorder), so the FIRST call
// after launch is answered immediately even while the model is still loading — which
// is what previously blew past the renderer's 10s timeout (model load can take >10s,
// e.g. CrisperWhisper on DirectML ≈ 13.6s, and non-pre_ready commands were silently
// dropped until ready). The retry remains for the genuine slow/transient cases (a
// momentarily-saturated control channel, a dropped first frame): without it,
// ``refresh()`` returned ``null`` once and gave up — leaving the picker showing NO
// cached models until a ``model_cache_changed`` / ``model_swap_completed`` push
// happened to re-trigger it. These capped-backoff delays keep retrying until the
// server answers (≈39s of coverage), then stop on the first success. Push events
// reset the counter so a later refresh gets a fresh budget.
let RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000, 8000, 8000, 8000];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

function cancelRetry(): void {
	if (retryTimer !== null) {
		clearTimeout(retryTimer);
		retryTimer = null;
	}
}

function scheduleRetry(): void {
	// One pending retry at a time; give up once the backoff schedule is
	// exhausted (push events / a later mount can still start a fresh cycle).
	if (retryTimer !== null || retryAttempt >= RETRY_DELAYS_MS.length) {
		return;
	}
	const delay = RETRY_DELAYS_MS[retryAttempt] ?? RETRY_DELAYS_MS.at(-1) ?? 8000;
	retryAttempt += 1;
	retryTimer = setTimeout(() => {
		retryTimer = null;
		useModelStateStore.getState().refresh();
	}, delay);
}

export const useModelStateStore = create<ModelStateStore>()((set, get) => ({
	statesById: {},
	systemInfo: null,
	isLoaded: false,
	setAll: (entries, systemInfo) => set({ statesById: toMap(entries), systemInfo, isLoaded: true }),
	refresh: () => {
		if (pendingRefresh) {
			return pendingRefresh;
		}
		if (typeof window !== "undefined" && window.nativeBridge != null) {
			initModelStateStore();
		}
		const run = async () => {
			const payload = await fetchModelsWithState();
			if (payload && Array.isArray(payload.states)) {
				set({
					statesById: toMap(payload.states),
					systemInfo: payload.system_info,
					isLoaded: true,
				});
				// Success — stop the retry cycle.
				cancelRetry();
				retryAttempt = 0;
				return;
			}
			// Timed out / malformed — schedule a backed-off retry so the
			// picker self-populates without needing a model switch.
			scheduleRetry();
		};
		pendingRefresh = run().finally(() => {
			pendingRefresh = null;
		});
		return pendingRefresh;
	},
	getState: (id) => get().statesById[id],
}));

/** Reset the retry cycle so a fresh trigger (cache-changed / swap) gets the
 *  full backoff budget again. */
function resetRetryCycle(): void {
	cancelRetry();
	retryAttempt = 0;
}

/** Test-only: cancel any pending retry timer + reset the attempt counter so a
 *  leaked timer from one test can't fire during a sibling. */
export function _resetModelStateRetryForTests(): void {
	resetRetryCycle();
	unsubscribeModelStateEvents?.();
	unsubscribeModelStateEvents = null;
	RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 8000, 8000, 8000];
}

/** Test-only: shrink the retry backoff so retry behavior is observable
 *  without waiting the production delays. */
export function _setModelStateRetryDelaysForTests(delays: readonly number[]): void {
	RETRY_DELAYS_MS = delays;
	retryAttempt = 0;
}

/**
 * Subscribe to push invalidations. Initialized lazily by refresh() or surfaces
 * that render model cache state; safe to call again from tests.
 */
export function initModelStateStore(): () => void {
	if (unsubscribeModelStateEvents) {
		return unsubscribeModelStateEvents;
	}
	const unsubCache = onModelCacheChanged(() => {
		// A model just finished downloading — re-fetch the full state map
		// rather than trying to patch a single entry, because finishing
		// the download also moves fitness from "estimated" to "verified"
		// (we may include disk-size totals in the future, etc.). Fresh
		// trigger → reset the retry budget so it can ride out a slow server.
		resetRetryCycle();
		useModelStateStore.getState().refresh();
	});
	const unsubSwap = onModelSwapCompleted(() => {
		// A swap completing implies the new model is cached.
		resetRetryCycle();
		useModelStateStore.getState().refresh();
	});
	const unsubscribe = () => {
		unsubCache();
		unsubSwap();
		if (unsubscribeModelStateEvents === unsubscribe) {
			unsubscribeModelStateEvents = null;
		}
	};
	unsubscribeModelStateEvents = unsubscribe;
	return unsubscribe;
}
