import { AnimatePresence, domAnimation, LazyMotion, m } from "motion/react";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { TranscriptionProcessingPhase } from "@/entities/transcription";
import { AudioVisualizer } from "@/features/audio-visualizer";
import { TranscriptPreview } from "@/features/transcript-preview";
import { ScrollingText } from "@/shared/ui/scrolling-text";
import {
	getProcessingStartedAt,
	ThinkingIndicator,
} from "@/shared/ui/thinking-indicator";
import {
	breatheVariants,
	BUBBLE_SHADOW,
	bubbleVariants,
	CancelButton,
	CHIP_SHADOW,
	chipVariants,
	GLASS_SURFACE,
	ICON_PRESET_PX,
	TRANSCRIBING_WORDS,
	TRANSFORMING_WORDS,
	UPLOADING_WORDS,
} from "./overlay-shell";

interface FloatingPillProps {
	flags: {
		isSpeaking: boolean;
		isThinking: boolean;
		isTranscribing: boolean;
		showBubble: boolean;
		stickyShow: boolean;
		isPreviewActive: boolean;
	};
	heightPx: number;
	text: string;
	thinkingStartedAt: number | null;
	thinkingText: string;
	transcribingPhase: TranscriptionProcessingPhase | null;
	transcribingStartedAt: number | null;
	zoom: number;
}

interface FloatingMorphSurfaceProps {
	heightPx: number;
	isPreviewActive: boolean;
	isProcessing: boolean;
	isSpeaking: boolean;
	isThinking: boolean;
	processingKind?: "dictation" | "transform";
	processingStartedAt: number | null;
	processingText: string;
	processingWords: readonly string[] | undefined;
	showCancelButton?: boolean;
	stickyShow: boolean;
	zoom: number;
}

