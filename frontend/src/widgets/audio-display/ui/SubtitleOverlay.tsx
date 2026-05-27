import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "@/entities/setting";
import {
	colorForSpeaker,
	type SpeakerSegment,
	type TranscriptionItem,
	useTranscriptionStore,
} from "@/entities/transcription";
import { ScrollArea } from "@/shared/ui/scroll-area";

const VISIBLE_COUNT = 3;
const FADE_OPACITIES = [1, 0.4, 0.15];

/** Items start fading after this many ms since their timestamp. */
const FADE_AFTER_MS = 5000;
/** Items are fully transparent after this many ms. */
const GONE_AFTER_MS = 8000;

/** Ephemeral status messages (e.g. "no audio detected") fade faster. */
const EPHEMERAL_FADE_AFTER_MS = 2000;
const EPHEMERAL_GONE_AFTER_MS = 3000;

const WHITESPACE_SPLIT = /\s+/;

function fadeBetween(timestamp: number, now: number, fadeAfter: number, goneAfter: number): number {
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

/** Split text into word-count chunks weighted by each segment's duration share. */
function splitTextBySpeaker(
	text: string,
	segments: SpeakerSegment[]
): { speaker: number; text: string }[] {
	const trimmed = text.trim();
	if (trimmed.length === 0 || segments.length === 0) {
		return [{ speaker: -1, text }];
	}
	const totalSpeech = segments.reduce((acc, s) => acc + Math.max(0, s.end - s.start), 0);
	if (totalSpeech <= 0) {
		return [{ speaker: segments[0]?.speaker ?? -1, text }];
	}
	const words = trimmed.split(WHITESPACE_SPLIT);
	if (words.length <= 1) {
		return [{ speaker: segments[0]?.speaker ?? -1, text }];
	}
	const chunks: { speaker: number; text: string }[] = [];
	let cursor = 0;
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		if (seg === undefined) {
			continue;
		}
		const share = Math.max(0, seg.end - seg.start) / totalSpeech;
		const wordCount =
			i === segments.length - 1
				? words.length - cursor
				: Math.max(1, Math.round(share * words.length));
		const end = Math.min(words.length, cursor + wordCount);
		if (end > cursor) {
			chunks.push({ speaker: seg.speaker, text: words.slice(cursor, end).join(" ") });
			cursor = end;
		}
	}
	if (cursor < words.length) {
		const lastSpeaker = segments.at(-1)?.speaker ?? -1;
		chunks.push({ speaker: lastSpeaker, text: words.slice(cursor).join(" ") });
	}
	return chunks;
}

/** Speaker owning the most speech time in an item, or -1 if undiarized. */
function dominantSpeaker(segments: SpeakerSegment[] | undefined): number {
	if (!segments || segments.length === 0) {
		return -1;
	}
	const totals = new Map<number, number>();
	for (const s of segments) {
		totals.set(s.speaker, (totals.get(s.speaker) ?? 0) + Math.max(0, s.end - s.start));
	}
	let best = -1;
	let bestDur = -1;
	for (const [spk, dur] of totals) {
		if (dur > bestDur) {
			bestDur = dur;
			best = spk;
		}
	}
	return best;
}

function OverlayLineText({ item }: { item: TranscriptionItem }) {
	const segments = item.speakerSegments;
	const distinctSpeakers = segments ? new Set(segments.map((s) => s.speaker)).size : 0;
	if (!segments || segments.length === 0) {
		return <>{item.text}</>;
	}
	if (distinctSpeakers <= 1) {
		const color = colorForSpeaker(segments[0]?.speaker ?? -1);
		return <span style={{ color }}>{item.text}</span>;
	}
	const chunks = splitTextBySpeaker(item.text, segments);
	return (
		<>
			{chunks.map((chunk, i) => (
				<span
					key={`${item.id}-${chunk.speaker}-${chunk.text.slice(0, 16)}-${i}`}
					style={{ color: colorForSpeaker(chunk.speaker) }}
				>
					{i > 0 ? " " : ""}
					{chunk.text}
				</span>
			))}
		</>
	);
}

