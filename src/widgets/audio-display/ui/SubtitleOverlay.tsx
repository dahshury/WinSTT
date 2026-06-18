import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "@/entities/setting";
import {
	colorForSpeaker,
	dominantSpeaker,
	SpeakerTextChunks,
	speakerCount,
	type TranscriptionItem,
	splitTextBySpeaker,
	useTranscriptionStore,
} from "@/entities/transcription";
import { ScrollArea } from "@/shared/ui/scroll-area";

const VISIBLE_COUNT = 3;
const LISTEN_VISIBLE_COUNT = 160;
const FADE_OPACITIES = [1, 0.4, 0.15];

/** Normal PTT/toggle captions should clear quickly once the final line lands. */
const FADE_AFTER_MS = 500;
/** Normal PTT/toggle captions are fully transparent after this many ms. */
const GONE_AFTER_MS = 1100;
const SUBTITLE_EXIT_TRANSITION = "opacity 140ms ease-out";
const SUBTITLE_TEXT_SHADOW = "0 1px 4px var(--color-overlay-text-shadow)";

/** Ephemeral status messages (e.g. "no audio detected") fade faster. */
const EPHEMERAL_FADE_AFTER_MS = 2000;
const EPHEMERAL_GONE_AFTER_MS = 3000;

function fadeBetween(
	timestamp: number,
	now: number,
	fadeAfter: number,
	goneAfter: number,
): number {
	const age = now - timestamp;
	if (age < fadeAfter) {
		return 1;
	}
	if (age > goneAfter) {
		return 0;
	}
	return 1 - (age - fadeAfter) / (goneAfter - fadeAfter);
}

function timeFade(timestamp: number, now: number): number {
	return fadeBetween(timestamp, now, FADE_AFTER_MS, GONE_AFTER_MS);
}

function OverlayLineText({ item }: { item: TranscriptionItem }) {
	const segments = item.speakerSegments;
	const distinctSpeakers = speakerCount(segments);
	// `dir="auto"` on the text wrapper lets the bidi algorithm pick base
	// direction from the transcription itself — keeping it off the parent <p>
	// so an LTR "Speaker N:" prefix doesn't force the Arabic text the wrong way.
	if (!segments || segments.length === 0) {
		return <span dir="auto">{item.text}</span>;
	}
	if (distinctSpeakers <= 1) {
		const color = colorForSpeaker(segments[0]?.speaker ?? -1);
		return (
			<span dir="auto" style={{ color }}>
				{item.text}
			</span>
		);
	}
	const chunks = splitTextBySpeaker(item.text, segments);
	return (
		<span dir="auto">
			<SpeakerTextChunks chunks={chunks} itemId={item.id} />
		</span>
	);
}

