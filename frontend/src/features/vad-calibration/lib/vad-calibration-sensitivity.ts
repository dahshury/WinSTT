import type { AudioDevice } from "@/entities/audio-device";

/**
 * Resolve the currently active input-device name from the saved index plus
 * the live device list. Returns ``null`` while devices haven't enumerated
 * yet (don't write to the calibration map under an unknown key — wait).
 *
 * - ``inputDeviceIndex === null`` → system default; uses the device the OS
 *   reports as default at enumeration time.
 * - Otherwise the matching device by index.
 */
export function resolveCurrentDeviceName(
	inputDeviceIndex: number | null | undefined,
	devices: readonly AudioDevice[],
	defaultDevice: AudioDevice | null
): string | null {
	if (devices.length === 0) {
		return null;
	}
	if (inputDeviceIndex == null) {
		return defaultDevice?.name ?? null;
	}
	return devices.find((d) => d.index === inputDeviceIndex)?.name ?? null;
}

/**
 * Decide whether the locally-persisted per-device sensitivity should be
 * re-applied to the live setting. Returns the value to apply, or ``null``
 * when no change is needed. Centralised so the hook stays focused on
 * subscribing and the rule is testable in isolation.
 */
export function nextSensitivityForDevice(
	deviceName: string | null,
	currentSensitivity: number | undefined,
	map: Readonly<Record<string, number>> | undefined
): number | null {
	if (deviceName == null) {
		return null;
	}
	const persisted = map?.[deviceName];
	if (persisted == null) {
		return null;
	}
	if (persisted === currentSensitivity) {
		return null;
	}
	return persisted;
}
