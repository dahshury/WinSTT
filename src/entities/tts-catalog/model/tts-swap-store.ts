import { create } from "zustand";
import {
	onTtsInstallFailed,
	onTtsInstallStatus,
} from "@/shared/api/ipc-client";

/**
 * In-flight TTS engine swap — the TTS analogue of `useModelSwapStore`, but
 * simpler: TTS keeps a single resident engine (one slot, no main/realtime
 * split). It surfaces the "switching to X" / "FP32 → INT8" indicator on the
 * TTS picker trigger while the backend rebuilds the voice engine after a
 * model / precision change.
 *
 * TTS has no dedicated `model_swap_started/completed` events like STT; instead
 * it emits `tts:install-status` (`phase: "model"` when the rebuild begins,
 * `"ready"` when the engine is warm) and `tts:install-failed`. So this store is
 * opened OPTIMISTICALLY by the settings writer (which knows the from/to) and
 * confirmed / cleared by those lifecycle pushes, with a self-heal timer for the
 * case where no proactive warm runs (keep-warm off → the engine rebuilds lazily
 * on the next read-aloud and no `install-status` ever fires).
 */
export interface TtsSwapTransition {
	fromModelId: string | null;
	toModelId: string;
	/** Raw quant strings (``""`` = default/fp32). Null when the swap keeps the
	 *  precision — the trigger then shows model→model with no quant badge. */
	fromQuant: string | null;
	toQuant: string | null;
}

interface TtsSwapStore {
	active: TtsSwapTransition | null;
	begin: (transition: TtsSwapTransition) => void;
	/** Backend acknowledged the rebuild started (`install-status: "model"`);
	 *  cancels the self-heal so a long download/warm can't strand the chip. */
	confirm: () => void;
	clear: () => void;
}

const DEFAULT_TTS_SWAP_STALE_MS = 10_000;
let staleMs = DEFAULT_TTS_SWAP_STALE_MS;
let selfHealTimer: ReturnType<typeof setTimeout> | null = null;
// `true` once the backend confirms the rebuild started — a confirmed swap must
// never be self-healed away, however long the download/warm takes.
let confirmed = false;

function cancelSelfHeal(): void {
	if (selfHealTimer !== null) {
		clearTimeout(selfHealTimer);
		selfHealTimer = null;
	}
}

function scheduleSelfHeal(): void {
	cancelSelfHeal();
	selfHealTimer = setTimeout(() => {
		selfHealTimer = null;
		if (!confirmed && useTtsSwapStore.getState().active !== null) {
			useTtsSwapStore.getState().clear();
		}
	}, staleMs);
}

export const useTtsSwapStore = create<TtsSwapStore>()((set) => ({
	active: null,
	begin: (transition) => {
		confirmed = false;
		set({ active: transition });
		scheduleSelfHeal();
	},
	confirm: () => {
		confirmed = true;
		cancelSelfHeal();
	},
	clear: () => {
		confirmed = false;
		cancelSelfHeal();
		set({ active: null });
	},
}));

/** Test-only: shrink the self-heal window so the phantom-clear branch is
 *  observable without waiting the production timeout. */
export function _setTtsSwapStaleMsForTests(ms: number): void {
	staleMs = ms;
}

/** Test-only: cancel the pending timer + reset the confirmation flag so a
 *  leaked timer from one test can't fire during a sibling (the store is a
 *  process-global singleton under bun:test). */
export function _resetTtsSwapForTests(): void {
	cancelSelfHeal();
	confirmed = false;
	staleMs = DEFAULT_TTS_SWAP_STALE_MS;
}

/**
 * Subscribe to the TTS install lifecycle so an optimistic swap resolves on the
 * backend's own signals. `phase: "model"` confirms the rebuild is under way;
 * `"ready"` (engine warm) and any failure clear it. Only reacts while a swap is
 * actually open — these events also fire for unrelated first-time installs.
 */
export function initTtsSwapStore(): () => void {
	const unsubStatus = onTtsInstallStatus(({ phase }) => {
		if (useTtsSwapStore.getState().active === null) {
			return;
		}
		if (phase === "model" || phase === "engine") {
			useTtsSwapStore.getState().confirm();
		} else if (phase === "ready") {
			useTtsSwapStore.getState().clear();
		}
	});
	const unsubFailed = onTtsInstallFailed(() => {
		if (useTtsSwapStore.getState().active !== null) {
			useTtsSwapStore.getState().clear();
		}
	});
	return () => {
		unsubStatus();
		unsubFailed();
	};
}

if (typeof window !== "undefined" && window.nativeBridge != null) {
	initTtsSwapStore();
}
