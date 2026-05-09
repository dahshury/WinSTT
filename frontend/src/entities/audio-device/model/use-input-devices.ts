"use client";

import { useCallback, useEffect, useState } from "react";
import { audioGetDevices } from "@/shared/api/ipc-client";
import type { AudioDevice } from "./audio-device";

interface UseInputDevicesResult {
	defaultDevice: AudioDevice | null;
	devices: AudioDevice[];
	refresh: () => Promise<void>;
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

	const refresh = useCallback(async () => {
		const list = await audioGetDevices();
		setDevices(list);
	}, []);

	useEffect(() => {
		refresh().catch(() => undefined);
		if (typeof navigator === "undefined" || !navigator.mediaDevices) {
			return;
		}
		const handler = () => {
			refresh().catch(() => undefined);
		};
		navigator.mediaDevices.addEventListener("devicechange", handler);
		return () => {
			navigator.mediaDevices.removeEventListener("devicechange", handler);
		};
	}, [refresh]);

	const defaultDevice = devices.find((d) => d.isDefault) ?? null;
	return { devices, defaultDevice, refresh };
}
