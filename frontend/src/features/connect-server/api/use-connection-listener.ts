"use client";

import { useEffect } from "react";
import { ipcInvoke, onConnectionChange } from "@/shared/api/ipc-client";
import { useConnectionStore } from "../model/connection-store";

export function useConnectionListener() {
	const setConnectionStatus = useConnectionStore((s) => s.setConnectionStatus);

	useEffect(() => {
		// Query current status on mount (connection may have been established before page loaded)
		ipcInvoke("stt:is-connected").then((connected) => {
			if (connected) {
				setConnectionStatus("connected");
			}
		});

		// Listen for future connection changes
		const unsubscribe = onConnectionChange((connected) => {
			setConnectionStatus(connected ? "connected" : "disconnected");
		});
		return unsubscribe;
	}, [setConnectionStatus]);
}
