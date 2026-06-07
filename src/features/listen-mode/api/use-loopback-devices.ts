import { ComputerIcon, VolumeHighIcon } from "@hugeicons/core-free-icons";
import { useEffect, useState } from "react";
import { z } from "zod";
import { useSettingsStore } from "@/entities/setting";
import { loopbackListDevices } from "@/shared/api/ipc-client";
import type { SelectOption } from "@/shared/ui/select";

const loopbackDeviceSchema = z.object({
	index: z.number().int(),
	name: z.string(),
	defaultSampleRate: z.number(),
	maxOutputChannels: z.number(),
	isDefault: z.boolean().optional(),
});

type LoopbackDevice = z.infer<typeof loopbackDeviceSchema>;

/**
 * Fetches loopback audio devices via IPC when in "listen" recording mode,
 * maps them to select options, and resolves the current selection ID.
 */
interface UseLoopbackDevicesReturn {
	currentId: string;
	handleChange: (v: string) => void;
	options: SelectOption[];
}

function parseDevices(devices: readonly unknown[]): LoopbackDevice[] {
	const typed: LoopbackDevice[] = [];
	for (const d of devices) {
		const parsed = loopbackDeviceSchema.safeParse(d);
		if (parsed.success) {
			typed.push(parsed.data);
		}
	}
	return typed;
}

function buildLoopbackOptions(typed: LoopbackDevice[]): {
	options: SelectOption[];
	defaultIndex: number | null;
} {
	const defaultDev = typed.find((d) => d.isDefault);
	const defaultLabel = defaultDev
		? `System Default (${defaultDev.name})`
		: "System Default";
	const defaultIndex = defaultDev?.index ?? null;
	const options: SelectOption[] = [
		{ id: "default", label: defaultLabel, icon: ComputerIcon },
		...typed.map((d) => ({
			id: String(d.index),
			label: d.name,
			icon: VolumeHighIcon,
		})),
	];
	return { options, defaultIndex };
}

interface ApplyDevicesParams {
	currentDeviceIndex: number | null;
	getIsCancelled: () => boolean;
	setDefaultIndex: (idx: number | null) => void;
	setOptions: (opts: SelectOption[]) => void;
	update: (patch: { loopbackDeviceIndex: number | null }) => void;
}

function maybeAutoSelect(
	params: ApplyDevicesParams,
	defIdx: number | null,
): void {
	if (params.currentDeviceIndex == null && defIdx != null) {
		params.update({ loopbackDeviceIndex: defIdx });
	}
}

/**
 * Returns a handler function that processes a raw device list response and
 * updates component state. Extracted for unit testability.
 */
export function applyDevicesResult(params: ApplyDevicesParams) {
	return (devices: unknown) => {
		if (params.getIsCancelled()) {
			return;
		}
		if (!Array.isArray(devices)) {
			console.warn("[useLoopbackDevices] Invalid devices response:", devices);
			return;
		}
		const typed = parseDevices(devices);
		const { options: opts, defaultIndex: defIdx } = buildLoopbackOptions(typed);
		params.setDefaultIndex(defIdx);
		params.setOptions(opts);
		maybeAutoSelect(params, defIdx);
	};
}

/**
 * Builds the catch callback for the loopback devices fetch. Skips logging
 * when the effect was already torn down. Extracted for unit testability.
 */
export function handleFetchError(getIsCancelled: () => boolean) {
	return (err: unknown) => {
		if (getIsCancelled()) {
			return;
		}
		console.error(
			"[useLoopbackDevices] Failed to fetch loopback devices:",
			err,
		);
	};
}

/**
 * Resolves the select's current id from the stored loopback index and the
 * detected system default. Extracted for unit testability.
 */
export function resolveCurrentId(
	loopbackDeviceIndex: number | null | undefined,
	defaultIndex: number | null,
): string {
	if (loopbackDeviceIndex == null || loopbackDeviceIndex === defaultIndex) {
		return "default";
	}
	return String(loopbackDeviceIndex);
}

export function useLoopbackDevices(): UseLoopbackDevicesReturn {
	const general = useSettingsStore((s) => s.settings.general);
	const update = useSettingsStore((s) => s.updateGeneralSettings);
	const [options, setOptions] = useState<SelectOption[]>([]);
	const [defaultIndex, setDefaultIndex] = useState<number | null>(null);

	const recordingMode = general?.recordingMode ?? "ptt";

	useEffect(() => {
		if (recordingMode !== "listen") {
			return;
		}

		let isCancelled = false;

		const handleDevices = applyDevicesResult({
			getIsCancelled: () => isCancelled,
			currentDeviceIndex: general?.loopbackDeviceIndex ?? null,
			setDefaultIndex,
			setOptions,
			update,
		});

		loopbackListDevices()
			.then(handleDevices)
			.catch(handleFetchError(() => isCancelled));

		return () => {
			isCancelled = true;
		};
	}, [recordingMode, general?.loopbackDeviceIndex, update]);

	const currentId = resolveCurrentId(
		general?.loopbackDeviceIndex,
		defaultIndex,
	);

	const handleChange = (v: string) => {
		update({
			loopbackDeviceIndex: v === "default" ? defaultIndex : Number(v),
		});
	};

	return { options, currentId, handleChange };
}
