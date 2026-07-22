import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { useSettingsStore } from "@/entities/setting";
import {
	type TranscriptionItem,
	useTranscriptionStore,
} from "@/entities/transcription";
import { ScrollArea } from "@/shared/ui/scroll-area";

const VISIBLE_COUNT = 3;
const LISTEN_VISIBLE_COUNT = 160;
const FADE_OPACITIES = [1, 0.4, 0.15];

/** Diarization palette size — ids cycle through --color-speaker-0..7. */
const SPEAKER_PALETTE_SIZE = 8;

/** CSS color for a diarized caption row; undefined keeps the default foreground. */
function speakerColor(speaker: number | null | undefined): string | undefined {
	if (speaker == null || speaker < 0) {
		return undefined;
	}
	return `var(--color-speaker-${speaker % SPEAKER_PALETTE_SIZE})`;
}

/** Tinted chip background for a speaker badge (token-derived, no raw colors). */
function speakerBadgeBackground(speaker: number): string {
	return `color-mix(in oklab, var(--color-speaker-${speaker % SPEAKER_PALETTE_SIZE}) 22%, transparent)`;
}

/**
 * A run of consecutive captions attributed to the same speaker, rendered as one
 * visual block with a leading `S<n>` badge (WhoSpeaksLive's live-panel layout).
 * `speaker` is null for unattributed rows (diarization off / unknown span).
 */
interface SpeakerBlock {
	key: string;
	speaker: number | null;
	items: TranscriptionItem[];
}

export function groupBySpeaker(items: TranscriptionItem[]): SpeakerBlock[] {
	const blocks: SpeakerBlock[] = [];
	for (const item of items) {
		const speaker =
			item.speaker != null && item.speaker >= 0 ? item.speaker : null;
		const last = blocks.at(-1);
		if (last && last.speaker === speaker) {
			last.items.push(item);
		} else {
			blocks.push({ key: item.id, speaker, items: [item] });
		}
	}
	return blocks;
}

/**
 * Distance (px) from the bottom within which the transcript counts as "pinned":
 * new content keeps auto-scrolling. Scrolling further up releases the pin so the
 * user can read history without the feed yanking them back down.
 */
const PIN_THRESHOLD_PX = 32;

/** Normal PTT/toggle captions should clear quickly once the final line lands. */
const FADE_AFTER_MS = 500;
/** Normal PTT/toggle captions are fully transparent after this many ms. */
const GONE_AFTER_MS = 1100;
const SUBTITLE_EXIT_TRANSITION = "opacity 140ms ease-out";
const SUBTITLE_TEXT_SHADOW = "0 1px 4px var(--color-overlay-text-shadow)";

/** Ephemeral status messages (e.g. "no audio detected") fade faster. */
const EPHEMERAL_FADE_AFTER_MS = 2000;
const EPHEMERAL_GONE_AFTER_MS = 3000;

type OpacityFadeSource = readonly [
	timestamp: number,
	fadeAfter: number,
	goneAfter: number,
	maximumOpacity: number,
];

function sourceOpacity(source: OpacityFadeSource, now: number): number {
	const [timestamp, fadeAfter, goneAfter, maximumOpacity] = source;
	return Math.min(
		maximumOpacity,
		fadeBetween(timestamp, now, fadeAfter, goneAfter),
	);
}

/**
 * Build the exact piecewise-linear envelope produced by max(source opacities).
 * WAAPI can then run the fade on the compositor instead of waking React at 4Hz.
 */
