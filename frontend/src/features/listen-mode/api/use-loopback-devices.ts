"use client";

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

function parseDevices(devices: unknown): LoopbackDevice[] {
	if (!Array.isArray(devices)) {
		return [];
	}
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
	const defaultLabel = defaultDev ? `System Default (${defaultDev.name})` : "System Default";
	const defaultIndex = defaultDev?.index ?? null;
	const options: SelectOption[] = [
		{ id: "default", label: defaultLabel },
		...typed.map((d) => ({ id: String(d.index), label: d.name })),
	];
	return { options, defaultIndex };
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

		const handleDevices = (devices: unknown) => {
			if (isCancelled) {
				return;
			}
			if (!Array.isArray(devices)) {
				console.warn("[useLoopbackDevices] Invalid devices response:", devices);
				return;
			}
			const typed = parseDevices(devices);
			const { options: opts, defaultIndex: defIdx } = buildLoopbackOptions(typed);
			setDefaultIndex(defIdx);
			setOptions(opts);
			if (general?.loopbackDeviceIndex == null && defIdx != null) {
				update({ loopbackDeviceIndex: defIdx });
			}
		};

		loopbackListDevices()
			.then(handleDevices)
			.catch((err: unknown) => {
				if (isCancelled) {
					return;
				}
				console.error("[useLoopbackDevices] Failed to fetch loopback devices:", err);
			});

		return () => {
			isCancelled = true;
		};
	}, [recordingMode, general?.loopbackDeviceIndex, update]);

	const currentId =
		general?.loopbackDeviceIndex == null || general.loopbackDeviceIndex === defaultIndex
			? "default"
			: String(general.loopbackDeviceIndex);

	const handleChange = (v: string) => {
		update({
			loopbackDeviceIndex: v === "default" ? defaultIndex : Number(v),
		});
	};

	return { options, currentId, handleChange };
}
