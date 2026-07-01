// Renderer-side live-feed item shape. The transcription stream is produced
// in-process by the native bridge (no Rust command emits this struct), so this
// is a hand-written type rather than a bindings re-point.
export interface TranscriptionItem {
	id: string;
	type: "realtime" | "final";
	text: string;
	timestamp: number;
}
