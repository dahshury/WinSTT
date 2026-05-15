import type { AudioDevice } from "@/entities/audio-device";

export interface TrayDeviceOption {
	id: string;
	label: string;
}

/**
 * Resolves the canonical id for a device row. When the device's name matches
 * the selected name, return the selected index — this lets the tray show the
 * user's exact selection even if PyAudio exposed the same mic under a
 * different host-API index in the first-seen row.
 */
function resolveDeviceId(
	device: AudioDevice,
	inputDeviceIndex: number | null,
	selectedName: string | null
): string {
	const isSelected = selectedName === device.name;
	return String(isSelected ? inputDeviceIndex : device.index);
}

/** Deduplicates devices by name (PyAudio enumerates same mic under multiple host APIs). */
function dedupeDevicesByName(
	devices: readonly AudioDevice[],
	inputDeviceIndex: number | null,
	selectedName: string | null
): TrayDeviceOption[] {
	const seen = new Set<string>();
	const opts: TrayDeviceOption[] = [];
	for (const d of devices) {
		// Stryker disable next-line MethodExpression: equivalent — toUpperCase() normalizes case identically for the dedup key, so swapping to/from upper/lower is unobservable.
		const key = d.name.trim().toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		opts.push({ id: resolveDeviceId(d, inputDeviceIndex, selectedName), label: d.name });
	}
	return opts;
}

export interface TrayDeviceResult {
	currentDeviceId: string;
	currentDeviceLabel: string;
	deviceOptions: TrayDeviceOption[];
}

/** Resolves the selected device's name from the device list. */
function resolveSelectedName(
	devices: readonly AudioDevice[],
	inputDeviceIndex: number | null
): string | null {
	if (inputDeviceIndex == null) {
		return null;
	}
	return devices.find((d) => d.index === inputDeviceIndex)?.name ?? null;
}

/**
 * Builds the tray-menu device picker options from the device list.
 * Deduplicates by name (PyAudio may expose the same mic under multiple host APIs).
 */
export function buildTrayDeviceOptions(
	devices: readonly AudioDevice[],
	_defaultDevice: AudioDevice | null | undefined,
	inputDeviceIndex: number | null,
	defaultLabel: string
): TrayDeviceResult {
	const opts: TrayDeviceOption[] = [{ id: "default", label: defaultLabel }];
	const selectedName = resolveSelectedName(devices, inputDeviceIndex);
	opts.push(...dedupeDevicesByName(devices, inputDeviceIndex, selectedName));

	const currentDeviceId = inputDeviceIndex == null ? "default" : String(inputDeviceIndex);
	const found = opts.find((o) => o.id === currentDeviceId);
	return {
		deviceOptions: opts,
		currentDeviceId,
		currentDeviceLabel: found?.label ?? defaultLabel,
	};
}