function opacityEnvelopeKeyframes(
	sources: OpacityFadeSource[],
	start: number,
): { duration: number; keyframes: Keyframe[] } | null {
	const end = Math.max(
		start,
		...sources.map(([timestamp, , goneAfter]) => timestamp + goneAfter),
	);
	if (end <= start) {
		return null;
	}

	const boundaries = new Set<number>([start, end]);
	for (const [timestamp, fadeAfter, goneAfter, maximumOpacity] of sources) {
		const fadeDuration = goneAfter - fadeAfter;
		const plateauEnd =
			timestamp + fadeAfter + (1 - maximumOpacity) * fadeDuration;
		if (plateauEnd > start && plateauEnd < end) {
			boundaries.add(plateauEnd);
		}
		const goneAt = timestamp + goneAfter;
		if (goneAt > start && goneAt < end) {
			boundaries.add(goneAt);
		}
	}

	// Between boundaries every source is linear. Add any pairwise crossing so
	// the max envelope remains exact when its leading source changes.
	const baseBoundaries = [...boundaries].sort((a, b) => a - b);
	for (let index = 0; index < baseBoundaries.length - 1; index += 1) {
		const left = baseBoundaries[index];
		const right = baseBoundaries[index + 1];
		if (left == null || right == null) {
			continue;
		}
		for (let a = 0; a < sources.length; a += 1) {
			for (let b = a + 1; b < sources.length; b += 1) {
				const sourceA = sources[a];
				const sourceB = sources[b];
				if (!(sourceA && sourceB)) {
					continue;
				}
				const leftDifference =
					sourceOpacity(sourceA, left) - sourceOpacity(sourceB, left);
				const rightDifference =
					sourceOpacity(sourceA, right) - sourceOpacity(sourceB, right);
				if (leftDifference * rightDifference < 0) {
					boundaries.add(
						left +
							(-leftDifference * (right - left)) /
								(rightDifference - leftDifference),
					);
				}
			}
		}
	}

	const duration = end - start;
	return {
		duration,
		keyframes: [...boundaries]
			.sort((a, b) => a - b)
			.map((time) => ({
				offset: (time - start) / duration,
				opacity: Math.max(
					0,
					...sources.map((source) => sourceOpacity(source, time)),
				),
			})),
	};
}

function useOpacityEnvelopeAnimation(sourceKey: string) {
	const elementRef = useRef<HTMLElement>(null);
	useEffect(() => {
		const element = elementRef.current;
		const sources = JSON.parse(sourceKey) as OpacityFadeSource[];
		if (!(element && sources.length > 0)) {
			return;
		}
		const envelope = opacityEnvelopeKeyframes(sources, Date.now());
		if (!(envelope && typeof element.animate === "function")) {
			return;
		}
		const animation = element.animate(envelope.keyframes, {
			duration: envelope.duration,
			easing: "linear",
			fill: "forwards",
		});
		return () => animation.cancel();
	}, [sourceKey]);
	return elementRef;
}

function TimedSubtitleLine({
	item,
	opacity,
	maximumOpacity,
}: {
	item: TranscriptionItem;
	opacity: number;
	maximumOpacity: number;
}) {
	const sourceKey = JSON.stringify([
		[item.timestamp, FADE_AFTER_MS, GONE_AFTER_MS, maximumOpacity],
	]);
	const ref = useOpacityEnvelopeAnimation(sourceKey);
	return (
		<p
			className="relative max-w-full text-center font-sans text-body text-foreground leading-snug"
			data-subtitle-line="true"
			dir="auto"
			ref={ref as Ref<HTMLParagraphElement>}
			style={{ opacity, transition: SUBTITLE_EXIT_TRANSITION }}
		>
			{item.text}
		</p>
	);
}

