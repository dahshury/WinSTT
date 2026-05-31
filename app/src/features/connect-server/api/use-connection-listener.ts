import { useEffect } from "react";
import { useConnectionStore } from "@/entities/connection";
import {
	fetchRuntimeInfo,
	ipcInvoke,
	onConnectionChange,
	onRuntimeInfo,
	onServerStatus,
} from "@/shared/api/ipc-client";
import { getErrorMessage } from "@/shared/lib/errors";

export function useConnectionListener(): void {
	const setConnectionStatus = useConnectionStore((s) => s.setConnectionStatus);
	const setServerStatus = useConnectionStore((s) => s.setServerStatus);
	const setRuntimeInfo = useConnectionStore((s) => s.setRuntimeInfo);

	// Initial connection status query — runs once.
	useEffect(() => {
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
	}, [setConnectionStatus]);

	// Initial server-ready query — server_ready may have fired before this hook subscribed.
	useEffect(() => {
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
	}, [setServerStatus]);

	// Connection-change subscription — one disconnect must reset the server too.
	useEffect(
		() =>
			onConnectionChange((connected) => {
				setConnectionStatus(connected ? "connected" : "disconnected");
				if (!connected) {
					setServerStatus("idle");
				}
			}),
		[setConnectionStatus, setServerStatus]
	);

	// Server-ready signal subscription.
	useEffect(
		() =>
			onServerStatus((status) => {
				setServerStatus(status);
			}),
		[setServerStatus]
	);

	// Runtime info — initial fetch covers renderers that mount after the
	// server's server_ready broadcast (overlay/settings); the live
	// subscription keeps it in sync as the server pushes updates (e.g.
	// after every ``model_swap_completed`` — see ``on_model_swap_completed``
	// in the server's callbacks for the broadcast).
	useEffect(() => {
		fetchRuntimeInfo()
			.then((info) => setRuntimeInfo(info))
			.catch(() => {
				// Non-fatal — chip will keep showing hardware-only info.
			});
		return onRuntimeInfo((info) => setRuntimeInfo(info));
	}, [setRuntimeInfo]);
}
