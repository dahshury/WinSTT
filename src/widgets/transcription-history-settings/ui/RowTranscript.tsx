import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
	Fragment,
	type ReactElement,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslations } from "use-intl";
import type { WordTiming } from "@/shared/api/ipc-client";
import { Z_INDEX } from "@/shared/config/z-index";
import { COPY_FEEDBACK_MS, copyToClipboard } from "@/shared/lib/clipboard";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, surfaceBg, useSurface } from "@/shared/lib/surface";
import type { TranscriptDiffResult } from "@/shared/lib/transcript-diff";
import { useLongPress } from "@/shared/lib/use-long-press";
import {
	type TranscriptDiffLabels,
	TranscriptDiffView,
} from "@/shared/ui/transcript-diff";

/**
 * Karaoke word state, adapted from the ElevenLabs transcript-viewer demo:
 * upcoming words sit muted/faded, the word under the playhead lights up with a
 * highlight pill, and already-spoken words stay at full foreground. Every span
 * shares one smooth colour/opacity transition, so playback sweeps AND scrubbing
 * (which re-evaluates every word's status at once) both animate cleanly.
 */
function wordStatusClass(index: number, activeIndex: number): string {
	if (activeIndex < 0 || index > activeIndex) {
		// unspoken — dimmed, waiting to be reached (pure opacity fade over the
		// inherited foreground colour, so it reads as the same text just quieter)
		return "opacity-40";
	}
	if (index === activeIndex) {
		// current — highlighted pill, full presence
		return "bg-foreground/15 opacity-100";
	}
	// spoken — read, full opacity
	return "opacity-100";
}

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

/**
 * Reveals a row's complete transcript in a hover/focus popup — the same Base UI
 * Tooltip surface the feature demos use — for transcripts the row clamps to four
 * lines. Read-only on purpose: the copy button already copies the full text, so
 * this popup just lifts the truncation cap for reading. Wraps the clamped
 * paragraph as its own trigger (no separate affordance), so hovering the "…"
 * text itself opens it.
 */
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
								"max-w-[min(42rem,calc(100vw-2rem))] origin-(--transform-origin) rounded-xl p-3 shadow-elevated transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
								surfaceBg(popupLevel),
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
	highlights?: Array<{ end: number; start: number }> | undefined;
	/** Seek playback to the word at `index` (its start time). When provided during
	 *  playback each word becomes a clickable jump target. */
	onSeekWord?: ((index: number) => void) | undefined;
	/** True while the row's playback view is open (media controls visible). The
	 *  transcript then swaps the 4-line clamp for a capped SCROLLABLE body — even
	 *  when there are no word timings (TTS clips), so long text isn't stuck at "…". */
	playbackActive: boolean;
	viewFullLabel: string;
	words: WordTiming[] | null;
}

/**
 * Renders a row's transcript body. At rest the text is clamped to four lines
 * (CSS `-webkit-line-clamp`, which appends the trailing "…"); when it actually
 * overflows that cap we attach a hover popup with the full text. During
 * playback the clamp is lifted and the body becomes a capped scroll region —
 * word-timed spans auto-scroll to keep the highlight sweep in view, and
 * timing-less clips (TTS) can be scrolled by hand while playing.
 */
