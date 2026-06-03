import { useCallback, useEffect, useRef, useState } from "react";
import { audioGetDevices } from "@/shared/api/ipc-client";
import type { AudioDevice } from "./audio-device";

interface UseInputDevicesResult {
	defaultDevice: AudioDevice | null;
	devices: AudioDevice[];
	refresh: () => Promise<void>;
}

/**
 * Window during which consecutive ``devicechange`` events collapse into a
 * single enumeration call.  A failed PyAudio open (e.g. a stored
 * inputDeviceIndex pointing at a Bluetooth output-only profile) flaps the
 * device state and the browser fires several ``devicechange`` events
 * within a handful of milliseconds; without this debounce the renderer
 * hammers the server with 5-10 list_input_devices requests in a burst.
 */
const DEVICECHANGE_DEBOUNCE_MS = 200;
const DEVICE_POLL_INTERVAL_MS = 1000;

function areDeviceListsEqual(a: readonly AudioDevice[], b: readonly AudioDevice[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	return a.every((device, index) => {
		const other = b[index];
		return (
			other !== undefined &&
			device.index === other.index &&
			device.name === other.name &&
			device.isDefault === other.isDefault &&
			device.maxInputChannels === other.maxInputChannels &&
			device.defaultSampleRate === other.defaultSampleRate
		);
	});
}

/**
 * Returns the list of audio input devices reported by the OS via the main
 * process, keeping it in sync with hot-plug events.
 *
 * Why: the IPC enumeration is one-shot, so without this hook the footer mic
 * picker would never see a newly inserted device until the user reopened the
 * Settings page. We piggy-back on the renderer's `navigator.mediaDevices`
 * `devicechange` event to know *when* to re-fetch, but the device data itself
 * still comes from Python's PyAudio enumeration so the indices match what the
 * STT server uses.
 */
export function useInputDevices(): UseInputDevicesResult {
	const [devices, setDevices] = useState<AudioDevice[]>([]);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const refresh = useCallback(async () => {
		const list = await audioGetDevices();
		setDevices((current) => (areDeviceListsEqual(current, list) ? current : list));
	}, []);

	useEffect(() => {
		const refreshSafely = () => {
			refresh().catch(() => undefined);
		};
		refreshSafely();
		const pollId = setInterval(refreshSafely, DEVICE_POLL_INTERVAL_MS);
		const mediaDevices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
		const handler = () => {
			// Coalesce rapid devicechange bursts (5-10 events within ~10ms when
			// a stream open fails and the OS retries) into a single enumeration.
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
			}
			debounceRef.current = setTimeout(() => {
				debounceRef.current = null;
				refreshSafely();
			}, DEVICECHANGE_DEBOUNCE_MS);
		};
		mediaDevices?.addEventListener("devicechange", handler);
		return () => {
			clearInterval(pollId);
			mediaDevices?.removeEventListener("devicechange", handler);
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
				debounceRef.current = null;
			}
		};
	}, [refresh]);

	const defaultDevice = devices.find((d) => d.isDefault) ?? null;
	return { devices, defaultDevice, refresh };
}
