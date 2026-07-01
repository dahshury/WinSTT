import { useEffect } from "react";
import { audioRefreshDevices } from "@/shared/api/ipc-client";
import { fireAndForget } from "@/shared/lib/fire-and-forget";

const DEVICECHANGE_DEBOUNCE_MS = 200;

export function useAudioDeviceMonitor(): void {
	useEffect(() => {
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;

		const refreshSafely = () => {
			fireAndForget(audioRefreshDevices(), "audioDeviceMonitor.refresh");
		};

		refreshSafely();

		const mediaDevices =
			typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
		if (!mediaDevices) {
			return;
		}

		const handleDeviceChange = () => {
			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}
			debounceTimer = setTimeout(() => {
				debounceTimer = null;
				refreshSafely();
			}, DEVICECHANGE_DEBOUNCE_MS);
		};

		mediaDevices.addEventListener("devicechange", handleDeviceChange);
		return () => {
			mediaDevices.removeEventListener("devicechange", handleDeviceChange);
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
			}
		};
	}, []);
}