export function RowTranscript({
	activeIndex,
	diff,
	displayText,
	highlights,
	onSeekWord,
	playbackActive,
	viewFullLabel,
	words,
}: RowTranscriptProps) {
	const [clamped, setClamped] = useState(false);
	const [copied, setCopied] = useState(false);
	const showWords = words !== null && words.length > 0;
	// Playback view (with or without word timings) lifts the clamp in favour of a
	// capped scrollable body; the hover popup and clamp measurement both stand down.
	const scrollBody = playbackActive || showWords;
	// Loose element type on purpose: the active word is a <button> during seekable
	// playback but a plain <span> otherwise, and the follow-scroll only needs rects.
	const activeWordRef = useRef<HTMLElement | null>(null);
	// Callback form so both element flavours type-check against the shared ref.
	const setActiveWord = (node: HTMLElement | null) => {
		activeWordRef.current = node;
	};

	// Follow-lock: whether the box auto-scrolls to keep the lit word in view.
	// Broken by a MANUAL scroll that takes the word off-screen; re-engaged the
	// moment the word is visible again — whether the user scrolled back to it or
	// the reading caught up to where they're looking. A ref (not state): it only
	// gates scroll side-effects, so re-rendering on toggle would be wasted work.
	const followRef = useRef(true);
	// Set around our own scrollTop writes so the scroll listener can tell the
	// follow nudge apart from a user wheel/drag (both fire the same event).
	const programmaticScrollRef = useRef(false);

	// Is the lit word fully inside the box's visible area?
	const activeWordInView = (): boolean => {
		const word = activeWordRef.current;
		const box = word?.parentElement;
		if (!(word && box)) {
			return false;
		}
		const boxRect = box.getBoundingClientRect();
		const wordRect = word.getBoundingClientRect();
		return wordRect.top >= boxRect.top && wordRect.bottom <= boxRect.bottom;
	};

	// A user-initiated scroll re-decides the lock: scrolled away from the lit
	// word → follow off (they're free to read elsewhere); scrolled back so the
	// word is in view → follow re-engages on the spot.
	const handleBodyScroll = () => {
		if (programmaticScrollRef.current) {
			programmaticScrollRef.current = false;
			return;
		}
		followRef.current = activeWordInView();
	};

	// Keep the lit word visible inside the scroll cap as the sweep advances.
	// Deliberately NOT `scrollIntoView`: that also walks OUTER scroll ancestors
	// (the settings page / virtual list) and would yank the page back to the card
	// if the user scrolled away mid-playback. Only the paragraph box is moved.
	useEffect(() => {
		const word = activeWordRef.current;
		// The timed words are direct children of the scrollable <p>.
		const box = word?.parentElement;
		if (!(word && box) || activeIndex < 0) {
			return;
		}
		if (activeWordInView()) {
			// The sweep is where the user is looking — (re-)engage the lock. Also
			// covers the reading catching up to a spot they scrolled to, and a
			// word-click seek (the clicked word is by definition in view).
			followRef.current = true;
			return;
		}
		if (!followRef.current) {
			// User scrolled elsewhere — don't fight their reading position.
			return;
		}
		const boxRect = box.getBoundingClientRect();
		const wordRect = word.getBoundingClientRect();
		const before = box.scrollTop;
		programmaticScrollRef.current = true;
		if (wordRect.top < boxRect.top) {
			box.scrollTop += wordRect.top - boxRect.top;
		} else {
			box.scrollTop += wordRect.bottom - boxRect.bottom;
		}
		if (box.scrollTop === before) {
			// Clamped no-op write → no scroll event will fire to clear the flag;
			// clear it here so the NEXT user scroll isn't misread as ours.
			programmaticScrollRef.current = false;
		}
	}, [activeIndex]);
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

	const copyFromLongPress = () => {
		if (!displayText) {
			return;
		}
		copyToClipboard(displayText);
		globalThis.navigator?.vibrate?.(10);
		setCopied(true);
		if (copyFeedbackTimerRef.current) {
			clearTimeout(copyFeedbackTimerRef.current);
		}
		copyFeedbackTimerRef.current = setTimeout(
			() => setCopied(false),
			COPY_FEEDBACK_MS,
		);
	};

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
	// transition measures the actually-attached node, so it converges. The React
	// 19 ref-cleanup return disconnects the observer when the node unmounts or the
	// ref re-attaches, so nothing leaks across the swaps.
	const measureRef = (node: HTMLParagraphElement | null) => {
		if (!node || scrollBody) {
			setClamped(false);
			return;
		}
		// line-clamp keeps clientHeight at the 4-line cap while scrollHeight
		// grows with the full content — the gap is the truncation signal.
		const measure = () => setClamped(node.scrollHeight - node.clientHeight > 1);
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		// react-doctor-disable-next-line react-doctor/effect-needs-cleanup -- teardown IS present: this is a React 19 callback ref (not a useEffect), and the `return () => observer.disconnect()` below is invoked as the ref-cleanup when the <p> unmounts or the ref re-attaches. The rule doesn't model callback-ref cleanup returns, so it can't see the disconnect.
		observer.observe(node);
		return () => observer.disconnect();
	};

	const highlightedText = highlights?.flatMap((range, index, allRanges) => {
		const start = Math.max(0, Math.min(displayText.length, range.start));
		const end = Math.max(start, Math.min(displayText.length, range.end));
		const previousEnd =
			index === 0
				? 0
				: Math.min(displayText.length, allRanges[index - 1]?.end ?? 0);
		return [
			displayText.slice(previousEnd, start),
			<mark
				className="rounded-[2px] bg-accent/25 text-inherit"
				key={`${start}-${end}`}
			>
				{displayText.slice(start, end)}
			</mark>,
			...(index === allRanges.length - 1 ? [displayText.slice(end)] : []),
		];
	});

	const paragraph = (
		<p
			className={cn(
				"touch-copy-transcript mt-0.5 min-w-0 flex-1 select-text whitespace-pre-wrap break-words rounded-sm text-body text-foreground leading-relaxed transition-[background-color,box-shadow,transform] duration-150 [touch-action:pan-y]",
				// At rest: 4-line clamp (with the "…" + hover popup). In the playback
				// view: a capped scroll region instead, so long transcripts stay readable
				// — scrolled by hand (TTS) or auto-followed by the highlight (STT).
				scrollBody ? "max-h-40 overflow-y-auto" : "line-clamp-4",
				longPress.pressing &&
					"scale-[0.998] bg-accent/10 shadow-[inset_0_0_0_1px_var(--color-border-accent)]",
				copied &&
					"scale-100 bg-success/10 shadow-[inset_0_0_0_1px_var(--color-success)]",
			)}
			data-long-press-copy="transcript"
			data-touch-copy-state={touchCopyState}
			dir="auto"
			onScroll={scrollBody ? handleBodyScroll : undefined}
			{...longPress.handlers}
			ref={measureRef}
		>
			{showWords && words
				? words.map((word, index) => (
						<Fragment key={`${word.start}-${word.end}-${word.text}`}>
							{index > 0 ? " " : null}
							{onSeekWord ? (
								<button
									// Inline jump target: reads as text but seeks playback to this
									// word's start on click/Enter. `type=button` so it never submits;
									// the separator space stays OUTSIDE the button (keeps the
									// highlight tight and the click target on the word itself).
									className={cn(
										"cursor-pointer rounded-[3px] transition-[color,background-color,opacity] duration-300 ease-out hover:bg-foreground/10",
										wordStatusClass(index, activeIndex),
									)}
									onClick={() => onSeekWord(index)}
									ref={index === activeIndex ? setActiveWord : undefined}
									type="button"
								>
									{word.text}
								</button>
							) : (
								<span
									className={cn(
										"rounded-[3px] transition-[color,background-color,opacity] duration-300 ease-out",
										wordStatusClass(index, activeIndex),
									)}
									ref={index === activeIndex ? setActiveWord : undefined}
								>
									{word.text}
								</span>
							)}
						</Fragment>
					))
				: (highlightedText ?? displayText)}
		</p>
	);

	if (scrollBody || !(clamped || diff)) {
		return paragraph;
	}
	return (
		<FullTranscriptHover diff={diff} label={viewFullLabel} text={displayText}>
			{paragraph}
		</FullTranscriptHover>
	);
}
