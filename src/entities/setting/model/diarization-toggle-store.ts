import { create } from "zustand";
import {
	type DiarizationToggleFailedPayload,
	onDiarizationToggleCompleted,
	onDiarizationToggleFailed,
	onDiarizationToggleStarted,
} from "@/shared/api/ipc-client";
import { useSettingsStore } from "./settings-store";

/**
 * Tracks the in-flight runtime diarization toggle. The server pushes
 * `diarization_toggle_started` when it begins building/warming (or tearing
 * down) the diarizer and `diarization_toggle_completed` / `_failed` when
 * done. Activation downloads ~32 MB + JIT-loads ORT sessions, so the UI
 * must show a spinner and lock the toggle for that window.
 *
 * Consumed by `SpeakerDiarizationControl` (settings window — its own
 * BrowserWindow, so this is driven purely off broadcast IPC, not the
 * connection store which is dead there).
 */
interface DiarizationToggleStore {
	begin: () => void;
	fail: (info: DiarizationToggleFailedPayload) => void;
	finish: () => void;
	/** Last failure (cleared on the next start), for an inline error hint. */
	lastError: DiarizationToggleFailedPayload | null;
	/** True from `started` until `completed`/`failed`. */
	pending: boolean;
}

export const useDiarizationToggleStore = create<DiarizationToggleStore>()((set) => ({
	pending: false,
	lastError: null,
	begin: () => set({ pending: true, lastError: null }),
	finish: () => set({ pending: false }),
	fail: (info) => set({ pending: false, lastError: info }),
}));

/**
 * Subscribe to diarization-toggle lifecycle pushes. Called once on module
 * load in the reference windows; exported so tests can wire it manually.
 */
export function initDiarizationToggleStore(): () => void {
	const unsubStarted = onDiarizationToggleStarted(() => {
		useDiarizationToggleStore.getState().begin();
	});
	const unsubCompleted = onDiarizationToggleCompleted(() => {
		useDiarizationToggleStore.getState().finish();
	});
	const unsubFailed = onDiarizationToggleFailed((info) => {
		useDiarizationToggleStore.getState().fail(info);
		// On activation failure (e.g. offline first-run download, OOM) the
		// server stayed in its previous state — revert the optimistic
		// toggle in the settings store so the UI doesn't claim diarization
		// is on when it isn't. Performed here (where the failure surfaces)
		// rather than in a component effect so the source of truth lives
		// alongside the IPC listener that owns the lifecycle.
		const settings = useSettingsStore.getState();
		const current = settings.settings.general?.speakerDiarization ?? false;
		if (current === info.enabled) {
			settings.updateGeneralSettings({ speakerDiarization: !info.enabled });
		}
	});
	return () => {
		unsubStarted();
		unsubCompleted();
		unsubFailed();
	};
}

if (typeof window !== "undefined" && window.nativeBridge != null) {
	initDiarizationToggleStore();
}
