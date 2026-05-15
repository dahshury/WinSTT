"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useInputDevices } from "@/entities/audio-device";
import { useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { onDeviceSwitchFailed, settingsSave } from "@/shared/api/ipc-client";

/**
 * Listens for `device_switch_failed` events emitted by the STT server when a
 * queued input-device switch can't be opened. Reverts the user's selection
 * back to whatever device the server is actually streaming from (the
 * fallback, or system default), refreshes the device list (so a phantom
 * entry that just failed gets re-validated by the next probe), and surfaces
 * the failure as an ephemeral subtitle so the user knows the switch did not
 * take effect.
 *
 * The fallback is persisted immediately (bypassing useSyncSettings' 300 ms
 * debounce) — otherwise a user closing the app within that window would
 * leave the broken index in electron-store and hit the same failure on the
 * next launch.
 */
export function useDeviceSwitchFeedback(): void {
	const t = useTranslations("audio");
	const updateAudio = useSettingsStore((s) => s.updateAudioSettings);
	const showEphemeral = useTranscriptionStore((s) => s.showEphemeral);
	const { refresh } = useInputDevices();

	useEffect(() => {
		const unsub = onDeviceSwitchFailed(({ errorMessage, fallbackIndex }) => {
			updateAudio({ inputDeviceIndex: fallbackIndex });
			// Read AFTER updateAudio so the fresh inputDeviceIndex is in the
			// snapshot.  Zustand updates are synchronous, so getState()
			// reflects the mutation immediately.
			settingsSave(useSettingsStore.getState().settings);
			refresh().catch(() => undefined);
			showEphemeral(t("deviceSwitchFailed", { reason: errorMessage }));
		});
		return unsub;
	}, [updateAudio, refresh, showEphemeral, t]);
}
