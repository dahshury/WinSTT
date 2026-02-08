"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { useVisualizerSync } from "@/features/audio-visualizer";
import { useConnectionListener, useConnectionStore } from "@/features/connect-server";
import { useTranscriptionFeed } from "@/features/live-transcription";
import { usePushToTalk } from "@/features/push-to-talk";
import { useSyncSettings } from "@/features/update-settings";
import { gpuGetInfo } from "@/shared/api/ipc-client";

export function IpcProvider({ children }: { children: ReactNode }) {
	const setGpuInfo = useConnectionStore((s) => s.setGpuInfo);

	// Initialize all IPC subscriptions
	useConnectionListener();
	useTranscriptionFeed();
	useVisualizerSync();
	usePushToTalk();
	useSyncSettings();

	// Detect GPU on startup
	useEffect(() => {
		gpuGetInfo().then((info) => {
			if (info) {
				setGpuInfo(info);
			}
		});
	}, [setGpuInfo]);

	return <>{children}</>;
}
