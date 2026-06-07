import { colorForSpeaker } from "../lib/speaker-color";
import type { SpeakerTextChunk } from "../lib/speaker-text";

export interface SpeakerTextChunksProps {
	chunks: SpeakerTextChunk[];
	itemId: string;
}

export function SpeakerTextChunks({ chunks, itemId }: SpeakerTextChunksProps) {
	return (
		<>
			{chunks.map((chunk, i) => (
				<span
					key={`${itemId}-${chunk.speaker}-${chunk.text.slice(0, 16)}-${i}`}
					style={{ color: colorForSpeaker(chunk.speaker) }}
				>
					{i > 0 ? " " : ""}
					{chunk.text}
				</span>
			))}
		</>
	);
}
