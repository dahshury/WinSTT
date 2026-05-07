"use client";

import { useEffect } from "react";
import { useConnectionStore } from "@/entities/connection";
import { ipcInvoke, onConnectionChange, onServerStatus } from "@/shared/api/ipc-client";
import { getErrorMessage } from "@/shared/lib/errors";

export function useConnectionListener(): void {
	const setConnectionStatus = useConnectionStore((s) => s.setConnectionStatus);
	const setServerStatus = useConnectionStore((s) => s.setServerStatus);

	useEffect(() => {
		// Query current status on mount (connection may have been established before page loaded)
		ipcInvoke("stt:is-connected")
			.then((connected) => {
				if (connected) {
					setConnectionStatus("connected");
				}
			})
			.catch((error: unknown) => {
				console.error(
					"[useConnectionListener] Failed to query connection status:",
					getErrorMessage(error)
				);
			});

		// Query server-ready status on mount (server_ready may have fired before renderer subscribed)
		ipcInvoke("stt:get-server-ready")
			.then((ready) => {
				if (ready) {
					setServerStatus("running");
				}
			})
			.catch((error: unknown) => {
				console.error(
					"[useConnectionListener] Failed to query server-ready status:",
					getErrorMessage(error)
				);
			});

		// Listen for future connection changes
		const unsubConnection = onConnectionChange((connected) => {
			setConnectionStatus(connected ? "connected" : "disconnected");
			if (!connected) {
				setServerStatus("idle");
			}
		});

		// Listen for server_ready signal (recorder fully initialized)
		const unsubStatus = onServerStatus((status) => {
			setServerStatus(status);
		});

		return () => {
			unsubConnection();
			unsubStatus();
		};
	}, [setConnectionStatus, setServerStatus]);
}
