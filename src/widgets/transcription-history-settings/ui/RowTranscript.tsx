import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
	Fragment,
	type ReactElement,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslations } from "use-intl";
import type { WordTiming } from "@/shared/api/ipc-client";
import { Z_INDEX } from "@/shared/config/z-index";
import { cn } from "@/shared/lib/cn";
import {
	SurfaceProvider,
	surfaceClasses,
	useSurface,
} from "@/shared/lib/surface";
import type { TranscriptDiffResult } from "@/shared/lib/transcript-diff";
import { useLongPress } from "@/shared/lib/use-long-press";
import {
	type TranscriptDiffLabels,
	TranscriptDiffView,
} from "@/shared/ui/transcript-diff";
import { COPY_FEEDBACK_MS, copyEntryText } from "../lib/copy-entry-text";

/**
 * Reveals a row's complete transcript in a hover/focus popup — the same Base UI
 * Tooltip surface the feature demos use — for transcripts the row clamps to four
 * lines. Read-only on purpose: the copy button already copies the full text, so
 * this popup just lifts the truncation cap for reading. Wraps the clamped
 * paragraph as its own trigger (no separate affordance), so hovering the "…"
 * text itself opens it.
 */
function historyDiffLabels(
	t: ReturnType<typeof useTranslations<"history">>,
): TranscriptDiffLabels {
	return {
		aiEdits: t("diffAiEdits"),
		before: t("diffBefore"),
		after: t("diffAfter"),
		inserted: t("diffInserted"),
		removed: t("diffRemoved"),
		largeRewrite: t("diffLargeRewrite"),
		changeCount: (count) => t("diffChangeCount", { count }),
		moreChanges: (count) => t("diffMoreChanges", { count }),
	};
}

function FullTranscriptHover({
	children,
	diff,
	label,
	text,
}: {
	children: ReactElement;
	diff: TranscriptDiffResult | null;
	label: string;
	text: string;
}) {
	const t = useTranslations("history");
	const substrate = useSurface();
	const popupLevel = Math.min(substrate + 2, 8);
	const popupShadow = Math.max(popupLevel, 6);
	return (
		<TooltipPrimitive.Root>
			<TooltipPrimitive.Trigger render={children} />
			<TooltipPrimitive.Portal>
				<SurfaceProvider value={popupLevel}>
					<TooltipPrimitive.Positioner
						side="top"
						sideOffset={8}
						style={{ zIndex: Z_INDEX.tooltip }}
					>
						<TooltipPrimitive.Popup
							aria-label={label}
							className={cn(
								"max-w-[min(42rem,calc(100vw-2rem))] origin-(--transform-origin) rounded-lg p-3 transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
								surfaceClasses(popupLevel, popupShadow),
							)}
						>
							<div
								className="max-h-[46vh] select-text overflow-y-auto"
								dir="auto"
							>
								{diff ? (
									<TranscriptDiffView
										diff={diff}
										labels={historyDiffLabels(t)}
									/>
								) : (
									<div className="whitespace-pre-wrap break-words text-body text-foreground leading-relaxed">
										{text}
									</div>
								)}
							</div>
						</TooltipPrimitive.Popup>
					</TooltipPrimitive.Positioner>
				</SurfaceProvider>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	);
}

interface RowTranscriptProps {
	activeIndex: number;
	diff: TranscriptDiffResult | null;
	displayText: string;
	viewFullLabel: string;
	words: WordTiming[] | null;
}

/**
 * Renders a row's transcript body. At rest the text is clamped to four lines
 * (CSS `-webkit-line-clamp`, which appends the trailing "…"); when it actually
 * overflows that cap we attach a hover popup with the full text. During
 * playback the word-timed spans render UNclamped instead, so the highlight
 * sweep never scrolls out of view — playback is transient and reads top-down.
 */
export function RowTranscript({
	activeIndex,
	diff,
	displayText,
	viewFullLabel,
	words,
}: RowTranscriptProps) {
	const [clamped, setClamped] = useState(false);
	const [copied, setCopied] = useState(false);
	const showWords = words !== null && words.length > 0;
	const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);

	useEffect(
		() => () => {
			if (copyFeedbackTimerRef.current) {
				clearTimeout(copyFeedbackTimerRef.current);
			}
		},
		[],
	);

	const copyFromLongPress = useCallback(() => {
		if (!displayText) {
			return;
		}
		copyEntryText(displayText);
		globalThis.navigator?.vibrate?.(10);
		setCopied(true);
		if (copyFeedbackTimerRef.current) {
			clearTimeout(copyFeedbackTimerRef.current);
		}
		copyFeedbackTimerRef.current = setTimeout(
			() => setCopied(false),
			COPY_FEEDBACK_MS,
		);
	}, [displayText]);

	const longPress = useLongPress(copyFromLongPress, {
		disabled: displayText.length === 0,
	});
	const touchCopyState = copied
		? "copied"
		: longPress.pressing
			? "pressing"
			: undefined;

	// Toggling `clamped` swaps the returned root element (plain <p> ↔ tooltip
	// wrapper), which REMOUNTS the paragraph. A callback ref re-attaches the
	// ResizeObserver to whichever <p> is currently live — a useEffect+useRef
	// would leave the observer bound to the detached node and flip-flop. Each
	// transition measures the actually-attached node, so it converges.
	const observerRef = useRef<ResizeObserver | null>(null);
	const measureRef = useCallback(
		(node: HTMLParagraphElement | null) => {
			observerRef.current?.disconnect();
			observerRef.current = null;
			if (!node || showWords) {
				setClamped(false);
				return;
			}
			// line-clamp keeps clientHeight at the 4-line cap while scrollHeight
			// grows with the full content — the gap is the truncation signal.
			const measure = () =>
				setClamped(node.scrollHeight - node.clientHeight > 1);
			measure();
			if (typeof ResizeObserver !== "undefined") {
				const observer = new ResizeObserver(measure);
				observer.observe(node);
				observerRef.current = observer;
			}
		},
		// `displayText` is a dep so swapping original↔AI re-measures: the ref
		// identity changes, React re-runs it on the same node, and the new text's
		// overflow is re-evaluated (a short AI text may not clamp while its longer
		// original does, or vice versa).
		[displayText, showWords],
	);

	const paragraph = (
		<p
			className={cn(
				"touch-copy-transcript mt-0.5 min-w-0 flex-1 select-text whitespace-pre-wrap break-words rounded-sm text-body text-foreground leading-relaxed transition-[background-color,box-shadow,transform] duration-150 [touch-action:pan-y]",
				!showWords && "line-clamp-4",
				longPress.pressing &&
					"scale-[0.998] bg-accent/10 shadow-[inset_0_0_0_1px_var(--color-border-accent)]",
				copied &&
					"scale-100 bg-success/10 shadow-[inset_0_0_0_1px_var(--color-success)]",
			)}
			data-long-press-copy="transcript"
			data-touch-copy-state={touchCopyState}
			dir="auto"
			{...longPress.handlers}
			ref={measureRef}
		>
			{showWords && words
				? words.map((word, index) => (
						<Fragment key={`${word.start}-${index}`}>
							{index > 0 ? " " : null}
							<span
								className={
									index === activeIndex
										? "rounded-[3px] bg-foreground/15 text-foreground"
										: undefined
								}
							>
								{word.text}
							</span>
						</Fragment>
					))
				: displayText}
		</p>
	);

	if (showWords || (!clamped && !diff)) {
		return paragraph;
	}
	return (
		<FullTranscriptHover diff={diff} label={viewFullLabel} text={displayText}>
			{paragraph}
		</FullTranscriptHover>
	);
}
