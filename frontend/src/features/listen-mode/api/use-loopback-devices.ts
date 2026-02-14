"use client";

import { useEffect, useState } from "react";
import { useSettingsStore } from "@/features/update-settings";
import { loopbackListDevices } from "@/shared/api/ipc-client";
import type { SelectOption } from "@/shared/ui/select";

interface LoopbackDevice {
	index: number;
	name: string;
	defaultSampleRate: number;
	maxOutputChannels: number;
	isDefault?: boolean;
}

/**
 * Fetches loopback audio devices via IPC when in "listen" recording mode,
 * maps them to select options, and resolves the current selection ID.
 */
export function useLoopbackDevices() {
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

		loopbackListDevices()
			.then((devices) => {
				if (isCancelled) {
					return;
				}

				if (!Array.isArray(devices)) {
					console.warn("[useLoopbackDevices] Invalid devices response:", devices);
					return;
				}
				const typed = devices as LoopbackDevice[];
				const defaultDev = typed.find((d) => d.isDefault);
				const defaultLabel = defaultDev ? `System Default (${defaultDev.name})` : "System Default";
				const defIdx = defaultDev?.index ?? null;
				setDefaultIndex(defIdx);

				const opts: SelectOption[] = [
					{ id: "default", label: defaultLabel },
					...typed.map((d) => ({ id: String(d.index), label: d.name })),
				];
				setOptions(opts);

				// Auto-select default device if none chosen yet
				if (general?.loopbackDeviceIndex == null && defIdx != null) {
					update({ loopbackDeviceIndex: defIdx });
				}
			})
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
