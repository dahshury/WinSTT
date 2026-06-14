import { domMax, LazyMotion } from "motion/react";
import { type ReactNode, useEffect } from "react";
import { providerOf } from "@/entities/cloud-stt-provider";
import { useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import {
	useVisualizerStore,
	useVisualizerSync,
} from "@/features/audio-visualizer";
import { useTranscriptionFeed } from "@/features/live-transcription";
import {
	useLlmProcessingFeed,
	useLlmProcessingStore,
} from "@/features/llm-processing";
import {
	useTranscriptPreviewFeed,
	useTranscriptPreviewStore,
} from "@/features/transcript-preview";
import { onSettingsChanged } from "@/shared/api/ipc-client";
import { decodeSettingsPayload } from "@/shared/api/settings-codec";
import { shouldSuppressPillPreviewForWordByWordPaste } from "@/shared/lib/realtime-enabled";
import { DynamicIslandProvider } from "@/shared/ui/dynamic-island";
import { computePillReveal, useStickyPillReveal } from "../lib/overlay-reveal";
import { useTtsPlaybackStore } from "../model/tts-playback-store";
import { DynamicIslandPill } from "./DynamicIslandPill";
import { DynamicTransformIslandLayer } from "./DynamicTransformIsland";
import { FloatingBottomPill, FloatingTransformPill } from "./FloatingPill";
import {
	useOverlayNativeHitRegions,
	useResetOnOverlayShow,
	useTransparentBody,
} from "./overlay-hit-regions";
import { ICON_PRESET_PX, PRESET_HEIGHT_PX, toPreset } from "./overlay-shell";
import { TtsIslandLayer, useTtsIslandBridge } from "./TtsIsland";
import { TtsPlaybackMount } from "./TtsPlaybackMount";

// Re-export the pure compute helpers from their new lib home so existing
// sibling test imports (`./OverlayPage`) keep resolving — these are the only
// names consumed outside this file besides `OverlayPage` itself.
export {
	computeIslandSize,
	computePillReveal,
	computeStickyPillReveal,
} from "../lib/overlay-reveal";

type OverlaySettings = ReturnType<typeof useSettingsStore.getState>["settings"];

function shouldShowTranscribingForPostProcessing(
	settings: OverlaySettings,
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

export function OverlayPage() {
	useTransparentBody();
	useOverlayNativeHitRegions();
	useResetOnOverlayShow();
	useVisualizerSync();
	useTranscriptionFeed();
	useLlmProcessingFeed();
	useTranscriptPreviewFeed();

	const setSettings = useSettingsStore((s) => s.setSettings);
	const sizePreset = useSettingsStore((s) =>
		toPreset(s.settings.general?.visualizerSize),
	);
	const liveDisplay = useSettingsStore(
		(s) => s.settings.general?.liveTranscriptionDisplay ?? "both",
	);
	const isListenMode = useSettingsStore(
		(s) => s.settings.general?.recordingMode === "listen",
	);
	const wordByWordPasting = useSettingsStore(
		(s) => s.settings.general?.wordByWordPasting ?? false,
	);
	const llmDictationEnabled = useSettingsStore(
		(s) => s.settings.llm.dictation.enabled,
	);
	const willRunDictationLlm = useSettingsStore((s) =>
		shouldShowTranscribingForPostProcessing(s.settings),
	);
	const isCloudSttModel = useSettingsStore(
		(s) => providerOf(s.settings.model?.model ?? "") !== null,
	);
	const mainModelId = useSettingsStore((s) => s.settings.model?.model ?? "");
	const realtimeModelId = useSettingsStore(
		(s) => s.settings.model?.realtimeModel ?? "",
	);
	const useMainModelForRealtime = useSettingsStore(
		(s) => s.settings.quality?.useMainModelForRealtime ?? false,
	);
	const overlayMode = useSettingsStore(
		(s) => s.settings.general?.overlayMode ?? "dynamic-island",
	);
	const suppressWordByWordPillPreview =
		shouldSuppressPillPreviewForWordByWordPaste({
			llmDictationEnabled,
			mainModelId,
			realtimeModelId,
			useMainModelForRealtime,
			wordByWordPasting,
		});
	const showLiveTranscription =
		!isListenMode &&
		!suppressWordByWordPillPreview &&
		(liveDisplay === "in-pill" || liveDisplay === "both");

	const realtime = useTranscriptionStore((s) => s.currentRealtime);
	const ephemeral = useTranscriptionStore((s) => s.ephemeral);
	const isRecordingActive = useTranscriptionStore((s) => s.isRecordingActive);
	const recordingSessionId = useTranscriptionStore((s) => s.recordingSessionId);
	const isTranscribing = useTranscriptionStore((s) => s.isTranscribing);
	const processingPhase = useTranscriptionStore((s) => s.processingPhase);
	const transcribingStartedAt = useTranscriptionStore(
		(s) => s.transcribingStartedAt,
	);
	const showTranscribing = !isListenMode && isTranscribing;
	const displayedTranscribingPhase =
		showTranscribing && isCloudSttModel ? processingPhase : null;
	const isThinking = useLlmProcessingStore((s) => s.isThinking);
	const showThinking = isThinking && willRunDictationLlm;
	const isTransforming = useLlmProcessingStore((s) => s.isTransforming);
	const thinkingText = useLlmProcessingStore((s) => s.thinkingText);
	const thinkingStartedAt = useLlmProcessingStore((s) => s.thinkingStartedAt);
	const transformStartedAt = useLlmProcessingStore((s) => s.transformStartedAt);
	// `isSpeaking` is the recorder's REAL smoothed-Silero VAD (backend surfaces
	// stt:vad-start/stop on actual speech onset/offset). It gates the pill reveal
	// (`computePillReveal`) — the chip lands on speech onset, not on the silent
	// lead-in after PTT — and also drives the breathing glow + island width.
	const isSpeaking = useVisualizerStore((s) => s.isSpeaking);
	const ttsStatus = useTtsPlaybackStore((s) => s.status);
	const ttsRequestId = useTtsPlaybackStore((s) => s.requestId);
	// Editable preview-before-pasting pill open (recording is done, paste held).
	const isPreviewActive = useTranscriptPreviewStore((s) => s.isActive);
	const hasEphemeral = ephemeral !== null;
	const sttSessionActive =
		!isListenMode &&
		(isRecordingActive ||
			showThinking ||
			isTranscribing ||
			isPreviewActive ||
			hasEphemeral);
	useTtsIslandBridge(sttSessionActive);
	const ttsSessionActive =
		ttsRequestId !== null &&
		(ttsStatus === "loading" ||
			ttsStatus === "speaking" ||
			ttsStatus === "paused");

	useEffect(() => {
		const unsub = onSettingsChanged((incoming) => {
			setSettings(decodeSettingsPayload(incoming));
		});
		return unsub;
	}, [setSettings]);

	// Click-through is owned by the main process so window visibility and
	// ignore-mouse state change on the same tick.
	// Keeping it out of renderer state avoids a cancel-click race.

	const text = ephemeral?.text ?? realtime.trim();
	const hasText = text.length > 0;
	const showText = (showLiveTranscription || hasEphemeral) && hasText;
	// Reveal the pill only once VAD says the user actually spoke. Realtime text,
	// transcribing state, and ephemeral status can keep an already-revealed pill
	// useful through the rest of the session, but they must not create one from
	// silence.
	const sessionShouldShow =
		!isListenMode &&
		(computePillReveal({
			isRecordingActive,
			isSpeaking,
			hasText,
			isThinking: showThinking,
			isTranscribing: showTranscribing,
		}) ||
			isPreviewActive);
	// Sticky once-on: hold the pill mounted for the rest of the active session
	// even if `currentRealtime` momentarily empties between realtime chunks.
	// Without this, the AnimatePresence around chip + bubble unmounts on every
	// brief text drop and the chip's chipVariants exit (`y: 4`) makes the
	// whole pill visibly bounce up/down as the user speaks. The latch clears
	// when the session truly ends (recording inactive AND not thinking).
	// The latch is keyed by `recordingSessionId`, so rapid PTT cycles cannot
	// reuse a visible latch from the previous session and flash before this
	// session has speech/text.
	const sessionActive =
		!isListenMode &&
		(isRecordingActive ||
			showThinking ||
			showTranscribing ||
			isPreviewActive ||
			hasEphemeral);
	const stickyShow = useStickyPillReveal({
		recordingSessionId,
		sessionActive,
		sessionShouldShow,
	});

	const heightPx = PRESET_HEIGHT_PX[sizePreset];
	// CSS `zoom` (Chromium-supported, including the reference) scales both visual and
	// layout box, so the surrounding flex container auto-sizes around the visualizer.
	const zoom = heightPx / ICON_PRESET_PX;

	// Bubble respects the in-pill transcription setting: if the user routed
	// live text to "in-app" only, the bubble stays hidden for transcription.
	// Processing owns the persistent visualizer surface instead of opening a
	// second bubble above an empty chip.
	const isProcessing = showThinking || showTranscribing;
	const showBubble = stickyShow && showText && !isProcessing;

	// STT owns the dictation surface whenever a dictation session is active.
	// TTS uses the island only while it has a live request and STT is idle.
	const showTtsIsland = ttsSessionActive && !sttSessionActive;
	const effectiveOverlayMode = showTtsIsland ? "floating-bottom" : overlayMode;
	// Active speech/transform pill (dynamic-island or floating-bottom). The
	// forced TTS read-aloud pill is a separate, always-mounted animated layer
	// (`TtsIslandLayer`) so it can slide in AND out from the top instead of popping.
	let activePill: ReactNode = null;
	if (isListenMode) {
		activePill = null;
	} else if (isTransforming && effectiveOverlayMode === "dynamic-island") {
		activePill = (
			<DynamicTransformIslandLayer
				show={isTransforming}
				thinkingText={thinkingText}
				transformStartedAt={transformStartedAt}
			/>
		);
	} else if (isTransforming) {
		activePill = (
			<FloatingTransformPill
				heightPx={heightPx}
				thinkingText={thinkingText}
				transformStartedAt={transformStartedAt}
				zoom={zoom}
			/>
		);
	} else if (effectiveOverlayMode === "dynamic-island") {
		// Top-flush layout: container anchors content to the *top* of the
		// renderer window (which is itself docked at `y = 0` of the primary
		// display), so the island sits against
		// the physical top bezel with no gap.
		//
		// Scaling is per-element inside the island (visualizer zoom + text
		// font-size) rather than a uniform outer `zoom`. The shell's width
		// stays bounded by the size preset (max 460px at `long`) regardless
		// of `visualizerSize`, while the visualizer and text grow / shrink
		// individually — same scale curve the floating-bottom pill uses.
		activePill = (
			<LazyMotion features={domMax} strict>
				<div className="flex h-screen w-screen items-start justify-center overflow-hidden">
					<DynamicIslandProvider initialSize="empty">
						<DynamicIslandPill
							flags={{
								isRecordingActive,
								isSpeaking,
								isThinking: showThinking,
								isTranscribing: showTranscribing,
								showLiveTranscription,
								isPreviewActive,
							}}
							revealed={stickyShow}
							sizePreset={sizePreset}
							text={text}
							thinkingStartedAt={thinkingStartedAt}
							thinkingText={thinkingText}
							transcribingPhase={displayedTranscribingPhase}
							transcribingStartedAt={transcribingStartedAt}
						/>
					</DynamicIslandProvider>
				</div>
			</LazyMotion>
		);
	} else {
		activePill = (
			<FloatingBottomPill
				flags={{
					isSpeaking,
					isThinking: showThinking,
					isTranscribing: showTranscribing,
					showBubble,
					stickyShow,
					isPreviewActive,
				}}
				heightPx={heightPx}
				text={text}
				thinkingStartedAt={thinkingStartedAt}
				thinkingText={thinkingText}
				transcribingPhase={displayedTranscribingPhase}
				transcribingStartedAt={transcribingStartedAt}
				zoom={zoom}
			/>
		);
	}

	return (
		<>
			{/* Owns the Web Audio queue + analyser for this (visible-during-reads)
			    window. Rendered at a STABLE position so switching the visible pill
			    never unmounts it (which would dispose the queue). */}
			<TtsPlaybackMount />
			{/* Forced TTS read-aloud island — always mounted so AnimatePresence can
			    slide it in/out from the top. The STT pill renders separately
			    during overlap instead of replacing or cancelling TTS. */}
			<TtsIslandLayer show={showTtsIsland} status={ttsStatus} />
			{activePill}
		</>
	);
}
