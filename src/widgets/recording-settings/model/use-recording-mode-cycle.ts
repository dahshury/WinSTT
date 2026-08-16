import { useEffect } from "react";
import { useSettingsStore } from "@/entities/setting";
import { useModeTransitionStore } from "@/features/recording-mode-transition";
import { onRecordingModeCycle, settingsSave } from "@/shared/api/ipc-client";
import { recordingModePatch } from "../lib/recording-settings-helpers";

/** The order the "hold PTT hotkey + ArrowUp" gesture advances through — must match
 *  the visual chain in `HotkeyShortcutsLegend` (ptt → toggle → wakeword → listen →
 *  wrap). */
const MODE_CYCLE_ORDER = ["ptt", "toggle", "wakeword", "listen"] as const;

type RecordingMode = (typeof MODE_CYCLE_ORDER)[number];

/** The next recording mode in the cycle, wrapping wakeword → ptt. An unknown
 *  current value (should never happen) restarts the cycle at ptt. */
export function nextRecordingMode(current: string): RecordingMode {
	const index = MODE_CYCLE_ORDER.indexOf(current as RecordingMode);
	return MODE_CYCLE_ORDER[(index + 1) % MODE_CYCLE_ORDER.length] ?? "ptt";
}

/**
 * Advance the recording mode when the backend reports the cycle gesture
 * (`recording:mode-cycle`, emitted by the native cycle-gesture keyboard hook when
 * the transcribe hotkey is held and ArrowUp is tapped). The renderer owns the
 * cycle order — the backend only signals the gesture — so this applies the next
 * mode + persists it exactly like the settings-panel switcher, which broadcasts
 * `settings:changed` and drives the tray-indicator pill.
 *
 * Mount ONCE, in the main window's `IpcProvider` (single authority for mode), so a
 * single gesture advances exactly one step.
 */
export function useRecordingModeCycle(): void {
	useEffect(
		() =>
			onRecordingModeCycle(() => {
				// The gesture is the one mode control with no visible disabled state,
				// so it has to check the phase itself: advancing again while the
				// previous mode's model is still loading would abandon that load and
				// leave the user two modes away from where the spinner says they are.
				if (useModeTransitionStore.getState().isPreparing) {
					return;
				}
				const store = useSettingsStore.getState();
				const general = store.settings.general;
				const next = nextRecordingMode(general?.recordingMode ?? "ptt");
				const patch = recordingModePatch(next, general?.wakeWord);
				store.updateGeneralSettings(patch);
				if (general) {
					void settingsSave({ general: { ...general, ...patch } });
				}
			}),
		[],
	);
}
