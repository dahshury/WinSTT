import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useInputDevices } from "@/entities/audio-device";
import { useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { onDeviceSwitchFailed, settingsSave } from "@/shared/api/ipc-client";

/**
 * Pure rule for whether a saved input-device index has gone stale and must
 * be reset to "system default". Returns false while the list is still empty
 * (loading / no hardware — server-side fallback owns audio routing) or when
 * no index was ever saved; otherwise true only when the saved index is
 * absent from the freshly enumerated device list.
 */
function shouldResetSavedIndex(
	savedIndex: number | null | undefined,
	devices: ReadonlyArray<{ index: number }>
): boolean {
	if (savedIndex == null || devices.length === 0) {
		return false;
	}
	return !devices.some((d) => d.index === savedIndex);
}

/** Internal — exported solely for colocated unit tests (not in the slice
 * public API). */
export const __test_shouldResetSavedIndex = shouldResetSavedIndex;

/**
 * Listens for `device_switch_failed` events emitted by the STT server when a
 * queued input-device switch can't be opened. Reverts the user's selection
 * back to whatever device the server is actually streaming from (the
 * fallback, or system default), refreshes the device list (so a phantom
 * entry that just failed gets re-validated by the next probe), and surfaces
 * the failure as an ephemeral subtitle so the user knows the switch did not
 * take effect.
 *
 * Also reconciles a stale saved ``inputDeviceIndex`` against the current
 * enumeration: when the picker returns at least one device and the saved
 * index isn't in it (e.g. the user previously picked an MME duplicate that
 * the WASAPI-only enumeration no longer surfaces, or a USB mic that has
 * been unplugged), we auto-reset to ``null`` so the UI shows "System
 * default" instead of an orphaned selection. The server-side fallback in
 * ``PyAudioSource.setup`` already handles the audio side; this keeps the UI
 * truthful.
 *
 * The fallback is persisted immediately (bypassing useSyncSettings' 300 ms
 * debounce) — otherwise a user closing the app within that window would
 * leave the broken index in electron-store and hit the same failure on the
 * next launch.
 */
export function useDeviceSwitchFeedback(): void {
	const t = useTranslations("audio");
	const updateAudio = useSettingsStore((s) => s.updateAudioSettings);
	const savedIndex = useSettingsStore((s) => s.settings.audio?.inputDeviceIndex);
	const showEphemeral = useTranscriptionStore((s) => s.showEphemeral);
	const { devices, refresh } = useInputDevices();

	useEffect(() => {
		const unsub = onDeviceSwitchFailed(({ errorMessage, fallbackIndex }) => {
			updateAudio({ inputDeviceIndex: fallbackIndex });
			// Read AFTER updateAudio so the fresh inputDeviceIndex is in the
			// snapshot.  Zustand updates are synchronous, so getState()
			// reflects the mutation immediately.
			//
			// Send ONLY the `audio` section, not the full settings. A full save
			// would broadcast this renderer's stale `general`/`model`/etc. to
			// other windows, clobbering anything (e.g. `general.overlayMode`)
			// the user just changed in the settings panel that's still inside
			// its 300ms debounce — both on disk and via a `settings:changed`
			// broadcast that cancels the panel's pending save.
			settingsSave({ audio: useSettingsStore.getState().settings.audio });
			refresh().catch(() => undefined);
			showEphemeral(t("deviceSwitchFailed", { reason: errorMessage }));
		});
		return unsub;
	}, [updateAudio, refresh, showEphemeral, t]);

	useEffect(() => {
		if (!shouldResetSavedIndex(savedIndex, devices)) {
			return;
		}
		updateAudio({ inputDeviceIndex: null });
		// Same partial-save rationale as the device-switch-failed handler above —
		// only the `audio` section is this hook's concern.
		settingsSave({ audio: useSettingsStore.getState().settings.audio });
	}, [devices, savedIndex, updateAudio]);
}
