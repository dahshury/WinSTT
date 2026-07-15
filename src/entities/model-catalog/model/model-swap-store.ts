import { create } from "zustand";
import {
	type ModelSwapKind,
	onModelSwapCompleted,
	onModelSwapFailed,
	onModelSwapStarted,
	onRuntimeInfo,
} from "@/shared/api/ipc-client";
import { hasNativeRuntime } from "@/shared/api/native-boundary";
import { markSwapFailed } from "@/shared/lib/swap-failure-timing";

/**
 * Tracks correlated backend-owned model transactions per kind. The server emits
 * `model_swap_started` when it begins loading new weights and either
 * `model_swap_completed` or `model_swap_failed` when it's done — during
 * that window the WebSocket / control-plane briefly stalls, so the UI
 * needs to tell the user a switch is in progress rather than letting the
 * app look frozen.
 *
 * Consumed by:
 *   - `StatusBar` — flips the model chip into a spinner + "Switching to
 *     {name}..." label while `activeMain` is set.
 *   - `ModelSettingsPanel` — passes `isLoading` to the relevant
 *     `SttModelSelector` so the picker is disabled until the swap
 *     resolves.
 */
/** The precision leg of a swap. Both are raw ``onnxQuantization`` strings
 *  (``""`` = default/fp32, ``"int8"``, ``"q4"``, …) — the trigger formats them
 *  for display. Present only for a swap that actually changes the precision;
 *  ``null`` on a pure model switch that carries the precision unchanged. */
export interface SwapQuant {
	from: string;
	to: string;
}

interface ModelSwapStore {
	activeMain: string | null;
	activeRealtime: string | null;
	requestMain: string | null;
	requestRealtime: string | null;
	beginSwap: (
		kind: ModelSwapKind,
		from: string,
		to: string,
		quant?: SwapQuant | null,
		requestId?: string | null,
	) => void;
	clear: (kind: ModelSwapKind, requestId?: string) => void;
	// Previous model id captured at the moment the swap is initiated. Surfaces
	// the "from" leg of the transition in the picker trigger (and anywhere
	// else that wants to render `from → to`). Stays null when the server
	// initiates a swap on its own (cold load) — UI degrades to a "to-only"
	// indicator in that case.
	fromMain: string | null;
	fromRealtime: string | null;
	// Precision transition for the in-flight swap, captured at `beginSwap`.
	// Lets the trigger render "FP32 → INT8" for a quant change — including a
	// PURE quant swap (same model, from === to) where the model→model row is
	// otherwise redundant. Null when the swap doesn't change precision.
	quantMain: SwapQuant | null;
	quantRealtime: SwapQuant | null;
	isSwapping: (kind: ModelSwapKind) => boolean;
	setActive: (kind: ModelSwapKind, name: string, requestId?: string) => void;
}

export const useModelSwapStore = create<ModelSwapStore>()((set, get) => ({
	activeMain: null,
	activeRealtime: null,
	requestMain: null,
	requestRealtime: null,
	fromMain: null,
	fromRealtime: null,
	quantMain: null,
	quantRealtime: null,
	beginSwap: (kind, from, to, quant = null, requestId = null) => {
		set(
			kind === "main"
				? {
						activeMain: to,
						fromMain: from,
						quantMain: quant,
						requestMain: requestId,
					}
				: {
						activeRealtime: to,
						fromRealtime: from,
						quantRealtime: quant,
						requestRealtime: requestId,
					},
		);
	},
	setActive: (kind, name, requestId) => {
		const activeRequest =
			kind === "main" ? get().requestMain : get().requestRealtime;
		if (
			requestId !== undefined &&
			activeRequest !== null &&
			activeRequest !== requestId
		) {
			return;
		}
		set(
			kind === "main"
				? { activeMain: name, requestMain: requestId ?? get().requestMain }
				: {
						activeRealtime: name,
						requestRealtime: requestId ?? get().requestRealtime,
					},
		);
	},
	clear: (kind, requestId) => {
		const activeRequest =
			kind === "main" ? get().requestMain : get().requestRealtime;
		if (requestId !== undefined && activeRequest !== requestId) {
			return;
		}
		set(
			kind === "main"
				? {
						activeMain: null,
						fromMain: null,
						quantMain: null,
						requestMain: null,
					}
				: {
						activeRealtime: null,
						fromRealtime: null,
						quantRealtime: null,
						requestRealtime: null,
					},
		);
	},
	isSwapping: (kind) =>
		kind === "main" ? get().activeMain !== null : get().activeRealtime !== null,
}));

/**
 * Subscribe to swap lifecycle pushes. Called once on module load in
 * the reference windows; exported so tests can wire it manually.
 */
export function initModelSwapStore(): () => void {
	const unsubStarted = onModelSwapStarted(({ kind, name, requestId }) => {
		useModelSwapStore.getState().setActive(kind, name, requestId);
	});
	const unsubCompleted = onModelSwapCompleted(({ kind, requestId }) => {
		useModelSwapStore.getState().clear(kind, requestId);
	});
	const unsubFailed = onModelSwapFailed(({ kind, requestId }) => {
		const state = useModelSwapStore.getState();
		const activeRequest =
			kind === "main" ? state.requestMain : state.requestRealtime;
		if (requestId !== undefined && activeRequest !== requestId) {
			return;
		}
		// Stamp the failure BEFORE clearing so ``useSyncActiveModel`` can tell
		// the imminent rollback (settings reverting to the previous model)
		// apart from a real user pick — otherwise it opens a reversed, never-
		// completing "swap to the already-loaded model". See
		// `shared/lib/swap-failure-timing.ts`.
		markSwapFailed();
		state.clear(kind, requestId);
	});
	// Restart-based swaps (STARTUP_ONLY key changes like
	// `model.onnxQuantization`) don't emit `model_swap_completed`: the
	// server tears down, respawns with the new args, and announces itself
	// via `server_ready` + `runtime_info` instead. So when an in-flight
	// swap's target matches the freshly-reported runtime model, treat it
	// as completed and drop the spinner. The hot-swap path also emits
	// `runtime_info` (callbacks.py pushes it before `model_swap_completed`
	// per the load-bearing emission order), so this branch fires
	// idempotently next to the dedicated handlers — no harm.
	const unsubRuntime = onRuntimeInfo((info) => {
		if (info === null) {
			return;
		}
		const state = useModelSwapStore.getState();
		if (
			state.requestMain === null &&
			state.activeMain !== null &&
			info.model === state.activeMain
		) {
			state.clear("main");
		}
		if (
			state.requestRealtime === null &&
			state.activeRealtime !== null &&
			info.realtime_model === state.activeRealtime
		) {
			state.clear("realtime");
		}
	});
	return () => {
		unsubStarted();
		unsubCompleted();
		unsubFailed();
		unsubRuntime();
	};
}

if (hasNativeRuntime()) {
	initModelSwapStore();
}
