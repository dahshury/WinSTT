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
