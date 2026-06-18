import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import { useOutputDevices, type OutputDevice } from "@/entities/audio-device";
import { useCatalogStore, useModelStateStore } from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import type { RecordingMode } from "@/shared/config/recording-mode-color";
import {
	loopbackListDevices,
	loopbackStart,
	loopbackStop,
	onLoopbackStarted,
	onLoopbackStopped,
} from "@/shared/api/ipc-client";
import { resolveListenStreamingModelId } from "../lib/listen-mode-model-gate";
import { useListenStore } from "../model/listen-store";

const loopbackDeviceSchema = z.object({
	id: z.string().optional(),
	index: z.number().int(),
	name: z.string(),
	defaultSampleRate: z.number(),
	maxOutputChannels: z.number(),
	isDefault: z.boolean().optional(),
});

type ParsedLoopbackDevice = z.infer<typeof loopbackDeviceSchema>;

interface LoopbackDevice {
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
 * Exported for unit testing.
 */
export function validateDevices(raw: unknown[]): LoopbackDevice[] {
	const valid: LoopbackDevice[] = [];
	for (const d of raw) {
		const parsed = loopbackDeviceSchema.safeParse(d);
		if (parsed.success) {
			valid.push(normalizeParsedLoopbackDevice(parsed.data));
		}
	}
	return valid;
}

function shouldStartLoopback(
	recordingMode: string,
	loopbackDeviceIndex: number | null,
	listenModelId: string | null,
): loopbackDeviceIndex is number {
	return (
		recordingMode === "listen" &&
		loopbackDeviceIndex != null &&
		listenModelId != null
	);
}

function shouldStopLoopback(
	recordingMode: string,
	wasListen: boolean,
): boolean {
	return wasListen && recordingMode !== "listen";
}

/**
 * Applies loopback start/stop side effects when recording mode, selected output
 * device, or listen model changes. Extracted for testability.
 */
export function applyLoopbackTransition(
	recordingMode: string,
	wasListen: boolean,
	loopbackDeviceIndex: number | null,
	listenModelId: string | null,
	previousLoopbackDeviceIndex: number | null = null,
	previousListenModelId: string | null = null,
): void {
	if (shouldStartLoopback(recordingMode, loopbackDeviceIndex, listenModelId)) {
		const modelId = listenModelId;
		if (modelId === null) {
			return;
		}
		const shouldRestart =
			wasListen &&
			(previousLoopbackDeviceIndex !== loopbackDeviceIndex ||
				previousListenModelId !== modelId);
		if (!wasListen || shouldRestart) {
			if (shouldRestart) {
				loopbackStop();
			}
			void loopbackStart(loopbackDeviceIndex, modelId).catch((err: unknown) => {
				console.error("[useListenMode] Failed to start loopback:", err);
			});
		}
	} else if (shouldStopLoopback(recordingMode, wasListen)) {
		loopbackStop();
	} else if (
		recordingMode === "listen" &&
		wasListen &&
		previousLoopbackDeviceIndex != null &&
		previousListenModelId != null
	) {
		loopbackStop();
	}
}

/**
 * Logs a loopback device-list fetch failure unless the effect was cancelled.
 * Extracted for testability — keeps the `.catch()` closure trivial.
 */
export function handleLoopbackListError(
	err: unknown,
	isCancelled: boolean,
): void {
	if (isCancelled) {
		return;
	}
	console.error("[useListenMode] Failed to fetch loopback devices:", err);
}

function normalizeDeviceName(name: string): string {
	return name.trim().toLowerCase();
}

function defaultLoopbackIndex(
	devices: readonly LoopbackDevice[],
): number | null {
	return (
		devices.find((device) => device.isDefault)?.index ??
		devices[0]?.index ??
		null
	);
}

function findSelectedOutputDevice(
	outputDevices: readonly OutputDevice[],
	outputDeviceId: string,
): OutputDevice | null {
	if (!outputDeviceId) {
		return outputDevices.find((device) => device.isDefault) ?? null;
	}
	return (
		outputDevices.find((device) => device.deviceId === outputDeviceId) ??
		outputDevices.find((device) => device.label === outputDeviceId) ??
		null
	);
}

export function resolveOutputLoopbackDeviceIndex(
	loopbackDevices: readonly LoopbackDevice[],
	outputDevices: readonly OutputDevice[],
	outputDeviceId: string,
): number | null {
	if (loopbackDevices.length === 0) {
		return null;
	}
	if (!outputDeviceId) {
		return defaultLoopbackIndex(loopbackDevices);
	}
	const outputDevice = findSelectedOutputDevice(outputDevices, outputDeviceId);
	const targetName = outputDevice?.label ?? outputDeviceId;
	const normalizedTarget = normalizeDeviceName(targetName);
	const exact = loopbackDevices.find(
		(device) => normalizeDeviceName(device.name) === normalizedTarget,
	);
	if (exact) {
		return exact.index;
	}
	const fuzzy = loopbackDevices.find((device) => {
		const normalized = normalizeDeviceName(device.name);
		return (
			normalized.includes(normalizedTarget) ||
			normalizedTarget.includes(normalized)
		);
	});
	return fuzzy?.index ?? defaultLoopbackIndex(loopbackDevices);
}

export function resolveListenLoopbackDeviceIndex(
	loopbackDevices: readonly LoopbackDevice[],
	outputDevices: readonly OutputDevice[],
	outputDeviceId: string,
	selectedLoopbackDeviceIndex: number | null | undefined,
): number | null {
	if (loopbackDevices.length === 0) {
		return null;
	}
	if (
		selectedLoopbackDeviceIndex != null &&
		loopbackDevices.some(
			(device) => device.index === selectedLoopbackDeviceIndex,
		)
	) {
		return selectedLoopbackDeviceIndex;
	}
	return resolveOutputLoopbackDeviceIndex(
		loopbackDevices,
		outputDevices,
		outputDeviceId,
	);
}

export function useListenMode(): void {
	const recordingMode = useSettingsStore(
		(s) => s.settings.general?.recordingMode ?? "ptt",
	);
	const outputDeviceId = useSettingsStore(
		(s) => s.settings.general?.outputDeviceId ?? "",
	);
	const selectedLoopbackDeviceIndex = useSettingsStore(
		(s) => s.settings.general?.loopbackDeviceIndex ?? null,
	);
	const onboarded = useSettingsStore(
		(s) => s.settings.general?.onboarded ?? false,
	);
	const onboardedAt = useSettingsStore(
		(s) => s.settings.general?.onboardedAt ?? null,
	);
	const modelSettings = useSettingsStore((s) => s.settings.model);
	const qualitySettings = useSettingsStore((s) => s.settings.quality);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const catalogModels = useCatalogStore((s) => s.models);
	const catalogLoaded = useCatalogStore((s) => s.isLoaded);
	const statesById = useModelStateStore((s) => s.statesById);
	const modelStatesLoaded = useModelStateStore((s) => s.isLoaded);
	const refreshModelState = useModelStateStore((s) => s.refresh);
	const { devices: outputDevices } = useOutputDevices();
	const setListening = useListenStore((s) => s.setListening);
	const setDevices = useListenStore((s) => s.setDevices);
	const clearTranscription = useTranscriptionStore((s) => s.clearAll);
	const [loopbackDevices, setLoopbackDevices] = useState<LoopbackDevice[]>([]);
	const listenModelId = resolveListenStreamingModelId(
		modelSettings,
		qualitySettings,
		catalogModels,
		statesById,
	);
	const loopbackDeviceIndex = resolveListenLoopbackDeviceIndex(
		loopbackDevices,
		outputDevices,
		outputDeviceId,
		selectedLoopbackDeviceIndex,
	);
	const prevModeRef = useRef<RecordingMode | null>(null);
	const prevLoopbackDeviceIndexRef = useRef<number | null>(loopbackDeviceIndex);
	const prevListenModelIdRef = useRef<string | null>(listenModelId);
	const lastNonListenModeRef = useRef<RecordingMode>("ptt");
	const transcriptModeRef = useRef<string | null>(null);

	// Listen mode owns a continuous subtitle feed. Clear it at mode boundaries
	// so captions from a previous PTT/toggle dictation cannot become the first
	// lines in listen mode, and listen-mode scrollback does not leak back out.
	useLayoutEffect(() => {
		const previousMode = transcriptModeRef.current;
		const enteringListen =
			recordingMode === "listen" && previousMode !== "listen";
		const leavingListen =
			previousMode === "listen" && recordingMode !== "listen";
		if (enteringListen || leavingListen) {
			clearTranscription();
		}
		transcriptModeRef.current = recordingMode;
	}, [recordingMode, clearTranscription]);

	useEffect(() => {
		if (onboarded && recordingMode === "listen") {
			void refreshModelState();
		}
	}, [onboarded, recordingMode, refreshModelState]);

	useLayoutEffect(() => {
		if (!onboarded) {
			return;
		}
		if (recordingMode !== "listen") {
			lastNonListenModeRef.current = recordingMode;
			return;
		}
		if (!catalogLoaded || !modelStatesLoaded || listenModelId !== null) {
			return;
		}
		updateGeneral({ recordingMode: lastNonListenModeRef.current });
	}, [
		catalogLoaded,
		listenModelId,
		modelStatesLoaded,
		onboarded,
		recordingMode,
		updateGeneral,
	]);

	// Subscribe to loopback events from main process
	useEffect(() => {
		const unsubStarted = onLoopbackStarted((deviceName) => {
			setListening(true, deviceName);
		});
		const unsubStopped = onLoopbackStopped(() => {
			prevModeRef.current = null;
			setListening(false);
		});
		return () => {
			unsubStarted();
			unsubStopped();
		};
	}, [setListening]);

	// Fetch loopback devices when in listen mode. Tauri owns backend readiness;
	// the legacy connection flag is only a display concern in this port.
	useEffect(() => {
		if (!onboarded || recordingMode !== "listen") {
			return;
		}

		let isCancelled = false;

		loopbackListDevices()
			.then((devices) => {
				if (isCancelled) {
					return;
				}
				if (Array.isArray(devices)) {
					const valid = validateDevices(devices);
					setLoopbackDevices(valid);
					setDevices(valid);
				} else {
					console.warn("[useListenMode] Invalid devices response:", devices);
				}
			})
			.catch((err: unknown) => handleLoopbackListError(err, isCancelled));

		return () => {
			isCancelled = true;
		};
	}, [onboarded, recordingMode, setDevices]);

	// Start/stop loopback when mode or device changes
	useEffect(() => {
		if (!onboarded) {
			return;
		}
		const wasListen = prevModeRef.current === "listen";
		const previousLoopbackDeviceIndex = prevLoopbackDeviceIndexRef.current;
		const previousListenModelId = prevListenModelIdRef.current;
		applyLoopbackTransition(
			recordingMode,
			wasListen,
			loopbackDeviceIndex,
			listenModelId,
			previousLoopbackDeviceIndex,
			previousListenModelId,
		);
		prevModeRef.current = recordingMode;
		prevLoopbackDeviceIndexRef.current = loopbackDeviceIndex;
		prevListenModelIdRef.current = listenModelId;
	}, [
		onboarded,
		onboardedAt,
		recordingMode,
		loopbackDeviceIndex,
		listenModelId,
	]);

	// Stop loopback on unmount if active
	useEffect(
		() => () => {
			if (prevModeRef.current === "listen") {
				loopbackStop();
			}
		},
		[],
	);
}
