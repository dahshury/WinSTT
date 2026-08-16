import { create } from "zustand";
import {
	type ModeTransitionPayload,
	onRecordingModeTransition,
	recordingModeTransitionState,
} from "@/shared/api/ipc-client";
import { hasNativeRuntime } from "@/shared/api/native-boundary";

/**
 * Process-wide phase of the recording-mode switch, mirrored from the backend's
 * `recording:mode-transition` event.
 *
 * Switching modes is not free: the shared STT engine holds exactly one model, so
 * crossing into or out of Listen swaps which one that is, and entering Wake Word
 * builds a KWS session. Until that finishes the newly-selected mode cannot
 * transcribe a thing — which is what made listen mode look dead for the first
 * few seconds after the switch. The backend now reports that window explicitly
 * and this store is the single renderer-side answer to "is the mode control
 * live right now?", shared by the settings switcher, the tray menu, and the
 * PTT+ArrowUp cycle gesture (a mode change can originate from any of them, in
 * any window).
 *
 * Free switches (ptt ↔ toggle) still emit, but go straight to `ready`, so no
 * consumer needs to special-case them.
 */
interface ModeTransitionStore {
	/** Latest phase snapshot. `idle` until the first mode change of the session. */
	transition: ModeTransitionPayload;
	/** True while the committed mode cannot transcribe yet. */
	isPreparing: boolean;
	apply: (payload: ModeTransitionPayload) => void;
}

const IDLE: ModeTransitionPayload = {
	error: null,
	from: "ptt",
	generation: 0,
	phase: "idle",
	to: "ptt",
};

export const useModeTransitionStore = create<ModeTransitionStore>()((set) => ({
	transition: IDLE,
	isPreparing: false,
	apply: (payload) => {
		set((state) => {
			// Events and the pull command race on mount; generation is monotonic, so
			// an older snapshot never overwrites a newer phase. `>=` (not `>`) keeps
			// a settle for the CURRENT generation, which shares its number.
			if (payload.generation < state.transition.generation) {
				return state;
			}
			return {
				transition: payload,
				isPreparing: payload.phase === "preparing",
			};
		});
	},
}));

/**
 * Subscribe to the backend phase and pull the current one for a window that
 * mounted mid-switch. Mount once per window (`IpcProvider`) — the store is
 * module-global, so a second subscription would just duplicate work.
 */
export function initModeTransitionStore(): () => void {
	const unsubscribe = onRecordingModeTransition((payload) => {
		useModeTransitionStore.getState().apply(payload);
	});
	void recordingModeTransitionState().then((payload) => {
		useModeTransitionStore.getState().apply(payload);
	});
	return unsubscribe;
}

if (hasNativeRuntime()) {
	initModeTransitionStore();
}
