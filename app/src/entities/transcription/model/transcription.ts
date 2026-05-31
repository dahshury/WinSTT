import type { components } from "@spec/schema";

type BaseTranscriptionItem = components["schemas"]["TranscriptionItem"];

export interface SpeakerSegment {
	end: number;
	speaker: number;
	start: number;
}

/**
 * Live-feed transcription item. Spec ``TranscriptionItem`` carries
 * ``id|type|text|timestamp``; we add an optional ``speakerSegments`` that
 * arrives in a separate ``STT_SPEAKER_SEGMENTS`` event right after the
 * matching ``fullSentence`` when diarization is enabled. The renderer
 * uses it to color words per speaker; absence = single-speaker render.
 */
export type TranscriptionItem = BaseTranscriptionItem & {
	speakerSegments?: SpeakerSegment[];
};

export function createTranscriptionItem(
	type: TranscriptionItem["type"],
	text: string,
	id: string = crypto.randomUUID(),
	timestamp: number = Date.now()
): TranscriptionItem {
	return { id, type, text, timestamp };
}
