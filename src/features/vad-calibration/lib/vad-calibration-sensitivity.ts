import type { AudioDevice } from "@/entities/audio-device";

/** True when the device list hasn't enumerated yet (CC 1). */
function devicesEmpty(devices: readonly AudioDevice[]): boolean {
	return devices.length === 0;
}

/** Name of the system-default device, or null when unknown (CC 1). */
function defaultDeviceName(defaultDevice: AudioDevice | null): string | null {
	return defaultDevice?.name ?? null;
}

/** Name of the device whose index matches, or null when not found (CC 1). */
function deviceNameByIndex(
	devices: readonly AudioDevice[],
	inputDeviceIndex: number,
): string | null {
	return devices.find((d) => d.index === inputDeviceIndex)?.name ?? null;
}

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
	defaultDevice: AudioDevice | null,
): string | null {
	if (devicesEmpty(devices)) {
		return null;
	}
	return inputDeviceIndex == null
		? defaultDeviceName(defaultDevice)
		: deviceNameByIndex(devices, inputDeviceIndex);
}

/** Read the persisted sensitivity for a device, or null when absent (CC 1). */
function persistedSensitivityFor(
	deviceName: string,
	map: Readonly<Record<string, number>> | undefined,
): number | null {
	return map?.[deviceName] ?? null;
}

/** True when the persisted value should be applied as a change (CC 1). */
function persistedDiffers(
	persisted: number | null,
	currentSensitivity: number | undefined,
): persisted is number {
	return persisted != null && persisted !== currentSensitivity;
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
	map: Readonly<Record<string, number>> | undefined,
): number | null {
	if (deviceName == null) {
		return null;
	}
	const persisted = persistedSensitivityFor(deviceName, map);
	return persistedDiffers(persisted, currentSensitivity) ? persisted : null;
}
