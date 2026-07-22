import type { ReactNode } from "react";
import { useEffect } from "react";
import { useVisualizerSync } from "@/features/audio-visualizer";
import { useConnectionListener } from "@/features/connect-server";
import { useTranscriptionFeed } from "@/features/live-transcription";
import { useLlmProcessingFeed } from "@/features/llm-processing";
import { usePushToTalk } from "@/features/push-to-talk";
import { useRealtimePreviewFallback } from "@/features/realtime-preview-fallback";
import { useSyncActiveModel } from "@/features/sync-active-model";
import { useSyncSettings } from "@/features/update-settings";
import {
	notifyRendererReady,
	waitForPendingNativeListeners,
} from "@/shared/api/ipc-client";
import { useAfterFirstPaint } from "@/shared/lib/use-after-first-paint";
import { hasTauriRuntime } from "@/shared/lib/tauri-runtime";
import { useRecordingModeCycle } from "@/widgets/recording-settings";
import { DeferredIpcEffects } from "./DeferredIpcEffects";

let startupReadyPromise: Promise<void> | null = null;

function signalRendererStartupReady(): Promise<void> {
	if (startupReadyPromise) {
		return startupReadyPromise;
	}
	// Core manager registration completes before Rust builds the main webview.
	// Settings, devices, and runtime-info hooks already perform their own real
	// hydration; the old readiness probes duplicated those IPC calls and threw
	// their results away. This single acknowledged command proves both that the
	// React tree mounted and that the IPC bridge is responsive.
	startupReadyPromise = (async () => {
		const listenersReady = await waitForPendingNativeListeners();
		if (!listenersReady) {
			console.warn(
				"[IpcProvider] Listener readiness deadline elapsed; continuing startup",
			);
		}
		await notifyRendererReady();
	})().catch((error: unknown) => {
		startupReadyPromise = null;
		console.error("[IpcProvider] Failed to notify renderer readiness:", error);
	});
	return startupReadyPromise;
}

export function IpcProvider({ children }: { children: ReactNode }) {
	const afterFirstPaint = useAfterFirstPaint();
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
	useRecordingModeCycle();
	// Recording chime now plays NATIVELY from Rust (see
	// winstt::commands::sound::play_recording_chime, fired by actions.rs on
	// hotkey-start) instead of a webview Web Audio hook — the hidden-window
	// AudioContext could lag/drop the first chime after the app went idle in the
	// tray. TTS/history playback still use Web Audio here.

	// Model catalog bootstrap is shared by every window through HtmlLang.

	useEffect(() => {
		if (hasTauriRuntime()) {
			void signalRendererStartupReady();
		}
	}, []);

	return (
		<>
			{children}
			{afterFirstPaint ? <DeferredIpcEffects /> : null}
		</>
	);
}
