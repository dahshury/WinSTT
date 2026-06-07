import { useEffect, useRef } from "react";
import { audioRefreshDevices } from "@/shared/api/ipc-client";

const DEVICECHANGE_DEBOUNCE_MS = 200;

export function useAudioDeviceMonitor(): void {
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		const refreshSafely = () => {
			audioRefreshDevices().catch(() => undefined);
		};

		refreshSafely();

		const mediaDevices =
			typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
		if (!mediaDevices) {
			return;
		}

		const handleDeviceChange = () => {
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
			}
			debounceRef.current = setTimeout(() => {
				debounceRef.current = null;
				refreshSafely();
			}, DEVICECHANGE_DEBOUNCE_MS);
		};

		mediaDevices.addEventListener("devicechange", handleDeviceChange);
		return () => {
			mediaDevices.removeEventListener("devicechange", handleDeviceChange);
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
				debounceRef.current = null;
			}
		};
	}, []);
}
