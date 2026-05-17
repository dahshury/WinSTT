import { colorForSpeaker } from "../lib/speaker-color";
import type { SpeakerSegment, TranscriptionItem } from "../model/transcription";

const WHITESPACE_SPLIT = /\s+/;

export interface TranscriptionLineProps {
	index: number;
	item: TranscriptionItem;
}

/**
 * Split ``text`` into per-speaker chunks weighted by segment duration.
 *
 * The diarizer emits ``segments`` in seconds; the transcriber gives us the
 * full sentence as one string with no per-word timing. We approximate by
 * splitting at word boundaries proportional to each segment's duration share
 * over the total speech time. This is good enough for short utterances
 * (the typical case) and gracefully degrades to "first speaker owns the
 * whole sentence" when the segments collapse to one cluster.
 */
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

export function TranscriptionLine({ item, index }: TranscriptionLineProps) {
	const isRealtime = item.type === "realtime";
	const segments = item.speakerSegments;
	const speakerCount = segments ? new Set(segments.map((s) => s.speaker)).size : 0;
	const renderChunks =
		!isRealtime && segments && segments.length > 0 && speakerCount > 1
			? splitTextBySpeaker(item.text, segments)
			: null;
	const accentColor =
		!isRealtime && segments && segments.length > 0
			? colorForSpeaker(segments[0]?.speaker ?? -1)
			: undefined;

	return (
		<div
			className="flex animate-fade-in gap-2 rounded px-3 py-1.5 motion-reduce:animate-none"
			style={{
				animationDelay: `${Math.min(index * 20, 200)}ms`,
				animationFillMode: "both",
			}}
		>
			<div
				className={`mt-1.5 h-3 w-0.5 shrink-0 rounded-full ${isRealtime ? "bg-foreground-dim" : "bg-accent opacity-60"}`}
				style={
					accentColor === undefined ? undefined : { backgroundColor: accentColor, opacity: 0.8 }
				}
			/>
			<span
				className={`break-words font-sans text-sm leading-relaxed ${isRealtime ? "text-foreground-muted italic" : "text-foreground"}`}
			>
				{renderChunks
					? renderChunks.map((chunk, i) => (
							<span
								key={`${item.id}-${chunk.speaker}-${i}`}
								style={{ color: colorForSpeaker(chunk.speaker) }}
							>
								{i > 0 ? " " : ""}
								{chunk.text}
							</span>
						))
					: item.text}
			</span>
		</div>
	);
}
