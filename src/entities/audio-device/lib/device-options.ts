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
import type { SelectOption } from "@/shared/ui/select";
import type { AudioDevice } from "../model/audio-device";

export interface InputDeviceOption {
	icon: IconSvgElement;
	id: string;
	label: string;
	/** Device rows are drag-sortable in the pickers (the pinned "system
	 *  default" row is not). */
	sortable?: boolean;
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
		patterns: [
			/\bcameras?\b/i,
			/\bwebcams?\b/i,
			/\bcam\b/i,
			/\bc920\b/i,
			/\bbrio\b/i,
		],
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

function inputDefaultIcon(
	defaultDeviceName: string | null | undefined,
): IconSvgElement {
	return defaultDeviceName
		? inputDeviceIconForName(defaultDeviceName)
		: ComputerIcon;
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
	selectedName: string | null,
): string {
	const isSelected = selectedName === device.name;
	return String(isSelected ? inputDeviceIndex : device.index);
}

/** Canonical identity key for a device name — also the priority-list match
 *  key, so ordering survives cosmetic case/whitespace differences between
 *  enumerations. */
function deviceNameKey(name: string): string {
	// Stryker disable next-line MethodExpression: equivalent — toUpperCase() normalizes case identically for the dedup key, so swapping to/from upper/lower is unobservable.
	return name.trim().toLowerCase();
}

/** Deduplicates devices by name (PyAudio enumerates same mic under multiple host APIs). */
function dedupeDevicesByName(
	devices: readonly AudioDevice[],
	inputDeviceIndex: number | null,
	selectedName: string | null,
): InputDeviceOption[] {
	const seen = new Set<string>();
	const opts: InputDeviceOption[] = [];
	for (const d of devices) {
		const key = deviceNameKey(d.name);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		opts.push({
			icon: inputDeviceIconForName(d.name),
			id: resolveDeviceId(d, inputDeviceIndex, selectedName),
			label: d.name,
			sortable: true,
		});
	}
	return opts;
}

/**
 * Orders device rows by the saved preference list: names present in
 * `priority` first (in priority order), the rest in enumeration order.
 * Stable so an empty/partial priority list degrades to today's order.
 */
function sortOptionsByPriority(
	opts: readonly InputDeviceOption[],
	priority: readonly string[],
): InputDeviceOption[] {
	if (priority.length === 0) {
		return [...opts];
	}
	const rank = new Map<string, number>();
	priority.forEach((name, i) => {
		const key = deviceNameKey(name);
		if (!rank.has(key)) {
			rank.set(key, i);
		}
	});
	return opts.toSorted(
		(a, b) =>
			(rank.get(deviceNameKey(a.label)) ?? Number.POSITIVE_INFINITY) -
			(rank.get(deviceNameKey(b.label)) ?? Number.POSITIVE_INFINITY),
	);
}

/**
 * The highest-priority device that is currently connected, or `null` when
 * the priority list is empty or none of its entries are plugged in. Mirrors
 * the backend's stream-open resolution (`choose_priority_device_position` in
 * managers/audio.rs) so every picker can mark the device the recorder will
 * actually open — and only that one.
 */
function resolveEffectivePriorityDevice(
	devices: readonly AudioDevice[],
	priority: readonly string[],
): AudioDevice | null {
	for (const name of priority) {
		const key = deviceNameKey(name);
		const match = devices.find((d) => deviceNameKey(d.name) === key);
		if (match) {
			return match;
		}
	}
	return null;
}

/** Index-only variant for callers that re-point `inputDeviceIndex`. */
export function resolveEffectivePriorityDeviceIndex(
	devices: readonly AudioDevice[],
	priority: readonly string[],
): number | null {
	return resolveEffectivePriorityDevice(devices, priority)?.index ?? null;
}

/**
 * Moves `name` to the front of the priority list (appending it when absent),
 * preserving the relative order of the other entries. Used when the user
 * clicks a device while a preference order exists — the click must win, and
 * "top of the list" is what winning means.
 */
export function promoteDeviceNameToTop(
	priority: readonly string[],
	name: string,
): string[] {
	const key = deviceNameKey(name);
	return [name, ...priority.filter((entry) => deviceNameKey(entry) !== key)];
}

/**
 * Maps a drag-reordered picker row order (option ids, "default" row included
 * or not) back to the device-name priority list to persist.
 */
export function priorityFromReorderedOptions(
	options: readonly { id: string; label: string }[],
	orderedIds: readonly string[],
): string[] {
	const byId = new Map(options.map((o) => [o.id, o]));
	return orderedIds
		.map((id) => byId.get(id))
		.filter(
			(o): o is { id: string; label: string } =>
				o !== undefined && o.id !== "default",
		)
		.map((o) => o.label);
}

/**
 * Selection semantics shared by the settings Select and the detached tray
 * picker. Clicking is still an explicit "use this one", but it must not fight
 * the preference order: while a priority list exists, the effective mic is
 * always its top-most connected entry, so a click promotes the chosen device
 * to the top (and "System default" opts out by clearing the list).
 */
export function applyDeviceSelection({
	id,
	onChange,
	onPriorityChange,
	options,
	priority,
}: {
	id: string;
	onChange: (inputDeviceIndex: number | null) => void;
	onPriorityChange?: ((priority: string[]) => void) | undefined;
	options: readonly SelectOption[];
	priority: readonly string[];
}): void {
	if (id === "default") {
		onChange(null);
		if (onPriorityChange && priority.length > 0) {
			onPriorityChange([]);
		}
		return;
	}
	onChange(Number.parseInt(id, 10));
	const name = options.find((o) => o.id === id)?.label;
	if (onPriorityChange && name && priority.length > 0) {
		onPriorityChange(promoteDeviceNameToTop(priority, name));
	}
}

export interface InputDeviceResult {
	currentDeviceId: string;
	currentDeviceLabel: string;
	deviceOptions: InputDeviceOption[];
}

/** Resolves the selected device's name from the device list. */
function resolveSelectedName(
	devices: readonly AudioDevice[],
	inputDeviceIndex: number | null,
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
	defaultDeviceName?: string | null,
	inputDevicePriority: readonly string[] = [],
): InputDeviceResult {
	const opts: InputDeviceOption[] = [
		{
			icon: inputDefaultIcon(defaultDeviceName),
			id: "default",
			label: defaultLabel,
		},
	];
	const selectedName = resolveSelectedName(devices, inputDeviceIndex);
	opts.push(
		...sortOptionsByPriority(
			dedupeDevicesByName(devices, inputDeviceIndex, selectedName),
			inputDevicePriority,
		),
	);

	// EXACTLY ONE row is marked selected: the device the recorder will actually
	// open, mirroring the backend chain (priority top-connected → explicit
	// index → OS default). Deriving it here — instead of trusting the persisted
	// index — means a picker can never show a "selected" device that a
	// higher-priority connected device would beat at recording time.
	const priorityDevice = resolveEffectivePriorityDevice(
		devices,
		inputDevicePriority,
	);
	let currentDeviceId: string;
	if (priorityDevice) {
		// Look the row up by NAME: the dedup id can be the user's persisted
		// index rather than the enumeration index for the same physical mic.
		const key = deviceNameKey(priorityDevice.name);
		currentDeviceId =
			opts.find((o) => o.id !== "default" && deviceNameKey(o.label) === key)
				?.id ?? "default";
	} else {
		currentDeviceId =
			inputDeviceIndex == null ? "default" : String(inputDeviceIndex);
	}
	const found = opts.find((o) => o.id === currentDeviceId);
	return {
		deviceOptions: opts,
		currentDeviceId,
		currentDeviceLabel: found?.label ?? defaultLabel,
	};
}
