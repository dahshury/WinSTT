import type {
	TranscriptionHistoryEntry,
	TtsHistoryEntry,
} from "./history-store";

export type HistoryTableEntryKind = "transcription" | "transform" | "tts";

export interface HistoryTableItem {
	entry: TranscriptionHistoryEntry;
	kind: HistoryTableEntryKind;
	tts?: TtsHistoryEntry;
}
