"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { useVisualizerSync } from "@/features/audio-visualizer";
import { useConnectionListener, useConnectionStore } from "@/features/connect-server";
import { useFileTranscriptionListener } from "@/features/file-transcription";
import { useListenMode } from "@/features/listen-mode";
import { useTranscriptionFeed } from "@/features/live-transcription";
import { useDownloadListener } from "@/features/model-download";
import { usePushToTalk } from "@/features/push-to-talk";
import { useSyncSettings } from "@/features/update-settings";
import { gpuGetInfo } from "@/shared/api/ipc-client";

export function IpcProvider({ children }: { children: ReactNode }) {
	const setGpuInfo = useConnectionStore((s) => s.setGpuInfo);

	console.log("[IpcProvider] Rendering — initializing hooks");

	// Initialize all IPC subscriptions
	useConnectionListener();
	console.log("[IpcProvider] useConnectionListener OK");
	useTranscriptionFeed();
	console.log("[IpcProvider] useTranscriptionFeed OK");
	useVisualizerSync();
	console.log("[IpcProvider] useVisualizerSync OK");
	usePushToTalk();
	console.log("[IpcProvider] usePushToTalk OK");
	useSyncSettings();
	console.log("[IpcProvider] useSyncSettings OK");
	useDownloadListener();
	console.log("[IpcProvider] useDownloadListener OK");
	useFileTranscriptionListener();
	console.log("[IpcProvider] useFileTranscriptionListener OK");
	useListenMode();
	console.log("[IpcProvider] useListenMode OK — all hooks initialized");

	// Model catalog is self-initializing — see catalog-store.ts

	// Detect GPU on startup
	useEffect(() => {
		console.log("[IpcProvider] Mounted — fetching GPU info");
		gpuGetInfo().then((info) => {
			console.log("[IpcProvider] GPU info:", JSON.stringify(info));
			if (info) {
				setGpuInfo(info);
			}
		});
	}, [setGpuInfo]);

	return <>{children}</>;
}
