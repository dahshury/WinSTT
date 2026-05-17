"use client";

import { memo, useEffect, useRef, useState } from "react";
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
					key={`${item.id}-${chunk.speaker}-${i}`}
					style={{ color: colorForSpeaker(chunk.speaker) }}
				>
					{i > 0 ? " " : ""}
					{chunk.text}
				</span>
			))}
		</>
	);
}

export const SubtitleOverlay = memo(function SubtitleOverlay() {
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
	const [now, setNow] = useState(Date.now);

	// Tick every 250ms so time-based fading (incl. shorter ephemeral fade) stays smooth.
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(id);
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

		return (
			<ScrollArea
				className="titlebar-no-drag absolute inset-0"
				style={{
					maskImage: "linear-gradient(to bottom, transparent 0%, black 40%)",
					WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 40%)",
				}}
				viewportClassName="flex flex-col justify-end"
				viewportRef={scrollRef}
			>
				<div className="flex flex-col items-center gap-0.5 px-5 pt-12 pb-3">
					{items.map((item) => {
						const tf = timeFade(item.timestamp, now);
						if (tf <= 0) {
							return null;
						}
						return (
							<p
								className="max-w-full text-center font-sans text-body text-foreground leading-snug"
								key={item.id}
								style={{ opacity: tf, transition: "opacity 300ms ease-out" }}
							>
								<OverlayLineText item={item} />
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
});
