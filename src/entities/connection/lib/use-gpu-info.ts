import { useEffect } from "react";
import { gpuGetInfo } from "@/shared/api/ipc-client";
import { useConnectionStore } from "../model/connection-store";

/**
 * Fetches GPU details once on mount and writes them into the connection store.
 *
 * GPU enumeration is only needed by model/settings surfaces, so this is kept off
 * the main pill's immediate paint path by every caller (the main window defers it
 * behind a timer via {@link delayMs}). The effect guards against a
 * setState-after-unmount race with a cancel flag and swallows fetch rejections so
 * a slow/failed hardware probe can never surface an unhandled rejection.
 *
 * @param delayMs Optional delay before the probe runs. The main window passes a
 *   small delay so the pill can paint before hardware enumeration; the settings
 *   and model-picker windows fetch immediately (default `0`).
 */
export function useGpuInfo(delayMs = 0): void {
	const setGpuInfo = useConnectionStore((s) => s.setGpuInfo);
	useEffect(() => {
		let cancelled = false;
		const run = () => {
			gpuGetInfo()
				.then((info) => {
					if (!cancelled) {
						setGpuInfo(info);
					}
				})
				.catch((error: unknown) => {
					console.error("[useGpuInfo] Failed to fetch GPU info:", error);
				});
		};
		if (delayMs > 0) {
			const timeout = window.setTimeout(run, delayMs);
			return () => {
				cancelled = true;
				window.clearTimeout(timeout);
			};
		}
		run();
		return () => {
			cancelled = true;
		};
	}, [setGpuInfo, delayMs]);
}
