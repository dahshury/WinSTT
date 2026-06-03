import {
	BluetoothConnectedIcon,
	CameraMicrophone01Icon,
	ComputerIcon,
	HeadsetIcon,
	LaptopIcon,
	Mic01Icon,
	MixerIcon,
	UsbConnected01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { AudioDevice } from "../model/audio-device";

export interface InputDeviceOption {
	icon: IconSvgElement;
	id: string;
	label: string;
}

interface IconRule {
	icon: IconSvgElement;
	patterns: readonly RegExp[];
}

const DEVICE_ICON_RULES: readonly IconRule[] = [
	{
		icon: BluetoothConnectedIcon,
		patterns: [/\bbluetooth\b/i, /\bbt\b/i, /\bwireless\b/i],
	},
	{
		icon: HeadsetIcon,
		patterns: [
			/\bheadsets?\b/i,
			/\bheadphones?\b/i,
			/\bearbuds?\b/i,
			/\bearphones?\b/i,
			/\bhands[-\s]?free\b/i,
			/\bairpods?\b/i,
			/\bbuds?\b/i,
		],
	},
	{
		icon: CameraMicrophone01Icon,
		patterns: [/\bcameras?\b/i, /\bwebcams?\b/i, /\bcam\b/i, /\bc920\b/i, /\bbrio\b/i],
	},
	{
		icon: MixerIcon,
		patterns: [
			/\bline[-\s]?in\b/i,
			/\bstereo mix\b/i,
			/\bwhat u hear\b/i,
			/\bmixers?\b/i,
			/\baudio interface\b/i,
			/\binterfaces?\b/i,
			/\bfocusrite\b/i,
			/\bscarlett\b/i,
			/\brodecaster\b/i,
			/\bvoicemeeter\b/i,
		],
	},
	{
		icon: UsbConnected01Icon,
		patterns: [/\busb\b/i, /\busb-c\b/i, /\btype-c\b/i],
	},
	{
		icon: LaptopIcon,
		patterns: [
			/\bbuilt[-\s]?in\b/i,
			/\binternal\b/i,
			/\bintegrated\b/i,
			/\bmicrophone array\b/i,
			/\bmic array\b/i,
			/\brealtek\b/i,
			/\bintel.*smart sound\b/i,
			/\bdigital microphones?\b/i,
		],
	},
] as const;

export function inputDeviceIconForName(name: string): IconSvgElement {
	for (const rule of DEVICE_ICON_RULES) {
		if (rule.patterns.some((pattern) => pattern.test(name))) {
			return rule.icon;
		}
	}
	return Mic01Icon;
}

function inputDefaultIcon(defaultDeviceName: string | null | undefined): IconSvgElement {
	return defaultDeviceName ? inputDeviceIconForName(defaultDeviceName) : ComputerIcon;
}

/**
 * Resolves the canonical id for a device row. When the device's name matches
 * the selected name, return the selected index — this lets the picker show
 * the user's exact selection even if PyAudio exposed the same mic under a
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
): InputDeviceOption[] {
	const seen = new Set<string>();
	const opts: InputDeviceOption[] = [];
	for (const d of devices) {
		// Stryker disable next-line MethodExpression: equivalent — toUpperCase() normalizes case identically for the dedup key, so swapping to/from upper/lower is unobservable.
		const key = d.name.trim().toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		opts.push({
			icon: inputDeviceIconForName(d.name),
			id: resolveDeviceId(d, inputDeviceIndex, selectedName),
			label: d.name,
		});
	}
	return opts;
}

export interface InputDeviceResult {
	currentDeviceId: string;
	currentDeviceLabel: string;
	deviceOptions: InputDeviceOption[];
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
 * Builds the input-device picker options from the device list, prepending a
 * "system default" row. Deduplicates by name (PyAudio may expose the same
 * mic under multiple host APIs).
 */
export function buildInputDeviceOptions(
	devices: readonly AudioDevice[],
	inputDeviceIndex: number | null,
	defaultLabel: string,
	defaultDeviceName?: string | null
): InputDeviceResult {
	const opts: InputDeviceOption[] = [
		{ icon: inputDefaultIcon(defaultDeviceName), id: "default", label: defaultLabel },
	];
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
