import { useEffect } from "react";
import { useSettingsStore } from "@/entities/setting";
import {
	cancelPreview,
	onLlmReasoningDelta,
	onPreviewReady,
	onRecordingStart,
	onSttSessionAborted,
} from "@/shared/api/ipc-client";
import { ALL_PRESET_KEYS, type PresetKey } from "@/shared/lib/preset-prompts";
import { useTranscriptPreviewStore } from "../model/preview-store";

/** Seed the enhance config from the dictation settings so the bottom AI-controls
 *  half opens pre-populated with the user's configured presets/modifiers (same
 *  defaults the magic button applies). Read lazily at open time — the settings
 *  store is hydrated by the time a preview can fire. */
function dictationEnhanceSeed(): {
	presetKeys: PresetKey[];
	modifierIds: string[];
} {
	const dictation = useSettingsStore.getState().settings.llm?.dictation;
	const presetKeys = (dictation?.presets ?? []).flatMap((p): PresetKey[] =>
		(ALL_PRESET_KEYS as readonly string[]).includes(p.key) ? [p.key] : [],
	);
	const modifierIds = (dictation?.customModifiers ?? []).flatMap((m) =>
		m.enabled ? [m.id] : [],
	);
	return { presetKeys, modifierIds };
}

/**
 * Bridges the preview-before-pasting IPC into the preview store. Mounted once by
 * the OverlayPage (the only window that paints the pill).
 *
 * - `stt:preview-ready` → open the editable pill with the raw + processed text.
 * - `stt:recording-start` → a new dictation supersedes a pending preview: drop
 *   it WITHOUT pasting (tell the backend so it restores the passive overlay).
 * - `stt:session-aborted` → user cancelled; reset local state.
 * - `llm:reasoning-delta` → while the magic button is re-processing, stream the
 *   model's reasoning into the thinking indicator (the auto-post-process has
 *   already finished by the time the preview is open, so any delta now is ours).
 */
export function useTranscriptPreviewFeed(): void {
	useEffect(() => {
		const offReady = onPreviewReady(({ original, text }) => {
			const { presetKeys, modifierIds } = dictationEnhanceSeed();
			useTranscriptPreviewStore
				.getState()
				.open({ original, text, presetKeys, modifierIds });
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
