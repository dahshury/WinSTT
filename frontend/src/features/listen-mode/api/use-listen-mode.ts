"use client";

import { useEffect, useRef } from "react";
import { useConnectionStore } from "@/features/connect-server";
import { useSettingsStore } from "@/features/update-settings";
import {
	loopbackListDevices,
	loopbackStart,
	loopbackStop,
	onLoopbackStarted,
	onLoopbackStopped,
} from "@/shared/api/ipc-client";
import { useListenStore } from "../model/listen-store";

export function useListenMode() {
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
					setDevices(
						devices as Array<{
							index: number;
							name: string;
							defaultSampleRate: number;
							maxOutputChannels: number;
						}>
					);
				} else {
					console.warn("[useListenMode] Invalid devices response:", devices);
				}
			})
			.catch((err: unknown) => {
				if (isCancelled) {
					return;
				}
				console.error("[useListenMode] Failed to fetch loopback devices:", err);
			});

		return () => {
			isCancelled = true;
		};
	}, [connectionStatus, recordingMode, setDevices]);

	// Start/stop loopback when mode or device changes
	useEffect(() => {
		const wasListen = prevModeRef.current === "listen";
		prevModeRef.current = recordingMode;

		if (
			recordingMode === "listen" &&
			loopbackDeviceIndex != null &&
			connectionStatus === "connected"
		) {
			loopbackStart(loopbackDeviceIndex);
		} else if (wasListen && recordingMode !== "listen" && connectionStatus === "connected") {
			loopbackStop();
		}
	}, [recordingMode, loopbackDeviceIndex, connectionStatus]);

	// Stop loopback on unmount if active
	useEffect(() => {
		return () => {
			if (prevModeRef.current === "listen") {
				loopbackStop();
			}
		};
	}, []);
}
