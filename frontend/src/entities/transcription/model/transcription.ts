import type { components } from "@spec/schema";

export type TranscriptionItem = components["schemas"]["TranscriptionItem"];
export type RecorderState = components["schemas"]["RecorderState"];

export function createTranscriptionItem(
	type: TranscriptionItem["type"],
	text: string,
	id: string = crypto.randomUUID(),
	timestamp: number = Date.now()
): TranscriptionItem {
	return { id, type, text, timestamp };
}
