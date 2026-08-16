import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type OutputDevice, useOutputDevices } from "@/entities/audio-device";
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
import {
	type LoopbackDevice,
	parseLoopbackDevices,
} from "../lib/loopback-devices";
import { resolveListenStreamingModelId } from "../lib/listen-mode-model-gate";
import { useListenStore } from "../model/listen-store";

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
 * device, listen model, or the mic-mix toggle changes. Extracted for
 * testability.
 */
export function applyLoopbackTransition(
	recordingMode: string,
	wasListen: boolean,
	loopbackDeviceIndex: number | null,
	listenModelId: string | null,
	previousLoopbackDeviceIndex: number | null = null,
	previousListenModelId: string | null = null,
	captureMicrophone = false,
	previousCaptureMicrophone: boolean | null = null,
): void {
	if (shouldStartLoopback(recordingMode, loopbackDeviceIndex, listenModelId)) {
		const modelId = listenModelId;
		if (modelId === null) {
			return;
		}
		const shouldRestart =
			wasListen &&
			(previousLoopbackDeviceIndex !== loopbackDeviceIndex ||
				previousListenModelId !== modelId ||
				(previousCaptureMicrophone !== null &&
					previousCaptureMicrophone !== captureMicrophone));
		if (!wasListen || shouldRestart) {
			if (shouldRestart) {
				loopbackStop();
			}
			void loopbackStart(loopbackDeviceIndex, modelId, captureMicrophone).catch(
				(err: unknown) => {
					console.error("[useListenMode] Failed to start loopback:", err);
				},
			);
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
	const captureMicrophone = useSettingsStore(
		(s) => s.settings.general?.listenCaptureMicrophone ?? false,
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
	const prevCaptureMicrophoneRef = useRef<boolean | null>(captureMicrophone);
	const lastNonListenModeRef = useRef<RecordingMode>("ptt");
	const transcriptModeRef = useRef<string | null>(null);
	// Read inside the loopback-event handlers below, which are subscribed once
	// on mount (stable `[setListening]` deps) and would otherwise close over a
	// stale `recordingMode` from that first render forever.
	const recordingModeRef = useRef<RecordingMode>(recordingMode);
	useEffect(() => {
		recordingModeRef.current = recordingMode;
	}, [recordingMode]);

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
		if (!(catalogLoaded && modelStatesLoaded) || listenModelId !== null) {
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

	useEffect(() => {
		const unsubStarted = onLoopbackStarted((deviceName) => {
			setListening(true, deviceName);
		});
		const unsubStopped = onLoopbackStopped(() => {
			setListening(false);
			// A stopped event while `recordingMode` is still "listen" is a live
			// restart (the start/stop effect below dropping + relaunching the
			// same session on a device/model change) -- preserve the continuous
			// subtitle feed instead of resetting it out from under an in-flight
			// listen session (see "loopback lifecycle preserves listen captions"
			// below). Only reconcile the transcription store's per-session state
			// (isRecordingActive, realtime text, ephemeral status) once the mode
			// has genuinely left listen, so a loopback teardown that outraces the
			// mode-boundary effect above still clears the stale pill/session
			// state. Harmlessly idempotent alongside that effect and the
			// backend's own mode-exit teardown.
			//
			// NB: `prevModeRef` deliberately isn't touched here anymore -- it
			// used to be nulled on every stopped event, which raced with the
			// start/stop effect below: a stray/duplicate stopped event arriving
			// between a real mode switch and that effect's next run made
			// `wasListen` read back `false`, so `shouldStopLoopback` skipped
			// calling `loopbackStop()` and the backend loopback kept running
			// after switching away from listen mode. `prevModeRef` now purely
			// tracks the last observed `recordingMode`, which is what it's
			// actually used for.
			if (recordingModeRef.current !== "listen") {
				clearTranscription();
			}
		});
		return () => {
			unsubStarted();
			unsubStopped();
		};
	}, [setListening, clearTranscription]);

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
					const valid = parseLoopbackDevices(devices);
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
		const previousCaptureMicrophone = prevCaptureMicrophoneRef.current;
		applyLoopbackTransition(
			recordingMode,
			wasListen,
			loopbackDeviceIndex,
			listenModelId,
			previousLoopbackDeviceIndex,
			previousListenModelId,
			captureMicrophone,
			previousCaptureMicrophone,
		);
		prevModeRef.current = recordingMode;
		prevLoopbackDeviceIndexRef.current = loopbackDeviceIndex;
		prevListenModelIdRef.current = listenModelId;
		prevCaptureMicrophoneRef.current = captureMicrophone;
	}, [
		onboarded,
		onboardedAt,
		recordingMode,
		loopbackDeviceIndex,
		listenModelId,
		captureMicrophone,
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
