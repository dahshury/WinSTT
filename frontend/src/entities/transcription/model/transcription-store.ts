import { create } from "zustand";
import type { SpeakerSegment, TranscriptionItem } from "./transcription";

interface EphemeralMessage {
	text: string;
	timestamp: number;
}

/**
 * Cap on the in-memory live feed. Without this, `addFinalSentence` allocates
 * a fresh `[...items, new]` array per dictation forever — O(N²) total work
 * and unbounded retained heap across a long session. Persistent history
 * lives in the main-process store (`transcription-history.ts`); this slice
 * is just the live UI feed.
 */
const MAX_LIVE_ITEMS = 500;

interface TranscriptionState {
	addFinalSentence: (text: string) => void;
	attachSpeakerSegments: (segments: SpeakerSegment[]) => void;
	clearAll: () => void;
	clearEphemeral: () => void;
	currentRealtime: string;
	ephemeral: EphemeralMessage | null;
	isRecordingActive: boolean;
	items: TranscriptionItem[];
	setRealtimeText: (text: string) => void;
	setRecordingActive: (active: boolean) => void;
	showEphemeral: (text: string) => void;
}

export const useTranscriptionStore = create<TranscriptionState>()((set) => ({
	items: [],
	currentRealtime: "",
	ephemeral: null,
	// Gates pill visibility in the overlay. Default `false` means a freshly
	// shown overlay window paints with the pill hidden until a real
	// recording_start event arrives — avoids flashing the previous session's
	// realtime/ephemeral text in the brief window between `showOverlay()` in
	// the main process and the renderer processing STT_RECORDING_START.
	isRecordingActive: false,
	addFinalSentence: (text) => {
		const id = crypto.randomUUID();
		const timestamp = Date.now();
		set((state) => {
			const appended = [...state.items, { id, type: "final" as const, text, timestamp }];
			const trimmed = appended.length > MAX_LIVE_ITEMS ? appended.slice(-MAX_LIVE_ITEMS) : appended;
			return { items: trimmed, currentRealtime: "" };
		});
	},
	attachSpeakerSegments: (segments) => {
		// The server emits ``speaker_segments`` right after the matching
		// ``fullSentence`` event (same utterance), so the most recent item
		// is the correct target. Guard against an empty list to avoid
		// dropping an undefined that would still trigger a re-render.
		set((state) => {
			if (state.items.length === 0) {
				return state;
			}
			const lastIndex = state.items.length - 1;
			const last = state.items[lastIndex];
			if (last === undefined) {
				return state;
			}
			const updatedLast: TranscriptionItem = { ...last, speakerSegments: segments };
			const items = [...state.items.slice(0, lastIndex), updatedLast];
			return { items };
		});
	},
	setRealtimeText: (text) => set({ currentRealtime: text }),
	setRecordingActive: (active) => set({ isRecordingActive: active }),
	showEphemeral: (text) => set({ ephemeral: { text, timestamp: Date.now() } }),
	clearEphemeral: () => set({ ephemeral: null }),
	clearAll: () =>
		set({ items: [], currentRealtime: "", ephemeral: null, isRecordingActive: false }),
}));