function TimedOpacityElement({
	as: Element,
	children,
	className,
	dataAttribute,
	dir,
	opacity,
	sources,
}: {
	as: "div" | "p";
	children?: ReactNode;
	className: string;
	dataAttribute: Record<string, string>;
	dir?: "auto";
	opacity: number;
	sources: OpacityFadeSource[];
}) {
	const ref = useOpacityEnvelopeAnimation(JSON.stringify(sources));
	return (
		<Element
			{...dataAttribute}
			aria-hidden={Element === "div" ? true : undefined}
			className={className}
			dir={dir}
			ref={ref as Ref<HTMLDivElement & HTMLParagraphElement>}
			style={{ opacity, transition: SUBTITLE_EXIT_TRANSITION }}
		>
			{children}
		</Element>
	);
}

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

	// WAAPI owns the continuous, piecewise-linear opacity curve. React only
	// wakes at a real expiry boundary so it can remove a finished subtitle (and
	// evict an ephemeral entry), rather than polling the clock four times a second.
	const [now, setNow] = useState(() => Date.now());
	const expiryScheduleKey = JSON.stringify({
		normal: isListenMode
			? []
			: items
					.slice(-VISIBLE_COUNT)
					.map((item) => item.timestamp + GONE_AFTER_MS),
		ephemeral: ephemeral
			? [ephemeral.timestamp, ephemeral.timestamp + EPHEMERAL_GONE_AFTER_MS]
			: null,
	});
	useEffect(() => {
		const schedule = JSON.parse(expiryScheduleKey) as {
			normal: number[];
			ephemeral: [timestamp: number, deadline: number] | null;
		};
		const nextNormalExpiry = Math.min(
			...schedule.normal.filter((deadline) => deadline > now),
		);
		const nextExpiry = Math.min(
			nextNormalExpiry,
			schedule.ephemeral?.[1] ?? Number.POSITIVE_INFINITY,
		);
		if (!Number.isFinite(nextExpiry)) {
			return;
		}
		const id = window.setTimeout(
			() => {
				const tickNow = Date.now();
				setNow(tickNow);
				const liveEphemeral = useTranscriptionStore.getState().ephemeral;
				if (
					schedule.ephemeral &&
					liveEphemeral?.timestamp === schedule.ephemeral[0] &&
					tickNow >= schedule.ephemeral[1]
				) {
					clearEphemeral();
				}
			},
			Math.max(0, Math.ceil(nextExpiry - Date.now())),
		);
		return () => window.clearTimeout(id);
	}, [clearEphemeral, expiryScheduleKey, now]);
	useEffect(() => {
		const onVisible = () => {
			if (document.visibilityState === "visible") {
				const visibleNow = Date.now();
				setNow(visibleNow);
				const liveEphemeral = useTranscriptionStore.getState().ephemeral;
				if (
					liveEphemeral &&
					visibleNow >= liveEphemeral.timestamp + EPHEMERAL_GONE_AFTER_MS
				) {
					clearEphemeral();
				}
			}
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [clearEphemeral]);

	const ephemeralOpacity = ephemeral
		? fadeBetween(
				ephemeral.timestamp,
				now,
				EPHEMERAL_FADE_AFTER_MS,
				EPHEMERAL_GONE_AFTER_MS,
			)
		: 0;

	// Stick-to-bottom scrolling for the listen transcript. The old one-shot
	// `scrollTop = scrollHeight` on content changes raced layout: a freshly
	// committed multi-line caption grows the content AFTER the effect ran, so the
	// feed ended up under-scrolled with its last lines cut off below the window.
	//
	// Pin protocol: pinned by default; ONLY a user wheel-up can unpin. Programmatic
	// pins are recognized by their target POSITION so their own scroll events never
	// read as user intent, and the viewport runs with `overflow-anchor: none` (see
	// the ScrollArea below) because Chrome's scroll anchoring emits browser-initiated
	// scroll events on content append that would otherwise unpin the feed.
	//
	// CRITICAL: rendering-driven callbacks (rAF, ResizeObserver, even scroll-event
	// dispatch) are SUSPENDED while the window is hidden/fully occluded — Chromium
	// only runs them in rendering steps. Every safety net here therefore also has a
	// timer/effect leg (timers keep running when hidden) plus a visibilitychange
	// pin, so the transcript is never stranded under-scrolled when the window is
	// covered by the video the user is listening to and then revealed.
	const pinnedRef = useRef(true);
	const pinTargetRef = useRef<number | null>(null);
	useEffect(() => {
		const viewport = scrollRef.current;
		if (!(isListenMode && viewport)) {
			return;
		}
		const onScroll = () => {
			const target = pinTargetRef.current;
			if (target != null) {
				// A pin is in flight: its scroll events must never read as user
				// intent (rapid growth re-pins can update the target before the
				// previous echo lands). Clear the marker once the bottom arrives.
				if (viewport.scrollTop >= target - 2) {
					pinTargetRef.current = null;
				}
				return;
			}
			pinnedRef.current =
				viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
				PIN_THRESHOLD_PX;
		};
		const pin = () => {
			const target = viewport.scrollHeight - viewport.clientHeight;
			if (!pinnedRef.current || viewport.scrollTop >= target) {
				return;
			}
			pinTargetRef.current = target;
			viewport.scrollTop = viewport.scrollHeight;
		};
		// Wheel-up unpins SYNCHRONOUSLY (before any scroll event lands) and
		// cancels the in-flight pin, closing the race where a content-growth pin
		// fires between the user's gesture and its scroll event and drags them
		// back to the bottom mid-read. Wheel-down re-checks after the browser
		// applies the scroll (timer, NOT rAF — rAF stalls when hidden): reaching
		// the bottom re-pins even when the stream grew in the same instant.
		const onWheel = (event: WheelEvent) => {
			if (event.deltaY < 0) {
				pinnedRef.current = false;
				pinTargetRef.current = null;
				return;
			}
			window.setTimeout(() => {
				if (
					viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
					PIN_THRESHOLD_PX
				) {
					pinnedRef.current = true;
					pin();
				}
			}, 0);
		};
		// A hidden window suspends scroll/RO/rAF; on reveal, re-pin immediately so
		// everything that accumulated while covered lands with the bottom in view.
		const onVisible = () => {
			if (document.visibilityState === "visible") {
				pin();
			}
		};
		viewport.addEventListener("scroll", onScroll, { passive: true });
		viewport.addEventListener("wheel", onWheel, { passive: true });
		document.addEventListener("visibilitychange", onVisible);
		pin();
		// Belt and suspenders for growth whose rendering callbacks stall or land
		// late (hidden window, post-layout settle): timer pins fire regardless of
		// rendering state.
		const t1 = window.setTimeout(pin, 0);
		const t2 = window.setTimeout(pin, 120);
		const observer = new ResizeObserver(pin);
		// Observe the viewport (clientHeight changes) AND its content subtree root
		// (scrollHeight changes) — either can strand the bottom out of view.
		observer.observe(viewport);
		for (const child of Array.from(viewport.children)) {
			observer.observe(child);
		}
		return () => {
			viewport.removeEventListener("scroll", onScroll);
			viewport.removeEventListener("wheel", onWheel);
			document.removeEventListener("visibilitychange", onVisible);
			window.clearTimeout(t1);
			window.clearTimeout(t2);
			observer.disconnect();
		};
		// items + liveText re-run the effect on every content change so the
		// immediate + timer pins fire for each committed row and live-text growth
		// tick — this leg works even while the window is hidden.
	}, [isListenMode, items, liveText]);

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
				// Scroll anchoring must be OFF: appended captions otherwise make
				// Chrome emit browser-initiated scroll adjustments that the pin
				// heuristic would misread as the user scrolling away (see the
				// stick-to-bottom effect above).
				viewportStyle={{ overflowAnchor: "none" }}
			>
				{/* `min-h-full` + `justify-end` on the *content* (not the
				    scroll viewport) bottom-aligns short content yet lets it
				    overflow downward once it exceeds the viewport. Putting
				    `justify-end` on the viewport itself clipped the overflow
				    at the top and made it unreachable, so older lines never
				    scrolled away and pinning to the bottom was a no-op. */}
				<div className="flex min-h-full flex-col justify-end gap-3 px-6 pt-14 pb-4">
					{groupBySpeaker(listenItems).map((block) => (
						<div
							className="flex flex-col gap-1"
							data-speaker-block={block.speaker ?? "unknown"}
							dir="auto"
							key={block.key}
						>
							{block.speaker == null ? null : (
								<span
									aria-hidden
									className="w-fit select-none rounded-md px-1.5 py-0.5 font-medium font-sans text-caption leading-none"
									data-speaker-badge={block.speaker}
									style={{
										color: speakerColor(block.speaker),
										background: speakerBadgeBackground(block.speaker),
									}}
								>
									{`S${block.speaker + 1}`}
								</span>
							)}
							{block.items.map((item) => (
								<p
									className="break-words font-sans text-foreground text-title leading-snug"
									data-speaker={item.speaker ?? undefined}
									data-subtitle-line="true"
									dir="auto"
									key={item.id}
									style={{
										textShadow: SUBTITLE_TEXT_SHADOW,
										color: speakerColor(block.speaker),
									}}
								>
									{item.text}
								</p>
							))}
						</div>
					))}
					{liveText ? (
						<p
							className="break-words font-sans text-foreground-muted text-title italic leading-snug"
							data-subtitle-line="live"
							dir="auto"
							style={{ textShadow: SUBTITLE_TEXT_SHADOW }}
						>
							{liveText}
						</p>
					) : null}
					{showEphemeral && ephemeral ? (
						<TimedOpacityElement
							as="p"
							className="font-sans text-body text-foreground/70 italic leading-snug"
							dataAttribute={{ "data-subtitle-line": "ephemeral" }}
							dir="auto"
							opacity={ephemeralOpacity}
							sources={[
								[
									ephemeral.timestamp,
									EPHEMERAL_FADE_AFTER_MS,
									EPHEMERAL_GONE_AFTER_MS,
									1,
								],
							]}
						>
							{ephemeral.text}
						</TimedOpacityElement>
					) : null}
				</div>
			</ScrollArea>
		);
	}

	// Normal mode — show last 3 items with discrete opacity + time-based fade
	const visibleItems = items.slice(-VISIBLE_COUNT);
	const visibleSubtitleItems: {
		item: TranscriptionItem;
		opacity: number;
		maximumOpacity: number;
	}[] = [];
	for (const [index, item] of visibleItems.entries()) {
		const age = visibleItems.length - 1 - index;
		const positionOpacity = FADE_OPACITIES[age] ?? 0.1;
		const tf = timeFade(item.timestamp, now);
		const opacity = Math.min(positionOpacity, tf);
		if (opacity > 0) {
			visibleSubtitleItems.push({
				item,
				opacity,
				maximumOpacity: positionOpacity,
			});
		}
	}
	const hasContent =
		visibleSubtitleItems.length > 0 || liveText || showEphemeral;

	if (!hasContent) {
		return null;
	}

	// The scrim tracks the strongest visible line so it dissolves in step with
	// the captions instead of lingering as (or popping out from) a dark band.
	const scrimOpacity = liveText
		? 1
		: Math.max(
				0,
				...visibleSubtitleItems.map(({ opacity }) => opacity),
				showEphemeral ? ephemeralOpacity : 0,
			);
	const scrimSources: OpacityFadeSource[] = liveText
		? []
		: [
				...visibleSubtitleItems.map(
					({ item, maximumOpacity }) =>
						[
							item.timestamp,
							FADE_AFTER_MS,
							GONE_AFTER_MS,
							maximumOpacity,
						] as const,
				),
				...(showEphemeral && ephemeral
					? [
							[
								ephemeral.timestamp,
								EPHEMERAL_FADE_AFTER_MS,
								EPHEMERAL_GONE_AFTER_MS,
								1,
							] as const,
						]
					: []),
			];

	return (
		<div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center justify-end gap-0.5 px-5 pt-10 pb-2">
			<TimedOpacityElement
				as="div"
				className="subtitle-scrim-bloom absolute inset-0"
				dataAttribute={{ "data-subtitle-scrim": "true" }}
				opacity={scrimOpacity}
				sources={scrimSources}
			/>
			{visibleSubtitleItems.map(({ item, opacity, maximumOpacity }) => (
				<TimedSubtitleLine
					item={item}
					key={item.id}
					maximumOpacity={maximumOpacity}
					opacity={opacity}
				/>
			))}
			{liveText ? (
				<p
					className="relative max-w-full text-center font-sans text-body text-foreground/60 italic leading-snug"
					data-subtitle-line="live"
					dir="auto"
				>
					{liveText}
				</p>
			) : null}
			{showEphemeral && ephemeral ? (
				<TimedOpacityElement
					as="p"
					className="relative max-w-full text-center font-sans text-body text-foreground/70 italic leading-snug"
					dataAttribute={{ "data-subtitle-line": "ephemeral" }}
					dir="auto"
					opacity={ephemeralOpacity}
					sources={[
						[
							ephemeral.timestamp,
							EPHEMERAL_FADE_AFTER_MS,
							EPHEMERAL_GONE_AFTER_MS,
							1,
						],
					]}
				>
					{ephemeral.text}
				</TimedOpacityElement>
			) : null}
		</div>
	);
}
