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

// ── Optimistic-swap self-heal ───────────────────────────────────────────
//
// `beginSwap` is called OPTIMISTICALLY — either by the initiating window's
// swap controller (a real `reload_*_model` follows) or by `useSyncActiveModel`
// reacting to a `settings.model` change/rollback (which may NOT correspond to a
// real reload). A real swap always emits `model_swap_started` at its start,
// which routes here via `setActive` and CONFIRMS the swap. An optimistic open
// that never gets confirmed within the window is a PHANTOM — the root of the
// user-reported "first click shows a reversed B→A switch that spins forever".
// We auto-clear phantoms so the chip can never strand.
const DEFAULT_OPTIMISTIC_SWAP_STALE_MS = 6000;
let optimisticSwapStaleMs = DEFAULT_OPTIMISTIC_SWAP_STALE_MS;
const selfHealTimers: Record<
	ModelSwapKind,
	ReturnType<typeof setTimeout> | null
> = {
	main: null,
	realtime: null,
};
// `true` once a real `model_swap_started` (`setActive`) confirms the kind's
// in-flight swap. Reset when a fresh optimistic `beginSwap` opens a new one.
const swapConfirmed: Record<ModelSwapKind, boolean> = {
	main: false,
	realtime: false,
};

function cancelSelfHeal(kind: ModelSwapKind): void {
	const timer = selfHealTimers[kind];
	if (timer !== null) {
		clearTimeout(timer);
		selfHealTimers[kind] = null;
	}
}

function activeFor(kind: ModelSwapKind): string | null {
	const s = useModelSwapStore.getState();
	return kind === "main" ? s.activeMain : s.activeRealtime;
}

function scheduleSelfHeal(kind: ModelSwapKind): void {
	cancelSelfHeal(kind);
	selfHealTimers[kind] = setTimeout(() => {
		selfHealTimers[kind] = null;
		// Heal only an STILL-active, STILL-unconfirmed swap — a real one was
		// confirmed by `setActive` (which cancelled this timer) and a completed
		// one already cleared.
		if (!swapConfirmed[kind] && activeFor(kind) !== null) {
			useModelSwapStore.getState().clear(kind);
		}
	}, optimisticSwapStaleMs);
}

export const useModelSwapStore = create<ModelSwapStore>()((set, get) => ({
	activeMain: null,
	activeRealtime: null,
	fromMain: null,
	fromRealtime: null,
	beginSwap: (kind, from, to) => {
		// Race guard: if a REAL swap to this exact target is already confirmed
		// (server's `model_swap_started` landed before this settings-driven
		// optimistic open — the cross-window ordering), update the `from` leg
		// for the arrow but do NOT re-arm the self-heal, which would wrongly
		// clear an in-flight (possibly long-downloading) confirmed swap.
		const alreadyConfirmedSameTarget =
			swapConfirmed[kind] && activeFor(kind) === to;
		set(
			kind === "main"
				? { activeMain: to, fromMain: from }
				: { activeRealtime: to, fromRealtime: from },
		);
		if (!alreadyConfirmedSameTarget) {
			swapConfirmed[kind] = false;
			scheduleSelfHeal(kind);
		}
	},
	setActive: (kind, name) => {
		// A real `model_swap_started` from the server — confirm the swap so the
		// self-heal can't clear it, however long the load/download takes.
		swapConfirmed[kind] = true;
		cancelSelfHeal(kind);
		set(kind === "main" ? { activeMain: name } : { activeRealtime: name });
	},
	clear: (kind) => {
		swapConfirmed[kind] = false;
		cancelSelfHeal(kind);
		set(
			kind === "main"
				? { activeMain: null, fromMain: null }
				: { activeRealtime: null, fromRealtime: null },
		);
	},
	isSwapping: (kind) =>
		kind === "main" ? get().activeMain !== null : get().activeRealtime !== null,
}));

/** Test-only: shrink the self-heal window so phantom-clear is observable
 *  without waiting the production timeout. */
export function _setOptimisticSwapStaleMsForTests(ms: number): void {
	optimisticSwapStaleMs = ms;
}

/** Test-only: cancel pending self-heal timers + reset confirmation flags so a
 *  pending timer from one test can't fire during a sibling (the store is a
 *  process-global singleton under bun:test). */
export function _resetOptimisticSwapForTests(): void {
	cancelSelfHeal("main");
	cancelSelfHeal("realtime");
	swapConfirmed.main = false;
	swapConfirmed.realtime = false;
	optimisticSwapStaleMs = DEFAULT_OPTIMISTIC_SWAP_STALE_MS;
}

/**
 * Subscribe to swap lifecycle pushes. Called once on module load in
 * the reference windows; exported so tests can wire it manually.
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
		if (
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

if (typeof window !== "undefined" && window.nativeBridge != null) {
	initModelSwapStore();
}
