import { colorForSpeaker } from "../lib/speaker-color";
import { speakerCount, splitTextBySpeaker } from "../lib/speaker-text";
import type { TranscriptionItem } from "../model/transcription";
import { SpeakerTextChunks } from "./SpeakerTextChunks";

export interface TranscriptionLineProps {
	index: number;
	item: TranscriptionItem;
}

export function TranscriptionLine({ item, index }: TranscriptionLineProps) {
	const isRealtime = item.type === "realtime";
	const segments = item.speakerSegments;
	const renderChunks =
		!isRealtime && segments && segments.length > 0 && speakerCount(segments) > 1
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
					accentColor === undefined
						? undefined
						: { backgroundColor: accentColor, opacity: 0.8 }
				}
			/>
			<span
				className={`break-words font-sans text-sm leading-relaxed ${isRealtime ? "text-foreground-muted italic" : "text-foreground"}`}
				dir="auto"
			>
				{renderChunks ? (
					<SpeakerTextChunks chunks={renderChunks} itemId={item.id} />
				) : (
					item.text
				)}
			</span>
		</div>
	);
}
