"use client";

import { useEffect, useRef } from "react";
import { useInputDevices } from "@/entities/audio-device";
import { useSettingsStore } from "@/entities/setting";
import { onVadSensitivityAdapted, settingsSave } from "@/shared/api/ipc-client";
import {
	nextSensitivityForDevice,
	resolveCurrentDeviceName,
} from "../lib/vad-calibration-sensitivity";

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
	useEffect(() => {
		const unsub = onVadSensitivityAdapted(({ newSensitivity }) => {
			const name = deviceNameRef.current;
			if (name == null) {
				// No idea which device this belongs to — bump the live value
				// only, skip the map. Adaptation re-fires on the next
				// recording, so a permanent miss isn't possible.
				updateAudio({ sileroSensitivity: newSensitivity });
				settingsSave(useSettingsStore.getState().settings);
				return;
			}
			const map = { ...(mapRef.current ?? {}) };
			map[name] = newSensitivity;
			updateAudio({
				sileroSensitivity: newSensitivity,
				sileroSensitivityByDeviceName: map,
			});
			settingsSave(useSettingsStore.getState().settings);
		});
		return unsub;
	}, [updateAudio]);

	// On device switch, seed the live sensitivity from the device's
	// persisted value. lastAppliedNameRef gates duplicate runs so we don't
	// fight useSyncSettings on every render.
	const lastAppliedNameRef = useRef<string | null>(null);
	useEffect(() => {
		if (deviceName == null) {
			return;
		}
		if (deviceName === lastAppliedNameRef.current) {
			return;
		}
		lastAppliedNameRef.current = deviceName;
		const next = nextSensitivityForDevice(
			deviceName,
			audio?.sileroSensitivity,
			audio?.sileroSensitivityByDeviceName
		);
		if (next == null) {
			return;
		}
		updateAudio({ sileroSensitivity: next });
	}, [deviceName, audio?.sileroSensitivity, audio?.sileroSensitivityByDeviceName, updateAudio]);
}
