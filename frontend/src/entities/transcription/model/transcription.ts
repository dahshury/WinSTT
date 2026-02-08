import type { components } from "@spec/schema";

export type TranscriptionItem = components["schemas"]["TranscriptionItem"];
export type RecorderState = components["schemas"]["RecorderState"];

export function createTranscriptionItem(
	type: TranscriptionItem["type"],
	text: string
): TranscriptionItem {
	return {
		id: crypto.randomUUID(),
		type,
		text,
		timestamp: Date.now(),
	};
}
