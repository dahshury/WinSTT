"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { useConnectionStore } from "@/entities/connection";
import { useDeviceSwitchFeedback } from "@/features/audio-device-feedback";
import { useVisualizerSync } from "@/features/audio-visualizer";
import { useConnectionListener } from "@/features/connect-server";
import { useFileTranscriptionListener } from "@/features/file-transcription";
import { useListenMode } from "@/features/listen-mode";
import { useTranscriptionFeed } from "@/features/live-transcription";
import { useDownloadListener } from "@/features/model-download";
import { usePushToTalk } from "@/features/push-to-talk";
import { useSyncSettings } from "@/features/update-settings";
import { gpuGetInfo } from "@/shared/api/ipc-client";
import { useRecordingSound } from "@/shared/lib/use-recording-sound";

export function IpcProvider({ children }: { children: ReactNode }) {
	const setGpuInfo = useConnectionStore((s) => s.setGpuInfo);

	// Initialize all IPC subscriptions
	useConnectionListener();
	useTranscriptionFeed();
	useVisualizerSync();
	usePushToTalk();
	useSyncSettings();
	useDownloadListener();
	useFileTranscriptionListener();
	useListenMode();
	useDeviceSwitchFeedback();
	useRecordingSound();

	// Model catalog is self-initializing — see catalog-store.ts

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