export function SubtitleOverlay() {
	const items = useTranscriptionStore((s) => s.items);
	const currentRealtime = useTranscriptionStore((s) => s.currentRealtime);
	const ephemeral = useTranscriptionStore((s) => s.ephemeral);
	const clearEphemeral = useTranscriptionStore((s) => s.clearEphemeral);
	const isListenMode =
		useSettingsStore((s) => s.settings.general?.recordingMode) === "listen";
	const liveDisplay = useSettingsStore(
		(s) => s.settings.general?.liveTranscriptionDisplay ?? "both",
	);
	const showInApp =
		isListenMode || liveDisplay === "in-app" || liveDisplay === "both";
	const liveText = showInApp ? currentRealtime : "";
	const scrollRef = useRef<HTMLDivElement>(null);

	// Time-based fading depends on a re-render trigger. `now` is stored in
	// state and refreshed by the same effects that schedule the re-render,
	// keeping the render pure (no `Date.now()` read during render).
	//
	// Two trigger sources:
	//   1. A 250ms interval while there is content to fade (normal-mode items /
	//      ephemeral). No interval when there's nothing on screen — saves a 4Hz wakeup.
	//      The interval ALSO double-duties as the fully-faded-ephemeral
	//      eviction trigger: when it ticks, it recomputes ephemeral opacity
	//      inline and calls `clearEphemeral()` if the entry has fully faded,
	//      so there's no separate "watcher" effect that mirrors derived state.
	//   2. `visibilitychange` -> visible. Chromium throttles setInterval to
	//      ~1/minute when the renderer is backgrounded, so a window that's
	//      been hidden a while paints the previous `now` from when the timer
	//      was last allowed to run — making items appear "young" and showing
	//      the previous transcription's text for ~250ms after re-show. The
	//      visibility-driven force-tick runs before the first post-show
	//      paint, so items past their fade window collapse to opacity 0
	//      immediately and there is no stale flash.
	const [now, setNow] = useState(() => Date.now());
	const hasTimedSubtitleContent =
		!isListenMode &&
		items
			.slice(-VISIBLE_COUNT)
			.some((item) => timeFade(item.timestamp, now) > 0);
	const hasFadingContent = hasTimedSubtitleContent || ephemeral !== null;
	useEffect(() => {
		if (!hasFadingContent) {
			return;
		}
		const id = setInterval(() => {
			const tickNow = Date.now();
			setNow(tickNow);
			// Read the live ephemeral straight from the store so the eviction
			// decision uses the latest value — closing over the render-time
			// `ephemeral` would lag a tick behind cross-window updates.
			const liveEphemeral = useTranscriptionStore.getState().ephemeral;
			if (liveEphemeral) {
				const op = fadeBetween(
					liveEphemeral.timestamp,
					tickNow,
					EPHEMERAL_FADE_AFTER_MS,
					EPHEMERAL_GONE_AFTER_MS,
				);
				if (op <= 0) {
					clearEphemeral();
				}
			}
		}, 250);
		return () => clearInterval(id);
	}, [hasFadingContent, clearEphemeral]);
	useEffect(() => {
		const onVisible = () => {
			if (document.visibilityState === "visible") {
				setNow(Date.now());
			}
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, []);

	const ephemeralOpacity = ephemeral
		? fadeBetween(
				ephemeral.timestamp,
				now,
				EPHEMERAL_FADE_AFTER_MS,
				EPHEMERAL_GONE_AFTER_MS,
			)
		: 0;

	// Auto-scroll to bottom in listen mode when content changes.
	// items.length and liveText are intentional triggers (not used in the body).
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional scroll triggers
	useEffect(() => {
		if (isListenMode && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [isListenMode, items.length, liveText]);

	const showEphemeral = ephemeral !== null && ephemeralOpacity > 0;

	if (isListenMode) {
		const listenItems = items.slice(-LISTEN_VISIBLE_COUNT);
		const hasContent = listenItems.length > 0 || liveText || showEphemeral;
		if (!hasContent) {
			return null;
		}

		// Listen mode keeps a bounded rolling caption feed. Old rows are trimmed
		// from the rendered set only after they have scrolled out of view, so the
		// visible text keeps flowing naturally instead of collapsing or re-centering.
		return (
			<ScrollArea
				className="titlebar-no-drag absolute inset-0"
				style={{
					maskImage:
						"linear-gradient(to bottom, transparent 0%, var(--color-overlay-surface) 14%, var(--color-overlay-surface) 100%)",
					WebkitMaskImage:
						"linear-gradient(to bottom, transparent 0%, var(--color-overlay-surface) 14%, var(--color-overlay-surface) 100%)",
					// Scrim so subtitles stay legible over arbitrary video.
					background:
						"linear-gradient(to top, var(--color-subtitle-scrim-strong) 0%, var(--color-subtitle-scrim-medium) 55%, var(--color-subtitle-scrim-soft) 100%)",
				}}
				viewportRef={scrollRef}
			>
				{/* `min-h-full` + `justify-end` on the *content* (not the
				    scroll viewport) bottom-aligns short content yet lets it
				    overflow downward once it exceeds the viewport. Putting
				    `justify-end` on the viewport itself clipped the overflow
				    at the top and made it unreachable, so older lines never
				    scrolled away and `scrollTop = scrollHeight` was a no-op. */}
				<div className="flex min-h-full flex-col justify-end gap-2 px-6 pt-14 pb-4">
					{listenItems.map((item) => {
						const spk = dominantSpeaker(item.speakerSegments);
						const color = spk >= 0 ? colorForSpeaker(spk) : undefined;
						return (
							<p
								className="font-sans text-foreground text-title leading-snug"
								data-subtitle-line="true"
								key={item.id}
								style={{
									...(color ? { color } : {}),
									textShadow: SUBTITLE_TEXT_SHADOW,
								}}
							>
								{spk >= 0 ? (
									<span className="font-semibold">{`Speaker ${spk + 1}: `}</span>
								) : null}
								<OverlayLineText item={item} />
							</p>
						);
					})}
					{liveText ? (
						<p
							className="font-sans text-foreground/75 text-title leading-snug"
							data-subtitle-line="live"
							dir="auto"
							style={{ textShadow: SUBTITLE_TEXT_SHADOW }}
						>
							{liveText}
						</p>
					) : null}
					{showEphemeral && ephemeral ? (
						<p
							className="font-sans text-body text-foreground/70 italic leading-snug"
							data-subtitle-line="ephemeral"
							dir="auto"
							style={{ opacity: ephemeralOpacity }}
						>
							{ephemeral.text}
						</p>
					) : null}
				</div>
			</ScrollArea>
		);
	}

	// Normal mode — show last 3 items with discrete opacity + time-based fade
	const visibleItems = items.slice(-VISIBLE_COUNT);
	const visibleSubtitleItems: { item: TranscriptionItem; opacity: number }[] =
		[];
	for (const [index, item] of visibleItems.entries()) {
		const age = visibleItems.length - 1 - index;
		const positionOpacity = FADE_OPACITIES[age] ?? 0.1;
		const tf = timeFade(item.timestamp, now);
		const opacity = Math.min(positionOpacity, tf);
		if (opacity > 0) {
			visibleSubtitleItems.push({ item, opacity });
		}
	}
	const hasContent =
		visibleSubtitleItems.length > 0 || liveText || showEphemeral;

	if (!hasContent) {
		return null;
	}

	return (
		<div
			className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center justify-end gap-0.5 px-5 pt-8 pb-2"
			style={{
				background:
					"linear-gradient(to bottom, transparent 0%, var(--color-subtitle-scrim-bottom) 100%)",
			}}
		>
			{visibleSubtitleItems.map(({ item, opacity }) => {
				return (
					<p
						className="max-w-full text-center font-sans text-body text-foreground leading-snug"
						data-subtitle-line="true"
						dir="auto"
						key={item.id}
						style={{ opacity, transition: SUBTITLE_EXIT_TRANSITION }}
					>
						{item.text}
					</p>
				);
			})}
			{liveText ? (
				<p
					className="max-w-full text-center font-sans text-body text-foreground/60 italic leading-snug"
					data-subtitle-line="live"
					dir="auto"
				>
					{liveText}
				</p>
			) : null}
			{showEphemeral && ephemeral ? (
				<p
					className="max-w-full text-center font-sans text-body text-foreground/70 italic leading-snug"
					data-subtitle-line="ephemeral"
					dir="auto"
					style={{ opacity: ephemeralOpacity }}
				>
					{ephemeral.text}
				</p>
			) : null}
		</div>
	);
}
