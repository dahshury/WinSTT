import { z } from "zod";

/**
 * Canonical schema + parser for the loopback device list returned by the
 * `loopbackListDevices()` IPC call. Shared by use-listen-mode, use-loopback-devices
 * and listen-store so the shape and validation live in one place.
 */
const loopbackDeviceSchema = z.object({
	id: z.string().optional(),
	index: z.number().int(),
	name: z.string(),
	defaultSampleRate: z.number(),
	maxOutputChannels: z.number(),
	isDefault: z.boolean().optional(),
});

type ParsedLoopbackDevice = z.infer<typeof loopbackDeviceSchema>;

export interface LoopbackDevice {
	defaultSampleRate: number;
	id?: string;
	index: number;
	isDefault?: boolean;
	maxOutputChannels: number;
	name: string;
}

function normalizeParsedLoopbackDevice(
	parsed: ParsedLoopbackDevice,
): LoopbackDevice {
	const device: LoopbackDevice = {
		index: parsed.index,
		name: parsed.name,
		defaultSampleRate: parsed.defaultSampleRate,
		maxOutputChannels: parsed.maxOutputChannels,
	};
	if (parsed.id !== undefined) {
		device.id = parsed.id;
	}
	if (parsed.isDefault !== undefined) {
		device.isDefault = parsed.isDefault;
	}
	return device;
}

/**
 * Validates a raw device list via Zod and returns only the valid entries.
 */
export function parseLoopbackDevices(
	raw: readonly unknown[],
): LoopbackDevice[] {
	const valid: LoopbackDevice[] = [];
	for (const d of raw) {
		const parsed = loopbackDeviceSchema.safeParse(d);
		if (parsed.success) {
			valid.push(normalizeParsedLoopbackDevice(parsed.data));
		}
	}
	return valid;
}

function normalizeDeviceName(name: string): string {
	return name.trim().toLowerCase();
}

/**
 * Resolve an OUTPUT device (as shown in the picker, keyed by its cpal/browser
 * display name) to the positional loopback `index` the backend's `loopback:start`
 * needs. Exact normalized-name match first, then a contains-match for the minor
 * framing differences between cpal names and WASAPI render-endpoint names. Returns
 * `null` when no loopback device corresponds — the caller then persists `null`
 * (the "system default loopback" sentinel), so listen mode falls back gracefully.
 *
 * This is the deterministic, backend-resolvable half of an output-device
 * selection: the browser `sinkId` (persisted alongside as `outputDeviceId`) only
 * ever resolves inside the window that enumerated it, whereas this index is
 * enumerated by Rust and is stable across every window. See
 * `resolveOutputLoopbackDeviceIndex` for the runtime read-side of the same match.
 */
export function loopbackIndexForName(
	loopbackDevices: readonly LoopbackDevice[],
	name: string,
): number | null {
	const target = normalizeDeviceName(name);
	if (!target) {
		return null;
	}
	const exact = loopbackDevices.find(
		(device) => normalizeDeviceName(device.name) === target,
	);
	if (exact) {
		return exact.index;
	}
	const fuzzy = loopbackDevices.find((device) => {
		const normalized = normalizeDeviceName(device.name);
		return normalized.includes(target) || target.includes(normalized);
	});
	return fuzzy?.index ?? null;
}
