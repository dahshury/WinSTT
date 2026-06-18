import { AnimatePresence, domAnimation, LazyMotion, m } from "motion/react";
import { providerOf } from "@/entities/cloud-stt-provider";
import { useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { useLlmProcessingStore } from "@/features/llm-processing";
import {
	getProcessingStartedAt,
	ThinkingIndicator,
} from "@/shared/ui/thinking-indicator";

const TRANSCRIBING_WORDS = ["Transcribing"] as const;
const UPLOADING_WORDS = ["Uploading"] as const;
type TranscriptionThinkingSettings = ReturnType<
	typeof useSettingsStore.getState
>["settings"];

function hasConfiguredDictationModel(
	settings: TranscriptionThinkingSettings,
): boolean {
	const dictation = settings.llm.dictation;
	if (!dictation.enabled || settings.general?.recordingMode === "listen") {
		return false;
	}
	if (dictation.provider === "openrouter") {
		return settings.llm.openrouterApiKey.trim().length > 0;
	}
	return dictation.model.trim().length > 0;
}

function shouldShowTranscribingStatus(
	settings: TranscriptionThinkingSettings,
): boolean {
	return (
		providerOf(settings.model?.model ?? "") !== null ||
		hasConfiguredDictationModel(settings)
	);
}

function isCloudSttModelSelected(
	settings: TranscriptionThinkingSettings,
): boolean {
	return providerOf(settings.model?.model ?? "") !== null;
}

/**
 * Main-window twin of the pill's thinking state.
 *
 * While the dictation LLM is reasoning, the main window's transcription
 * surface shows the *same* indicator + streamed thinking tokens the pill
 * shows (driven by the shared LLM-processing store, fed via
 * `useLlmProcessingFeed` in `IpcProvider`). The final processed sentence is
 * deliberately NOT streamed here — it arrives once via `STT_FULL_SENTENCE`
 * and renders through `SubtitleOverlay` like always — so this layer only
 * fills the think → paste gap, matching how the pill behaves.
 *
 * Rendered as a centered, click-through overlay so it visually takes over
 * the subtitle area the way the pill's bubble swaps text for thinking.
 */
export function TranscriptionThinking() {
	const isThinking = useLlmProcessingStore((s) => s.isThinking);
	const thinkingText = useLlmProcessingStore((s) => s.thinkingText);
	const thinkingStartedAt = useLlmProcessingStore((s) => s.thinkingStartedAt);
	const isTranscribing = useTranscriptionStore((s) => s.isTranscribing);
	const processingPhase = useTranscriptionStore((s) => s.processingPhase);
	const transcribingStartedAt = useTranscriptionStore(
		(s) => s.transcribingStartedAt,
	);
	const showTranscribingStatus = useSettingsStore((s) =>
		shouldShowTranscribingStatus(s.settings),
	);
	const showThinkingStatus = useSettingsStore((s) =>
		hasConfiguredDictationModel(s.settings),
	);
	const isCloudSttModel = useSettingsStore((s) =>
		isCloudSttModelSelected(s.settings),
	);
	const visibleTranscribing = isTranscribing && showTranscribingStatus;
	const visibleThinking = isThinking && showThinkingStatus;

	const isProcessing = visibleThinking || visibleTranscribing;
	const startedAt = getProcessingStartedAt({
		isThinking: visibleThinking,
		isTranscribing: visibleTranscribing,
		thinkingStartedAt,
		transcribingStartedAt,
	});
	const reasoning = visibleThinking ? thinkingText : "";
	const transcribingWords =
		isCloudSttModel && processingPhase === "uploading"
			? UPLOADING_WORDS
			: TRANSCRIBING_WORDS;
	const wordProps = visibleThinking
		? { reserveDefaultWords: true }
		: { reserveDefaultWords: true, words: transcribingWords };

	return (
		<LazyMotion features={domAnimation} strict>
			<AnimatePresence>
				{isProcessing && (
					<m.div
						animate={{ opacity: 1 }}
						className="pointer-events-none absolute inset-0 z-overlay flex items-center justify-center px-4"
						exit={{ opacity: 0, transition: { duration: 0.12 } }}
						initial={{ opacity: 0 }}
						key="main-thinking"
					>
						<div className="relative inline-flex max-w-[460px] flex-col items-center overflow-hidden rounded-2xl bg-gradient-to-b from-surface-3/65 to-surface-1/92 px-3 py-2 ring-1 ring-overlay-foreground/[0.08] ring-inset backdrop-blur-md backdrop-saturate-150">
							{/* Brand-accent hairline — mirrors the pill bubble's top edge. */}
							<div
								aria-hidden="true"
								className="pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-accent-hairline to-transparent"
							/>
							<ThinkingIndicator
								reasoning={reasoning}
								startedAt={startedAt}
								{...wordProps}
							/>
						</div>
					</m.div>
				)}
			</AnimatePresence>
		</LazyMotion>
	);
}
