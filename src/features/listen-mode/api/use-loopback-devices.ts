import { ComputerIcon, VolumeHighIcon } from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "@/entities/setting";
import { loopbackListDevices } from "@/shared/api/ipc-client";
import type { SelectOption } from "@/shared/ui/select";
import {
	type LoopbackDevice,
	parseLoopbackDevices,
} from "../lib/loopback-devices";

/**
 * Fetches loopback audio devices via IPC when in "listen" recording mode,
 * maps them to select options, and resolves the current selection ID.
 */
interface UseLoopbackDevicesReturn {
	currentId: string;
	handleChange: (v: string) => void;
	options: SelectOption[];
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
		const typed = parseLoopbackDevices(devices);
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

	// Latest selected-device index read through a ref so the device-list fetch
	// keys only on ENTERING "listen" mode — not on every selection change (which
	// would needlessly re-list devices, and re-trigger auto-select). The one-time
	// auto-select is the sole reader, and it wants the value at fetch time.
	const loopbackDeviceIndexRef = useRef(general?.loopbackDeviceIndex ?? null);
	useEffect(() => {
		loopbackDeviceIndexRef.current = general?.loopbackDeviceIndex ?? null;
	});

	useEffect(() => {
		if (recordingMode !== "listen") {
			return;
		}

		let isCancelled = false;

		const handleDevices = applyDevicesResult({
			getIsCancelled: () => isCancelled,
			currentDeviceIndex: loopbackDeviceIndexRef.current,
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
		// react-doctor-disable-next-line react-doctor/exhaustive-deps -- `loopbackDeviceIndexRef.current` is read as a deliberate fresh snapshot: the companion no-dep effect above re-syncs the ref on every render, so it holds the current selection when this effect runs on entry to "listen" mode. The auto-select wants the value at device-list time; depending on `general.loopbackDeviceIndex` directly (the only "missing" reactive value) would re-list devices and re-run auto-select on every manual selection change — exactly what the ref exists to prevent.
	}, [recordingMode, update]);

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
