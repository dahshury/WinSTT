import { useEffect, useRef } from "react";
import { AudioVisualizer } from "@/features/audio-visualizer";
import { TranscriptPreview } from "@/features/transcript-preview";
import {
	DynamicIsland,
	useDynamicIslandSize,
} from "@/shared/ui/dynamic-island";
import { ScrollingText } from "@/shared/ui/scrolling-text";
import {
	getProcessingStartedAt,
	ThinkingIndicator,
} from "@/shared/ui/thinking-indicator";
import { computeIslandSize } from "../lib/overlay-reveal";
import {
	CancelButton,
	ICON_PRESET_PX,
	LivePulse,
	OVERLAY_PANEL_CLOSE_MS,
	PRESET_HEIGHT_PX,
	type SizePreset,
	TEXT_FONT_SIZE_PX,
	TRANSCRIBING_WORDS,
	useDelayedUnmount,
	useRecordingElapsed,
} from "./overlay-shell";

/** Boolean flags collapsed into one nested object so the island's content
 *  component takes a single `state` arg instead of 4+ standalone booleans
 *  (avoids `no-many-boolean-props`). The four flags interact closely
 *  (recording / VAD / thinking / live-transcription policy) so the grouping
 *  reads naturally at the call site. */
interface IslandFlags {
	isRecordingActive: boolean;
	isSpeaking: boolean;
	isThinking: boolean;
	isTranscribing: boolean;
	showLiveTranscription: boolean;
	/** Editable preview-before-pasting pill is open — overrides the recording
	 *  content with the `TranscriptPreview` editor and forces a wide island. */
	isPreviewActive: boolean;
}

interface IslandStateArgs {
	flags: IslandFlags;
	sizePreset: SizePreset;
	text: string;
	thinkingStartedAt: number | null;
	thinkingText: string;
	transcribingStartedAt: number | null;
}

/**
 * Inner content of the Dynamic Island — Apple-style two-zone layout:
 *
 *   ┌──────────────────────────────────────┐
 *   │ [waveform]              ● 00:32      │  ← top row, while recording
 *   │ transcribed text wraps here...       │  ← fills remaining space
 *   └──────────────────────────────────────┘
 *
 * Top row uses `justify-between` so the visualizer hugs the LEFT edge
 * and the recording dot + elapsed-time timer hug the RIGHT edge, with
 * the dead space between them swallowed by the flex gap. Mirrors the
 * iPhone Dynamic Island's "voice memo" look (see the reference shot).
 *
 * Both the visualizer and the text scale with `visualizerSize`:
 *   - visualizer zoom = `PRESET_HEIGHT_PX[sizePreset] / ICON_PRESET_PX`
 *     (matches the floating-bottom chip's scale curve)
 *   - text + timer fontSize = `TEXT_FONT_SIZE_PX[sizePreset]` (the timer
 *     uses `tabular-nums` so digit width doesn't jitter every second)
 *
 * Padding is asymmetric — `pt-1` keeps the visualizer almost flush with
 * the island's top edge (the iPhone look the user asked for), while
 * `pb-1.5` gives the trailing text room to breathe.
 */
function DynamicIslandPillContent({
	flags,
	sizePreset,
	text,
	thinkingText,
	thinkingStartedAt,
	transcribingStartedAt,
}: IslandStateArgs) {
	const {
		isRecordingActive,
		isSpeaking,
		isThinking,
		isTranscribing,
		showLiveTranscription,
		isPreviewActive,
	} = flags;
	// Hook runs unconditionally — the early `null` return below would
	// otherwise violate rules-of-hooks. The timer's interval only ticks
	// when `isRecordingActive` is true (see `useRecordingElapsed`).
	const elapsed = useRecordingElapsed(isRecordingActive);

	// Preview-before-pasting owns the whole island when active — the editable
	// transcript editor replaces the recording/thinking content.
	if (isPreviewActive) {
		return <TranscriptPreview />;
	}

	const isProcessing = isThinking || isTranscribing;
	if (!(isRecordingActive || isProcessing)) {
		// Belt-and-suspenders — the shell's `empty` preset (width 0) already
		// hides the island; this guard prevents stale renders from leaking
		// an empty padded box during the brief transition out.
		return null;
	}

	const visualizerZoom = PRESET_HEIGHT_PX[sizePreset] / ICON_PRESET_PX;
	const textFontSize = TEXT_FONT_SIZE_PX[sizePreset];
	// Timer is secondary information — render it slightly smaller than
	// the transcription, like Apple's notch readout.
	const timerFontSize = Math.max(10, Math.round(textFontSize * 0.8));
	const showText =
		isRecordingActive && showLiveTranscription && text.length > 0;
	const processingStartedAt = getProcessingStartedAt({
		isThinking,
		isTranscribing,
		thinkingStartedAt,
		transcribingStartedAt,
	});
	const processingText = isThinking ? thinkingText : "";
	const processingWordProps = isThinking
		? { reserveDefaultWords: true }
		: { reserveDefaultWords: true, words: TRANSCRIBING_WORDS };

	if (isProcessing) {
		return (
			<div
				className="px-5 pt-2 pr-10 pb-3"
				data-overlay-processing-content="true"
				style={{ fontSize: textFontSize }}
			>
				<ThinkingIndicator
					fluidWidth
					reasoning={processingText}
					startedAt={processingStartedAt}
					{...processingWordProps}
				/>
			</div>
		);
	}

	// Padding tuned to the shell's 28px bottom-corner radius:
	//   - `pt-1`  (4px) keeps the top row almost flush with the flat top
	//     edge — the iPhone-notch look the user asked for.
	//   - `px-5` (20px) keeps the rightmost char of the timer and the
	//     last word of wrapped text clear of the bottom-corner curves.
	//   - `pb-3` (12px) leaves a comfortable gap between the bottom text
	//     line and the rounded bottom edge.
	// Inner `gap-1` separates the top row from the transcription/thinking
	// block by ~4px so they don't visually touch.
	return (
		<div className="flex flex-col gap-1 px-5 pt-1 pb-3">
			{isRecordingActive ? (
				<div
					className="flex items-center justify-between gap-3"
					data-overlay-visualizer-row="true"
				>
					{/* Visualizer hugged to the top-left, scaled per setting */}
					<div className="flex items-center" style={{ zoom: visualizerZoom }}>
						<AudioVisualizer size="icon" />
					</div>
					{/* Recording dot + mm:ss timer, hugged to the top-right. The
					    X cancel button is rendered separately (absolute-positioned
					    in the parent shell) so it stays visible during LLM-thinking
					    too — the header row hides in that state. */}
					<div className="flex items-center gap-1.5">
						<LivePulse isSpeaking={isSpeaking} />
						<span
							className="font-mono text-white/70 tabular-nums"
							style={{ fontSize: timerFontSize }}
						>
							{elapsed}
						</span>
						{/* Spacer reserves room for the absolute-positioned X so the
						    timer doesn't sit flush against the right corner curve. */}
						<span aria-hidden="true" className="inline-block w-3 shrink-0" />
					</div>
				</div>
			) : null}
			{showText ? (
				<div className="w-full" style={{ fontSize: textFontSize }}>
					<ScrollingText
						className="text-start font-medium text-white tracking-tight"
						// Solid black fade-mask matches the island's bg so the
						// edge fade reads as "more text" rather than a band.
						fadeColor="rgb(0 0 0 / 0.95)"
						lineHeight={1.25}
						maxLines={5}
						text={text}
					/>
				</div>
			) : null}
			{isProcessing ? (
				<div className="w-full" style={{ fontSize: textFontSize }}>
					{/* `fluidWidth` lets the streamed-reasoning band fill the
					    island width instead of its intrinsic clamp — so when the
					    island sits at the compact `compactMedium` footprint (the
					    main-model-only thinking path) the reasoning tracks that
					    width rather than overflowing and getting clipped. */}
					<ThinkingIndicator
						fluidWidth
						reasoning={processingText}
						startedAt={processingStartedAt}
						{...processingWordProps}
					/>
				</div>
			) : null}
		</div>
	);
}