function useMeasuredMorphSize(active: boolean): {
	ref: RefObject<HTMLDivElement | null>;
	size: { height: number; width: number } | null;
} {
	const ref = useRef<HTMLDivElement | null>(null);
	const [size, setSize] = useState<{
		height: number;
		width: number;
	} | null>(null);

	useLayoutEffect(() => {
		if (!active) {
			setSize(null);
			return;
		}
		const element = ref.current;
		if (!element) {
			return;
		}
		const measure = () => {
			const width = Math.ceil(
				Math.max(element.offsetWidth, element.scrollWidth),
			);
			const height = Math.ceil(
				Math.max(element.offsetHeight, element.scrollHeight),
			);
			if (width > 0 && height > 0) {
				setSize((current) =>
					current?.width === width && current.height === height
						? current
						: { width, height },
				);
			}
		};
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [active]);

	return { ref, size };
}

function FloatingMorphSurface({
	heightPx,
	isPreviewActive,
	isProcessing,
	isSpeaking,
	isThinking,
	processingKind = "dictation",
	processingStartedAt,
	processingText,
	processingWords,
	showCancelButton = true,
	stickyShow,
	zoom,
}: FloatingMorphSurfaceProps) {
	const chipWidth = Math.round(heightPx * 2.5 + 20);
	const chipHeight = heightPx + 8;
	const { ref: previewRef, size: previewSize } =
		useMeasuredMorphSize(isPreviewActive);
	const { ref: processingRef, size: processingSize } =
		useMeasuredMorphSize(isProcessing);
	const surfaceWidth =
		isPreviewActive && previewSize
			? previewSize.width
			: isProcessing && processingSize
				? processingSize.width
				: chipWidth;
	const surfaceHeight =
		isPreviewActive && previewSize
			? previewSize.height
			: isProcessing && processingSize
				? processingSize.height
				: chipHeight;
	const roundedClass =
		isPreviewActive || isProcessing ? "rounded-2xl" : "rounded-full";
	const surfaceShadow =
		isPreviewActive || isProcessing ? BUBBLE_SHADOW : CHIP_SHADOW;
	const processingWordProps = processingWords
		? { reserveDefaultWords: true, words: processingWords }
		: { reserveDefaultWords: true };

	return (
		<div className="relative w-fit">
			<AnimatePresence>
				{showCancelButton && stickyShow && !isPreviewActive ? (
					<m.div
						animate="animate"
						className="absolute -top-1 -right-3 z-raised"
						data-overlay-hit-region="true"
						exit="exit"
						initial="initial"
						key="cancel-button"
						variants={chipVariants}
					>
						<CancelButton size={16} />
					</m.div>
				) : null}
			</AnimatePresence>
			<div
				className={
					stickyShow
						? "pointer-events-auto opacity-100"
						: "pointer-events-none opacity-0"
				}
				data-overlay-hit-region="true"
				style={{ transition: "opacity 180ms ease-out" }}
			>
				<div
					className={`relative block shrink-0 overflow-hidden ${roundedClass} t-resize ${GLASS_SURFACE} ${surfaceShadow}`}
					data-processing={isProcessing ? "true" : "false"}
					data-overlay-floating-surface="true"
					data-overlay-processing-kind={
						isProcessing ? processingKind : undefined
					}
					style={{
						width: surfaceWidth,
						height: surfaceHeight,
						boxSizing: "border-box",
					}}
				>
					<div
						aria-hidden="true"
						className={`pointer-events-none absolute top-0 h-px bg-gradient-to-r from-transparent ${isPreviewActive ? "inset-x-5 via-[oklch(62%_0.19_260/0.5)]" : "inset-x-4 via-white/25"} to-transparent`}
					/>
					{isPreviewActive ? (
						<div
							className="inline-block w-[520px] max-w-[calc(100vw-24px)] align-top"
							ref={previewRef}
						>
							<TranscriptPreview />
						</div>
					) : isProcessing ? (
						<div
							className="inline-flex max-w-[calc(100vw-24px)] items-center justify-center px-3 py-2 align-top"
							data-overlay-transform-content={
								processingKind === "transform" ? "true" : undefined
							}
							ref={processingRef}
						>
							<ThinkingIndicator
								reasoning={processingText}
								startedAt={processingStartedAt}
								{...processingWordProps}
							/>
						</div>
					) : (
						<>
							<AnimatePresence>
								{isSpeaking && !isThinking ? (
									<m.div
										animate="animate"
										aria-hidden="true"
										className="pointer-events-none absolute inset-0 rounded-full"
										exit="exit"
										initial="initial"
										key="speaking-breathe"
										style={{
											boxShadow:
												"inset 0 0 18px 0 oklch(62% 0.19 260 / 0.28), inset 0 0 1px 0 oklch(75% 0.15 260 / 0.4)",
										}}
										variants={breatheVariants}
									/>
								) : null}
							</AnimatePresence>
							<div className="absolute inset-0 flex items-center justify-center">
								<div
									className="flex items-center justify-center"
									style={{ zoom, height: ICON_PRESET_PX }}
								>
									<AudioVisualizer size="icon" />
								</div>
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

/**
 * Floating-bottom STT pill (the pre-DynamicIsland look): a text/thinking bubble
 * above a fixed visualizer chip, bottom-anchored. Extracted verbatim from
 * `OverlayPage` so the page's pill-selection branch stays under the
 * cognitive-complexity gate.
 */
function FloatingBottomPill({
	flags,
	heightPx,
	text,
	thinkingStartedAt,
	thinkingText,
	transcribingPhase,
	transcribingStartedAt,
	zoom,
}: FloatingPillProps) {
	const {
		isSpeaking,
		isThinking,
		isTranscribing,
		showBubble,
		stickyShow,
		isPreviewActive,
	} = flags;
	const isProcessing = isThinking || isTranscribing;
	const processingStartedAt = getProcessingStartedAt({
		isThinking,
		isTranscribing,
		thinkingStartedAt,
		transcribingStartedAt,
	});
	const processingText = isThinking ? thinkingText : "";
	const transcribingWords =
		transcribingPhase === "uploading" ? UPLOADING_WORDS : TRANSCRIBING_WORDS;
	const processingWords = isThinking ? undefined : transcribingWords;
	return (
		<LazyMotion features={domAnimation} strict>
			<div className="flex h-screen w-screen items-end justify-center overflow-hidden pb-3">
				<div className="relative flex flex-col items-center gap-1">
					<AnimatePresence>
						{showBubble && !isPreviewActive && !isProcessing ? (
							<m.div
								animate="animate"
								className={`relative inline-flex max-w-[460px] flex-col items-center overflow-hidden rounded-2xl px-3 py-2 ${GLASS_SURFACE} ${BUBBLE_SHADOW}`}
								data-overlay-floating-bubble="true"
								data-overlay-hit-region="true"
								exit="exit"
								initial="initial"
								key="text-bubble"
								variants={bubbleVariants}
							>
								<div
									aria-hidden="true"
									className="pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-[oklch(62%_0.19_260/0.5)] to-transparent"
								/>
								<div>
									<ScrollingText
										className="text-center font-medium text-foreground text-sm tracking-tight"
										fadeColor="oklch(8% 0.015 265 / 0.95)"
										lineHeight={1.25}
										maxLines={5}
										text={text}
									/>
								</div>
							</m.div>
						) : null}
					</AnimatePresence>
					<FloatingMorphSurface
						heightPx={heightPx}
						isPreviewActive={isPreviewActive}
						isProcessing={isProcessing}
						isSpeaking={isSpeaking}
						isThinking={isThinking}
						processingStartedAt={processingStartedAt}
						processingText={processingText}
						processingWords={processingWords}
						stickyShow={stickyShow}
						zoom={zoom}
					/>
				</div>
			</div>
		</LazyMotion>
	);
}

function FloatingTransformPill({
	heightPx,
	thinkingText,
	transformStartedAt,
	zoom,
}: {
	heightPx: number;
	thinkingText: string;
	transformStartedAt: number | null;
	zoom: number;
}) {
	return (
		<LazyMotion features={domAnimation} strict>
			<div className="flex h-screen w-screen items-end justify-center overflow-hidden pb-3">
				<FloatingMorphSurface
					heightPx={heightPx}
					isPreviewActive={false}
					isProcessing
					isSpeaking={false}
					isThinking
					processingKind="transform"
					processingStartedAt={transformStartedAt}
					processingText={thinkingText}
					processingWords={TRANSFORMING_WORDS}
					showCancelButton={false}
					stickyShow
					zoom={zoom}
				/>
			</div>
		</LazyMotion>
	);
}

export {
	type FloatingPillProps,
	type FloatingMorphSurfaceProps,
	FloatingBottomPill,
	FloatingTransformPill,
};
