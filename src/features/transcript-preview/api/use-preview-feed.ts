import { useEffect } from "react";
import {
	cancelPreview,
	onLlmReasoningDelta,
	onPreviewReady,
	onRecordingStart,
	onSttSessionAborted,
} from "@/shared/api/ipc-client";
import { useTranscriptPreviewStore } from "../model/preview-store";

/**
 * Bridges the preview-before-pasting IPC into the preview store. Mounted once by
 * the OverlayPage (the only window that paints the pill).
 *
 * - `stt:preview-ready` → open the editable pill with the raw + processed text.
 * - `stt:recording-start` → a new dictation supersedes a pending preview: drop
 *   it WITHOUT pasting (tell the backend so it restores the passive overlay).
 * - `stt:session-aborted` → user cancelled; reset local state.
 * - `llm-reasoning-delta` → while the magic button is re-processing, stream the
 *   model's reasoning into the thinking indicator (the auto-post-process has
 *   already finished by the time the preview is open, so any delta now is ours).
 */
export function useTranscriptPreviewFeed(): void {
	useEffect(() => {
		const offReady = onPreviewReady(({ original, text }) => {
			useTranscriptPreviewStore.getState().open({ original, text });
		});
		const offRecordingStart = onRecordingStart(() => {
			if (useTranscriptPreviewStore.getState().isActive) {
				void cancelPreview();
				useTranscriptPreviewStore.getState().reset();
			}
		});
		const offAborted = onSttSessionAborted(() => {
			if (useTranscriptPreviewStore.getState().isActive) {
				useTranscriptPreviewStore.getState().reset();
			}
		});
		const offReasoning = onLlmReasoningDelta(({ delta }) => {
			const store = useTranscriptPreviewStore.getState();
			if (store.isActive && store.isProcessing) {
				store.appendReasoning(delta);
			}
		});
		return () => {
			offReady();
			offRecordingStart();
			offAborted();
			offReasoning();
		};
	}, []);
}
