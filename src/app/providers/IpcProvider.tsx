import type { ReactNode } from "react";
import { useEffect } from "react";
import { useConnectionStore } from "@/entities/connection";
import { useDeviceSwitchFeedback } from "@/features/audio-device-feedback";
import { useAudioDeviceMonitor } from "@/features/audio-device-monitor";
import { useVisualizerSync } from "@/features/audio-visualizer";
import { useConnectionListener } from "@/features/connect-server";
import { useFileTranscriptionListener } from "@/features/file-transcription";
import { useListenMode } from "@/features/listen-mode";
import { useTranscriptionFeed } from "@/features/live-transcription";
import { useLlmProcessingFeed } from "@/features/llm-processing";
import { useDownloadListener } from "@/features/model-download";
import { usePushToTalk } from "@/features/push-to-talk";
import { useRealtimePreviewFallback } from "@/features/realtime-preview-fallback";
import { useSyncActiveModel } from "@/features/sync-active-model";
import { useSyncSettings } from "@/features/update-settings";
import { useVadCalibration } from "@/features/vad-calibration";
import {
	audioGetDevices,
	fetchRuntimeInfo,
	gpuGetInfo,
	notifyRendererReady,
	settingsLoad,
	webviewDiagLog,
} from "@/shared/api/ipc-client";

const STARTUP_READY_PROBE_TIMEOUT_MS = 2500;
let startupReadyPromise: Promise<void> | null = null;

function wait(ms: number): Promise<"timeout"> {
	return new Promise((resolve) => {
		window.setTimeout(() => resolve("timeout"), ms);
	});
}

async function waitForStartupProbes(): Promise<void> {
	const probes = Promise.allSettled([
		settingsLoad(),
		audioGetDevices(),
		fetchRuntimeInfo(),
	]);
	const result = await Promise.race([
		probes,
		wait(STARTUP_READY_PROBE_TIMEOUT_MS),
	]);
	if (result === "timeout") {
		const message = `[IpcProvider] startup probes exceeded ${STARTUP_READY_PROBE_TIMEOUT_MS}ms; releasing renderer readiness gate`;
		console.warn(message);
		webviewDiagLog("main", "warn", message);
	}
}

function signalRendererStartupReady(): Promise<void> {
	if (startupReadyPromise) {
		return startupReadyPromise;
	}
	startupReadyPromise = (async () => {
		await waitForStartupProbes();
		await notifyRendererReady();
	})().catch((error: unknown) => {
		startupReadyPromise = null;
		console.error("[IpcProvider] Failed to notify renderer readiness:", error);
	});
	return startupReadyPromise;
}

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
	useRealtimePreviewFallback();
	useDownloadListener();
	useFileTranscriptionListener();
	useListenMode();
	useDeviceSwitchFeedback();
	useVadCalibration();
	useAudioDeviceMonitor();
	// Recording chime now plays NATIVELY from Rust (see
	// winstt::commands::sound::play_recording_chime, fired by actions.rs on
	// hotkey-start) instead of a webview Web Audio hook — the hidden-window
	// AudioContext could lag/drop the first chime after the app went idle in the
	// tray. TTS/history playback still use Web Audio here.

	// Model catalog bootstrap is shared by every window through HtmlLang.

	useEffect(() => {
		void signalRendererStartupReady();
	}, []);

	// GPU details are only needed by model/settings surfaces. Defer this off the
	// immediate mount path so the main pill can paint before hardware enumeration.
	useEffect(() => {
		let cancelled = false;
		const timeout = window.setTimeout(() => {
			gpuGetInfo().then((info) => {
				if (!cancelled) {
					setGpuInfo(info);
				}
			});
		}, 750);
		return () => {
			cancelled = true;
			window.clearTimeout(timeout);
		};
	}, [setGpuInfo]);

	return <>{children}</>;
}
