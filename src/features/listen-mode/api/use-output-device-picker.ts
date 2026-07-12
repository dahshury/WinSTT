import { useEffect, useState } from "react";
import { type OutputDevice, useOutputDevices } from "@/entities/audio-device";
import { useSettingsStore } from "@/entities/setting";
import { loopbackListDevices } from "@/shared/api/ipc-client";
import { fireAndForget } from "@/shared/lib/fire-and-forget";
import {
	type LoopbackDevice,
	loopbackIndexForName,
	parseLoopbackDevices,
} from "../lib/loopback-devices";

/**
 * One selectable output device, denormalized so the picker UI can render it
 * without knowing about either source list.
 *
 * `id` is the browser `MediaDeviceInfo.deviceId` (a sink id usable with
 * `setSinkId` for playback preview), or `""` for the synthetic "System default"
 * row — it matches the value persisted as `settings.general.outputDeviceId`, so
 * the Settings Output-tab `Select` and this picker stay interchangeable.
 *
 * `loopbackIndex` is the positional WASAPI render-endpoint index the backend's
 * `loopback:start` needs — resolved by NAME against the loopback enumeration so
 * it is stable across windows (unlike the browser sink id). `null` means "no
 * matching loopback device", i.e. fall back to the system-default loopback.
 */
export interface OutputDeviceEntry {
	id: string;
	isDefault: boolean;
	label: string;
	loopbackIndex: number | null;
}

interface UseOutputDevicePickerOptions {
	/** Localized "System default" label (e.g. `t("systemDefault")`). */
	systemDefaultLabel: string;
}

/**
 * Build the selectable device list ("System default" first) from the browser
 * output list + the backend loopback enumeration. Pure — extracted so the
 * source-list → entries mapping (including the by-name loopback-index resolution)
 * is unit-testable without rendering the hook.
 */
export function buildOutputDeviceEntries(params: {
	devices: readonly OutputDevice[];
	defaultDevice: OutputDevice | null;
	loopbackDevices: readonly LoopbackDevice[];
	systemDefaultLabel: string;
}): OutputDeviceEntry[] {
	const { devices, defaultDevice, loopbackDevices, systemDefaultLabel } =
		params;
	const defaultLabel = defaultDevice
		? `${systemDefaultLabel} (${defaultDevice.label})`
		: systemDefaultLabel;
	const entries: OutputDeviceEntry[] = [
		{ id: "", isDefault: true, label: defaultLabel, loopbackIndex: null },
	];
	for (const device of devices) {
		// Skip Chromium's synthetic `default` / `communications` rows and the
		// empty-id placeholder — the leading entry already covers "System default".
		if (device.deviceId === "default" || device.deviceId === "") {
			continue;
		}
		entries.push({
			id: device.deviceId,
			isDefault: false,
			label: device.label,
			loopbackIndex: loopbackIndexForName(loopbackDevices, device.label),
		});
	}
	return entries;
}

/**
 * The settings patch for selecting entry `id`: BOTH the browser sink id
 * (playback routing) and the resolved loopback index (the deterministic listen
 * device). Writing both is what keeps the footer picker, the Output tab, and the
 * actually-listened device in sync. Pure — extracted for testability.
 */
export function outputSelectionPatch(
	entries: readonly OutputDeviceEntry[],
	id: string,
): { loopbackDeviceIndex: number | null; outputDeviceId: string } {
	const entry = entries.find((candidate) => candidate.id === id);
	return {
		outputDeviceId: id,
		loopbackDeviceIndex: entry?.loopbackIndex ?? null,
	};
}

interface UseOutputDevicePickerResult {
	/** The full device list, "System default" first. */
	entries: OutputDeviceEntry[];
	/** Currently-selected entry id — `settings.general.outputDeviceId`, reconciled
	 *  against `loopbackDeviceIndex` so a picker window that can't resolve browser
	 *  sink ids still highlights the active device. */
	currentId: string;
	/** Persist a selection: writes BOTH the browser sink id (playback routing) and
	 *  the resolved loopback index (the deterministic listen device) so the footer
	 *  picker, the Output tab, and the actually-listened device stay in sync. Async
	 *  because it may resolve the loopback index on demand (see the impl). */
	select: (id: string) => Promise<void>;
}

