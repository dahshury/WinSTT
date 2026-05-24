import { useEffect, useRef } from "react";
import { z } from "zod";
import { useConnectionStore } from "@/entities/connection";
import { useSettingsStore } from "@/entities/setting";
import {
	loopbackListDevices,
	loopbackStart,
	loopbackStop,
	onLoopbackStarted,
	onLoopbackStopped,
} from "@/shared/api/ipc-client";
import { useListenStore } from "../model/listen-store";

const loopbackDeviceSchema = z.object({
	index: z.number().int(),
	name: z.string(),
	defaultSampleRate: z.number(),
	maxOutputChannels: z.number(),
});

type LoopbackDevice = z.infer<typeof loopbackDeviceSchema>;

/**
 * Validates a raw device list via Zod and returns only the valid entries.
 * Exported for unit testing.
 */
export function validateDevices(raw: unknown[]): LoopbackDevice[] {
	const valid: LoopbackDevice[] = [];
	for (const d of raw) {
		const parsed = loopbackDeviceSchema.safeParse(d);
		if (parsed.success) {
			valid.push(parsed.data);
		}
	}
	return valid;
}

function shouldStartLoopback(
	recordingMode: string,
	loopbackDeviceIndex: number | null,
	connectionStatus: string
): loopbackDeviceIndex is number {
	return (
		recordingMode === "listen" && loopbackDeviceIndex != null && connectionStatus === "connected"
	);
}

function shouldStopLoopback(
	recordingMode: string,
	wasListen: boolean,
	connectionStatus: string
): boolean {
	return wasListen && recordingMode !== "listen" && connectionStatus === "connected";
}

/**
 * Applies loopback start/stop side effects when recording mode or connection
 * status changes. Extracted for testability.
 */
export function applyLoopbackTransition(
	recordingMode: string,
	wasListen: boolean,
	loopbackDeviceIndex: number | null,
	connectionStatus: string
): void {
	if (shouldStartLoopback(recordingMode, loopbackDeviceIndex, connectionStatus)) {
		loopbackStart(loopbackDeviceIndex);
	} else if (shouldStopLoopback(recordingMode, wasListen, connectionStatus)) {
		loopbackStop();
	}
}

/**
 * Logs a loopback device-list fetch failure unless the effect was cancelled.
 * Extracted for testability — keeps the `.catch()` closure trivial.
 */
export function handleLoopbackListError(err: unknown, isCancelled: boolean): void {
	if (isCancelled) {
		return;
	}
	console.error("[useListenMode] Failed to fetch loopback devices:", err);
}

export function useListenMode(): void {
	const recordingMode = useSettingsStore((s) => s.settings.general?.recordingMode ?? "ptt");
	const loopbackDeviceIndex = useSettingsStore(
		(s) => s.settings.general?.loopbackDeviceIndex ?? null
	);
	const connectionStatus = useConnectionStore((s) => s.connectionStatus);
	const setListening = useListenStore((s) => s.setListening);
	const setDevices = useListenStore((s) => s.setDevices);
	const prevModeRef = useRef(recordingMode);

	// Subscribe to loopback events from main process
	useEffect(() => {
		const unsubStarted = onLoopbackStarted((deviceName) => {
			setListening(true, deviceName);
		});
		const unsubStopped = onLoopbackStopped(() => {
			setListening(false);
		});
		return () => {
			unsubStarted();
			unsubStopped();
		};
	}, [setListening]);

	// Fetch loopback devices when connected and in listen mode
	useEffect(() => {
		if (connectionStatus !== "connected" || recordingMode !== "listen") {
			return;
		}

		let isCancelled = false;

		loopbackListDevices()
			.then((devices) => {
				if (isCancelled) {
					return;
				}
				if (Array.isArray(devices)) {
					setDevices(validateDevices(devices));
				} else {
					console.warn("[useListenMode] Invalid devices response:", devices);
				}
			})
			.catch((err: unknown) => handleLoopbackListError(err, isCancelled));

		return () => {
			isCancelled = true;
		};
	}, [connectionStatus, recordingMode, setDevices]);

	// Start/stop loopback when mode or device changes
	useEffect(() => {
		const wasListen = prevModeRef.current === "listen";
		prevModeRef.current = recordingMode;
		applyLoopbackTransition(recordingMode, wasListen, loopbackDeviceIndex, connectionStatus);
	}, [recordingMode, loopbackDeviceIndex, connectionStatus]);

	// Stop loopback on unmount if active
	useEffect(
		() => () => {
			if (prevModeRef.current === "listen") {
				loopbackStop();
			}
		},
		[]
	);
}
