import { useEffect, useRef } from "react";
import { useInputDevices } from "@/entities/audio-device";
import { useSettingsStore } from "@/entities/setting";
import { onVadSensitivityAdapted, settingsSave } from "@/shared/api/ipc-client";
import type { AppSettingsOutput } from "@/shared/config/settings-schema";
import {
	nextSensitivityForDevice,
	resolveCurrentDeviceName,
} from "../lib/vad-calibration-sensitivity";

type AudioPatch = Partial<AppSettingsOutput["audio"]>;

/** Build the audio-settings patch for an adapt event (CC 1). */
function buildAdaptPatch(
	deviceName: string | null,
	currentMap: Record<string, number> | undefined,
	newSensitivity: number
): AudioPatch {
	if (deviceName == null) {
		// Unknown device — bump live value only, don't poison the map.
		return { sileroSensitivity: newSensitivity };
	}
	const map = { ...(currentMap ?? {}) };
	map[deviceName] = newSensitivity;
	return {
		sileroSensitivity: newSensitivity,
		sileroSensitivityByDeviceName: map,
	};
}

/**
 * Wires up cross-utterance adaptive Silero VAD sensitivity persistence.
 *
 * Two duties:
 *
 *   1. ``vad_sensitivity_adapted`` events from the STT server carry the new
 *      sensitivity the server's :class:`VADCalibrator` settled on. We store
 *      it under the currently-selected input-device name and bump
 *      ``audio.sileroSensitivity`` (the live value used by useSyncSettings'
 *      delta-sync) so the slider in Settings reflects what the server is
 *      actually using.
 *   2. When the user switches input device, we read the device's persisted
 *      sensitivity from the per-device map and write it into
 *      ``audio.sileroSensitivity``. useSyncSettings then pushes a single
 *      ``set_parameter`` to the server, seeding adaptation with the right
 *      starting point for the new mic instead of whatever value the
 *      previously-active device drifted to.
 *
 * The server stays device-agnostic; the renderer owns the correlation.
 */
export function useVadCalibration(): void {
	const audio = useSettingsStore((s) => s.settings.audio);
	const updateAudio = useSettingsStore((s) => s.updateAudioSettings);
	const { devices, defaultDevice } = useInputDevices();

	const deviceName = resolveCurrentDeviceName(audio?.inputDeviceIndex, devices, defaultDevice);

	// Refs let the persistence effect run without re-subscribing every time
	// the map or the selected device changes — re-subscribing would race
	// against an in-flight adapt event mid-recording.
	const deviceNameRef = useRef<string | null>(deviceName);
	const mapRef = useRef<Record<string, number> | undefined>(audio?.sileroSensitivityByDeviceName);
	deviceNameRef.current = deviceName;
	mapRef.current = audio?.sileroSensitivityByDeviceName;

	// Persist on adapt — single subscription for the component's lifetime.
	//
	// IMPORTANT: send only the `audio` section, not the full settings. A full
	// save here would broadcast this renderer's *stale* `general`/`model`/etc.
	// to every other window, and in particular would clobber any setting the
	// user just changed in the settings panel that's still inside its 300ms
	// debounce window (overlayMode, recording-mode toggle, etc.) by both
	// overwriting it on disk and racing a `settings:changed` broadcast back at
	// the panel — whose `useSyncSettings` effect cleanup would then cancel the
	// pending save before it fires. Audio is the only section this hook owns.
	useEffect(() => {
		const unsub = onVadSensitivityAdapted(({ newSensitivity }) => {
			const patch = buildAdaptPatch(deviceNameRef.current, mapRef.current, newSensitivity);
			updateAudio(patch);
			settingsSave({ audio: useSettingsStore.getState().settings.audio });
		});
		return unsub;
	}, [updateAudio]);

	// On device switch, seed the live sensitivity from the device's
	// persisted value. lastAppliedNameRef gates duplicate runs so we don't
	// fight useSyncSettings on every render.
	const lastAppliedNameRef = useRef<string | null>(null);
	useEffect(() => {
		if (!shouldRunDeviceSwitch(deviceName, lastAppliedNameRef.current)) {
			return;
		}
		lastAppliedNameRef.current = deviceName;
		const next = nextSensitivityForDevice(
			deviceName,
			audio?.sileroSensitivity,
			audio?.sileroSensitivityByDeviceName
		);
		if (next != null) {
			updateAudio({ sileroSensitivity: next });
		}
	}, [deviceName, audio?.sileroSensitivity, audio?.sileroSensitivityByDeviceName, updateAudio]);
}

/**
 * True when the device-switch effect should advance: the device is known and
 * differs from the last value we applied this hook lifetime (CC 1).
 */
function shouldRunDeviceSwitch(
	deviceName: string | null,
	lastAppliedName: string | null
): deviceName is string {
	return deviceName != null && deviceName !== lastAppliedName;
}
