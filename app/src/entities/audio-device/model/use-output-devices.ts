import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One ``audiooutput`` device entry, denormalized from
 * :class:`MediaDeviceInfo` so the consumer doesn't have to depend on the
 * DOM type (which isn't available in unit tests without jsdom shims).
 */
export interface OutputDevice {
	deviceId: string;
	isDefault: boolean;
	label: string;
}

interface UseOutputDevicesResult {
	defaultDevice: OutputDevice | null;
	devices: OutputDevice[];
	refresh: () => Promise<void>;
}

/**
 * Same debounce window as :file:`use-input-devices.ts` — bursty
 * ``devicechange`` events from drivers coalesce into one re-enumeration.
 */
const DEVICECHANGE_DEBOUNCE_MS = 200;

/**
 * Returns the list of audio OUTPUT devices reported by the browser via
 * ``navigator.mediaDevices.enumerateDevices()`` (filtered to
 * ``kind === "audiooutput"``).
 *
 * Why the renderer-side enumeration (vs. PyAudio for inputs): output
 * device routing is handled in the renderer — recording-sound chimes
 * play via ``HTMLAudioElement``, TTS plays via ``AudioContext``, both
 * accept ``setSinkId(deviceId)``. Python never sees the deviceId, so
 * adding an IPC enumeration just for outputs would be redundant.
 *
 * Permissions: enumerateDevices() returns empty ``label`` strings until
 * the user has granted microphone permission once. WinSTT already prompts
 * for that during onboarding (OnboardingMicTestStep), so on the live app
 * the labels are populated by the time the user reaches this picker.
 * When labels are empty (no permission yet), we fall back to ``Output 1``
 * / ``Output 2`` / ... so the picker is still usable.
 */
export function useOutputDevices(): UseOutputDevicesResult {
	const [devices, setDevices] = useState<OutputDevice[]>([]);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const refresh = useCallback(async () => {
		if (typeof navigator === "undefined" || !navigator.mediaDevices) {
			return;
		}
		const raw = await navigator.mediaDevices.enumerateDevices();
		const outputs: OutputDevice[] = [];
		let fallbackCounter = 1;
		for (const d of raw) {
			if (d.kind !== "audiooutput") {
				continue;
			}
			// Special ``default`` / ``communications`` deviceIds appear on
			// Chromium; the first non-special entry is the system default.
			// `isDefault` is set on the entry whose deviceId equals ``default``
			// (Chromium emits it as a dedicated row before the actual default
			// device) so the consumer can highlight it.
			outputs.push({
				deviceId: d.deviceId,
				label: d.label || `Output ${fallbackCounter++}`,
				isDefault: d.deviceId === "default",
			});
		}
		setDevices(outputs);
	}, []);

	useEffect(() => {
		refresh().catch(() => undefined);
		if (typeof navigator === "undefined" || !navigator.mediaDevices) {
			return;
		}
		const handler = () => {
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
			}
			debounceRef.current = setTimeout(() => {
				debounceRef.current = null;
				refresh().catch(() => undefined);
			}, DEVICECHANGE_DEBOUNCE_MS);
		};
		navigator.mediaDevices.addEventListener("devicechange", handler);
		return () => {
			navigator.mediaDevices.removeEventListener("devicechange", handler);
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
				debounceRef.current = null;
			}
		};
	}, [refresh]);

	const defaultDevice = devices.find((d) => d.isDefault) ?? devices[0] ?? null;
	return { devices, defaultDevice, refresh };
}
