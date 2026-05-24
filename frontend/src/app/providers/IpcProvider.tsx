import type { ReactNode } from "react";
import { useEffect } from "react";
import { useConnectionStore } from "@/entities/connection";
import { useDeviceSwitchFeedback } from "@/features/audio-device-feedback";
import { useVisualizerSync } from "@/features/audio-visualizer";
import { useConnectionListener } from "@/features/connect-server";
import { useFileTranscriptionListener } from "@/features/file-transcription";
import { useListenMode } from "@/features/listen-mode";
import { useTranscriptionFeed } from "@/features/live-transcription";
import { useLlmProcessingFeed } from "@/features/llm-processing";
import { useDownloadListener } from "@/features/model-download";
import { usePushToTalk } from "@/features/push-to-talk";
import { useSyncActiveModel } from "@/features/sync-active-model";
import { useSyncSettings } from "@/features/update-settings";
import { useVadCalibration } from "@/features/vad-calibration";
import { gpuGetInfo } from "@/shared/api/ipc-client";
import { useRecordingSound } from "@/shared/lib/use-recording-sound";

export function IpcProvider({ children }: { children: ReactNode }) {
	const setGpuInfo = useConnectionStore((s) => s.setGpuInfo);

	// Initialize all IPC subscriptions
	useConnectionListener();
	useTranscriptionFeed();
	// Populates this renderer's LLM-processing store from the broadcast
	// LLM_PROCESSING_START/END + LLM_REASONING_DELTA events so the main
	// window can mirror the pill's thinking indicator.
	useLlmProcessingFeed();
	useVisualizerSync();
	usePushToTalk();
	useSyncSettings();
	useSyncActiveModel();
	useDownloadListener();
	useFileTranscriptionListener();
	useListenMode();
	useDeviceSwitchFeedback();
	useVadCalibration();
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