/**
 * Unifies the two output-device representations — the browser sink list (for
 * `setSinkId` playback) and the backend loopback list (for listen-mode capture)
 * — into one selectable model, and persists a pick to both settings at once.
 *
 * Shared by the Settings → Output device `Select` and the detached footer
 * output-device picker so a device chosen in either place drives listen mode AND
 * playback routing identically. This is what makes "changing the output device"
 * actually re-target the loopback capture (and update the footer pill): the
 * deterministic `loopbackDeviceIndex` is written alongside the browser sink id,
 * and listen mode prefers it when valid.
 */
export function useOutputDevicePicker({
	systemDefaultLabel,
}: UseOutputDevicePickerOptions): UseOutputDevicePickerResult {
	const { devices, defaultDevice } = useOutputDevices();
	const outputDeviceId = useSettingsStore(
		(s) => s.settings.general?.outputDeviceId ?? "",
	);
	const loopbackDeviceIndex = useSettingsStore(
		(s) => s.settings.general?.loopbackDeviceIndex ?? null,
	);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const [loopbackDevices, setLoopbackDevices] = useState<LoopbackDevice[]>([]);

	// Re-fetch the loopback enumeration whenever the browser output list changes
	// (hot-plug) so a newly-connected speaker resolves to a real loopback index.
	// Returns [] on non-Windows / failure — the entries then carry a null index
	// and listen mode degrades to the system-default loopback.
	useEffect(() => {
		let cancelled = false;
		fireAndForget(
			loopbackListDevices()
				.then((raw) => {
					if (cancelled || !Array.isArray(raw)) {
						return;
					}
					setLoopbackDevices(parseLoopbackDevices(raw));
				})
				.catch(() => {
					// Non-Windows / enumeration failure: leave the list empty.
				}),
			"useOutputDevicePicker.listLoopback",
		);
		return () => {
			cancelled = true;
		};
	}, [devices]);

	const entries = buildOutputDeviceEntries({
		devices,
		defaultDevice,
		loopbackDevices,
		systemDefaultLabel,
	});

	const currentId = resolveCurrentId(
		entries,
		outputDeviceId,
		loopbackDeviceIndex,
	);

	const select = async (id: string): Promise<void> => {
		const entry = entries.find((candidate) => candidate.id === id);
		// A non-default device whose loopback index hasn't resolved yet: the picker
		// body mounts on open and fetches the loopback list asynchronously, so a
		// fast click can land before it arrives. Resolve the index FRESHLY here (by
		// the device's stable name) so listen mode always gets a deterministic,
		// valid device to re-target to — writing a null index would silently fall
		// back to the system-default loopback, which is exactly the "sometimes it
		// switches, sometimes it doesn't" flakiness.
		if (entry && !entry.isDefault && entry.loopbackIndex == null) {
			const raw = await loopbackListDevices().catch(() => null);
			const loopbackIndex = Array.isArray(raw)
				? loopbackIndexForName(parseLoopbackDevices(raw), entry.label)
				: null;
			updateGeneral({ outputDeviceId: id, loopbackDeviceIndex: loopbackIndex });
			return;
		}
		updateGeneral(outputSelectionPatch(entries, id));
	};

	return { entries, currentId, select };
}

/**
 * Which entry is "current". Prefers the persisted browser sink id (so the
 * Settings window, which enumerated it, highlights exactly what it wrote); falls
 * back to matching the persisted loopback index (so a window that CAN'T resolve
 * browser sink ids — e.g. the detached picker with no mic permission — still
 * highlights the active device); otherwise the "System default" row.
 */
export function resolveCurrentId(
	entries: readonly OutputDeviceEntry[],
	outputDeviceId: string,
	loopbackDeviceIndex: number | null,
): string {
	if (outputDeviceId && entries.some((entry) => entry.id === outputDeviceId)) {
		return outputDeviceId;
	}
	if (loopbackDeviceIndex != null) {
		const byLoopback = entries.find(
			(entry) => entry.loopbackIndex === loopbackDeviceIndex,
		);
		if (byLoopback) {
			return byLoopback.id;
		}
	}
	return "";
}