export function SubtitleOverlay() {
	const items = useTranscriptionStore((s) => s.items);
	const currentRealtime = useTranscriptionStore((s) => s.currentRealtime);
	const ephemeral = useTranscriptionStore((s) => s.ephemeral);
	const clearEphemeral = useTranscriptionStore((s) => s.clearEphemeral);
	const isListenMode = useSettingsStore((s) => s.settings.general?.recordingMode) === "listen";
	const liveDisplay = useSettingsStore(
		(s) => s.settings.general?.liveTranscriptionDisplay ?? "both"
	);
	const showInApp = liveDisplay === "in-app" || liveDisplay === "both";
	const liveText = showInApp ? currentRealtime : "";
	const scrollRef = useRef<HTMLDivElement>(null);

	// Time-based fading depends on a re-render trigger. `now` is stored in
	// state and refreshed by the same effects that schedule the re-render,
	// keeping the render pure (no `Date.now()` read during render).
	//
	// Two trigger sources:
	//   1. A 250ms interval while there is content to fade (items / ephemeral).
	//      No interval when there's nothing on screen — saves a 4Hz wakeup.
	//   2. `visibilitychange` -> visible. Chromium throttles setInterval to
	//      ~1/minute when the renderer is backgrounded, so a window that's
	//      been hidden a while paints the previous `now` from when the timer
	//      was last allowed to run — making items appear "young" and showing
	//      the previous transcription's text for ~250ms after re-show. The
	//      visibility-driven force-tick runs before the first post-show
	//      paint, so items past their fade window collapse to opacity 0
	//      immediately and there is no stale flash.
	const [now, setNow] = useState(() => Date.now());
	const hasFadingContent = items.length > 0 || ephemeral !== null;
	useEffect(() => {
		if (!hasFadingContent) {
			return;
		}
		const id = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(id);
	}, [hasFadingContent]);
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
		? fadeBetween(ephemeral.timestamp, now, EPHEMERAL_FADE_AFTER_MS, EPHEMERAL_GONE_AFTER_MS)
		: 0;

	// Drop ephemeral from store once fully faded so it doesn't re-show on remount.
	useEffect(() => {
		if (ephemeral && ephemeralOpacity <= 0) {
			clearEphemeral();
		}
	}, [ephemeral, ephemeralOpacity, clearEphemeral]);

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
		const hasContent = items.length > 0 || liveText || showEphemeral;
		if (!hasContent) {
			return null;
		}

		// Rolling, speaker-colored transcript feed (movie-subtitle style):
		// every finalized utterance is kept and scrolls up under the top
		// fade as new ones arrive. No time-fade here (unlike PTT/Toggle) —
		// for a 2h movie the user wants scroll-back history, not lines that
		// vanish after a few seconds.
		return (
			<ScrollArea
				className="titlebar-no-drag absolute inset-0"
				style={{
					maskImage: "linear-gradient(to bottom, transparent 0%, black 14%, black 100%)",
					WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 14%, black 100%)",
					// Scrim so subtitles stay legible over arbitrary video.
					background:
						"linear-gradient(to top, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.34) 55%, rgba(0,0,0,0.08) 100%)",
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
					{items.map((item) => {
						const spk = dominantSpeaker(item.speakerSegments);
						const color = spk >= 0 ? colorForSpeaker(spk) : undefined;
						return (
							<p
								className="font-sans text-foreground text-title leading-snug [text-shadow:0_1px_4px_rgba(0,0,0,0.95)]"
								key={item.id}
								style={color ? { color } : undefined}
							>
								{spk >= 0 ? <span className="font-semibold">{`Speaker ${spk + 1}: `}</span> : null}
								<OverlayLineText item={item} />
							</p>
						);
					})}
					{liveText ? (
						<p className="font-sans text-foreground/75 text-title leading-snug [text-shadow:0_1px_4px_rgba(0,0,0,0.95)]">
							{liveText}
						</p>
					) : null}
					{showEphemeral && ephemeral ? (
						<p
							className="font-sans text-body text-foreground/70 italic leading-snug"
							style={{ opacity: ephemeralOpacity, transition: "opacity 200ms ease-out" }}
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
	const hasContent = visibleItems.length > 0 || liveText || showEphemeral;

	if (!hasContent) {
		return null;
	}

	return (
		<div
			className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center justify-end gap-0.5 px-5 pt-8 pb-2"
			style={{
				background: "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.55) 100%)",
			}}
		>
			{visibleItems.map((item, i) => {
				const age = visibleItems.length - 1 - i;
				const positionOpacity = FADE_OPACITIES[age] ?? 0.1;
				const tf = timeFade(item.timestamp, now);
				const opacity = Math.min(positionOpacity, tf);
				if (opacity <= 0) {
					return null;
				}
				return (
					<p
						className="max-w-full text-center font-sans text-body text-foreground leading-snug"
						key={item.id}
						style={{ opacity, transition: "opacity 300ms ease-out" }}
					>
						{item.text}
					</p>
				);
			})}
			{liveText && (
				<p className="max-w-full text-center font-sans text-body text-foreground/60 italic leading-snug">
					{liveText}
				</p>
			)}
			{showEphemeral && ephemeral && (
				<p
					className="max-w-full text-center font-sans text-body text-foreground/70 italic leading-snug"
					style={{ opacity: ephemeralOpacity, transition: "opacity 200ms ease-out" }}
				>
					{ephemeral.text}
				</p>
			)}
		</div>
	);
}