/**
 * Provider-aware wrapper: pulls the target size from external state, drives
 * `setSize` via effect, and renders the shell + content. Sits inside
 * `DynamicIslandProvider` so the hook context is available.
 *
 * `flatTop` removes the top corner radius so the island visually hangs from
 * the top bezel; `fitContent` lets each transcribed line extend the shell
 * by exactly one line's height.
 */
function DynamicIslandPill(args: IslandStateArgs & { revealed: boolean }) {
	const { setSize, state } = useDynamicIslandSize();
	const { flags, text, revealed } = args;
	// `revealed` is the sticky "actual words have been said this session" latch
	// (shared with the floating-bottom pill via `computePillReveal` +
	// `useStickyPillReveal`).
	// Until it flips true the island stays collapsed to `empty` (0Ã—0, invisible)
	// so it never pops on the bare recording-start before the first word — the
	// same gate the floating-bottom chip uses. Once revealed, the normal size
	// state-machine drives the width (it won't collapse back to `empty` mid-
	// session, so brief inter-word gaps don't flicker the island shut).
	const target = flags.isPreviewActive
		? "massive"
		: revealed
			? computeIslandSize({
					isRecordingActive: flags.isRecordingActive,
					isSpeaking: flags.isSpeaking,
					isThinking: flags.isThinking,
					isTranscribing: flags.isTranscribing,
					hasShownText: flags.showLiveTranscription && text.length > 0,
				})
			: "empty";

	// Commit the closed state first, then flip size/open state after paint. A
	// render-phase setState can collapse the `empty` frame into the first visible
	// commit, making the panel reveal look like a pop instead of a slide.
	useEffect(() => {
		if (state.size !== target) {
			setSize(target);
		}
	}, [setSize, state.size, target]);

	const currentContentArgs: IslandStateArgs = {
		flags,
		sizePreset: args.sizePreset,
		text,
		thinkingStartedAt: args.thinkingStartedAt,
		thinkingText: args.thinkingText,
		transcribingStartedAt: args.transcribingStartedAt,
	};
	const contentArgsRef = useRef(currentContentArgs);
	if (revealed) {
		contentArgsRef.current = currentContentArgs;
	}
	const renderContent = useDelayedUnmount(revealed, OVERLAY_PANEL_CLOSE_MS);
	const contentArgs = revealed ? currentContentArgs : contentArgsRef.current;

	return (
		<DynamicIsland
			data-overlay-hit-region="true"
			fitContent
			flatTop
			id="winstt-overlay-island"
		>
			{/* X cancel anchored to the top-right of the island, just inside the
			    rounded bottom-right area. Absolute-positioned so it stays visible
			    in both the recording state (alongside the timer) and the LLM-
			    thinking state (which hides the header row entirely). The 8px
			    top inset matches the island's `pt-1` content padding. Hidden
			    during preview — the preview pill owns its own dismiss control. */}
			{renderContent && !contentArgs.flags.isPreviewActive ? (
				<div className="pointer-events-auto absolute top-2 right-3 z-raised">
					<CancelButton size={14} />
				</div>
			) : null}
			{renderContent ? <DynamicIslandPillContent {...contentArgs} /> : null}
		</DynamicIsland>
	);
}

export { type IslandFlags, type IslandStateArgs, DynamicIslandPill };
