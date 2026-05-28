import { create } from "zustand";
import {
	type ModelSwapKind,
	onModelSwapCompleted,
	onModelSwapFailed,
	onModelSwapStarted,
	onRuntimeInfo,
} from "@/shared/api/ipc-client";
import { markSwapFailed } from "@/shared/lib/swap-failure-timing";

/**
 * Tracks in-flight `sttReloadModel` swaps per kind. The server emits
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
interface ModelSwapStore {
	activeMain: string | null;
	activeRealtime: string | null;
	beginSwap: (kind: ModelSwapKind, from: string, to: string) => void;
	clear: (kind: ModelSwapKind) => void;
	// Previous model id captured at the moment the swap is initiated. Surfaces
	// the "from" leg of the transition in the picker trigger (and anywhere
	// else that wants to render `from → to`). Stays null when the server
	// initiates a swap on its own (cold load) — UI degrades to a "to-only"
	// indicator in that case.
	fromMain: string | null;
	fromRealtime: string | null;
	isSwapping: (kind: ModelSwapKind) => boolean;
	setActive: (kind: ModelSwapKind, name: string) => void;
}

export const useModelSwapStore = create<ModelSwapStore>()((set, get) => ({
	activeMain: null,
	activeRealtime: null,
	fromMain: null,
	fromRealtime: null,
	beginSwap: (kind, from, to) => {
		set(
			kind === "main"
				? { activeMain: to, fromMain: from }
				: { activeRealtime: to, fromRealtime: from }
		);
	},
	setActive: (kind, name) => {
		set(kind === "main" ? { activeMain: name } : { activeRealtime: name });
	},
	clear: (kind) => {
		set(
			kind === "main"
				? { activeMain: null, fromMain: null }
				: { activeRealtime: null, fromRealtime: null }
		);
	},
	isSwapping: (kind) =>
		kind === "main" ? get().activeMain !== null : get().activeRealtime !== null,
}));

/**
 * Subscribe to swap lifecycle pushes. Called once on module load in
 * Electron windows; exported so tests can wire it manually.
 */
export function initModelSwapStore(): () => void {
	const unsubStarted = onModelSwapStarted(({ kind, name }) => {
		useModelSwapStore.getState().setActive(kind, name);
	});
	const unsubCompleted = onModelSwapCompleted(({ kind }) => {
		useModelSwapStore.getState().clear(kind);
	});
	const unsubFailed = onModelSwapFailed(({ kind }) => {
		// Stamp the failure BEFORE clearing so ``useSyncActiveModel`` can tell
		// the imminent rollback (settings reverting to the previous model)
		// apart from a real user pick — otherwise it opens a reversed, never-
		// completing "swap to the already-loaded model". See
		// `shared/lib/swap-failure-timing.ts`.
		markSwapFailed();
		useModelSwapStore.getState().clear(kind);
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
		if (state.activeMain !== null && info.model === state.activeMain) {
			state.clear("main");
		}
		if (state.activeRealtime !== null && info.realtime_model === state.activeRealtime) {
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

if (typeof window !== "undefined" && window.electronAPI != null) {
	initModelSwapStore();
}
