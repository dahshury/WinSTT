"use client";

import { useEffect } from "react";
import { ipcInvoke, onConnectionChange, onServerStatus } from "@/shared/api/ipc-client";
import { useConnectionStore } from "../model/connection-store";

export function useConnectionListener() {
	const setConnectionStatus = useConnectionStore((s) => s.setConnectionStatus);
	const setServerStatus = useConnectionStore((s) => s.setServerStatus);

	useEffect(() => {
		console.log("[useConnectionListener] Mounted — querying initial status");
		// Query current status on mount (connection may have been established before page loaded)
		ipcInvoke("stt:is-connected").then((connected) => {
			console.log("[useConnectionListener] Initial is-connected:", connected);
			if (connected) {
				setConnectionStatus("connected");
			}
		});

		// Query server-ready status on mount (server_ready may have fired before renderer subscribed)
		ipcInvoke("stt:get-server-ready").then((ready) => {
			console.log("[useConnectionListener] Initial server-ready:", ready);
			if (ready) {
				setServerStatus("running");
			}
		});

		// Listen for future connection changes
		const unsubConnection = onConnectionChange((connected) => {
			console.log("[useConnectionListener] Connection changed:", connected);
			setConnectionStatus(connected ? "connected" : "disconnected");
			if (!connected) {
				setServerStatus("idle");
			}
		});

		// Listen for server_ready signal (recorder fully initialized)
		const unsubStatus = onServerStatus((status) => {
			console.log("[useConnectionListener] Server status:", status);
			setServerStatus(status);
		});

		return () => {
			unsubConnection();
			unsubStatus();
		};
	}, [setConnectionStatus, setServerStatus]);
}
