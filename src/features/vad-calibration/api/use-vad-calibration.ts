import { useEffect, useRef } from "react";
import { useInputDevices } from "@/entities/audio-device";
import { useSettingsStore } from "@/entities/setting";
import {
	nextSensitivityForDevice,
	resolveCurrentDeviceName,
} from "../lib/vad-calibration-sensitivity";

/**
 * Seeds the live Silero VAD sensitivity from the per-device calibration map
 * when the user switches input device.
 *
 * On a device switch we read the device's persisted sensitivity from
 * ``audio.sileroSensitivityByDeviceName`` and write it into
 * ``audio.sileroSensitivity``. useSyncSettings then pushes the new value to
 * the backend so each mic starts from its own calibrated point instead of
 * whatever value the previously-active device was using.
 *
 * (A cross-utterance adaptive-calibration path that pushed a
 * ``vad_sensitivity_adapted`` event back from the backend once existed but was
 * never wired end-to-end and has been removed; the renderer owns per-device
 * persistence and seeding only.)
 */
export function useVadCalibration(): void {
	const audio = useSettingsStore((s) => s.settings.audio);
	const updateAudio = useSettingsStore((s) => s.updateAudioSettings);
	const { devices, defaultDevice } = useInputDevices();

	const deviceName = resolveCurrentDeviceName(
		audio?.inputDeviceIndex,
		devices,
		defaultDevice,
	);

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
			audio?.sileroSensitivityByDeviceName,
		);
		if (next != null) {
			updateAudio({ sileroSensitivity: next });
		}
	}, [
		deviceName,
		audio?.sileroSensitivity,
		audio?.sileroSensitivityByDeviceName,
		updateAudio,
	]);
}

/**
 * True when the device-switch effect should advance: the device is known and
 * differs from the last value we applied this hook lifetime.
 */
function shouldRunDeviceSwitch(
	deviceName: string | null,
	lastAppliedName: string | null,
): deviceName is string {
	return deviceName != null && deviceName !== lastAppliedName;
}
