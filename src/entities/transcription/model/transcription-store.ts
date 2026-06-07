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
	beginRecordingSession: () => void;
	clearAll: () => void;
	clearEphemeral: () => void;
	currentRealtime: string;
	ephemeral: EphemeralMessage | null;
	isRecordingActive: boolean;
	isTranscribing: boolean;
	items: TranscriptionItem[];
	recordingSessionId: number;
	setRealtimeText: (text: string) => void;
	setRecordingActive: (active: boolean) => void;
	setTranscribing: (active: boolean) => void;
	showEphemeral: (text: string) => void;
	transcribingStartedAt: number | null;
}

/**
 * Build the next `items` array with `segments` attached to the most recent
 * entry, or return null when there's nothing to attach to. Pulled out of
 * `attachSpeakerSegments` so the store callback stays CC ≤ 1.
 */
function withSpeakerSegmentsApplied(
	items: readonly TranscriptionItem[],
	segments: SpeakerSegment[],
): TranscriptionItem[] | null {
	const lastIndex = items.length - 1;
	const last = items[lastIndex];
	if (last === undefined) {
		return null;
	}
	const updatedLast: TranscriptionItem = { ...last, speakerSegments: segments };
	return [...items.slice(0, lastIndex), updatedLast];
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
	isTranscribing: false,
	recordingSessionId: 0,
	transcribingStartedAt: null,
	beginRecordingSession: () =>
		set((state) => ({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: true,
			isTranscribing: false,
			recordingSessionId: state.recordingSessionId + 1,
			transcribingStartedAt: null,
		})),
	addFinalSentence: (text) => {
		const id = crypto.randomUUID();
		const timestamp = Date.now();
		set((state) => {
			const appended = [
				...state.items,
				{ id, type: "final" as const, text, timestamp },
			];
			const trimmed =
				appended.length > MAX_LIVE_ITEMS
					? appended.slice(-MAX_LIVE_ITEMS)
					: appended;
			return {
				items: trimmed,
				currentRealtime: "",
				isTranscribing: false,
				transcribingStartedAt: null,
			};
		});
	},
	// The server emits ``speaker_segments`` right after the matching
	// ``fullSentence`` event (same utterance), so the most recent item
	// is the correct target. Returning the same state when the live feed is
	// empty avoids dropping an undefined that would still trigger a re-render.
	attachSpeakerSegments: (segments) => {
		set((state) => {
			const items = withSpeakerSegmentsApplied(state.items, segments);
			return items === null ? state : { items };
		});
	},
	setRealtimeText: (text) => set({ currentRealtime: text }),
	setRecordingActive: (active) => set({ isRecordingActive: active }),
	setTranscribing: (active) =>
		set((state) => {
			if (active) {
				return {
					isTranscribing: true,
					transcribingStartedAt: state.transcribingStartedAt ?? Date.now(),
				};
			}
			return { isTranscribing: false, transcribingStartedAt: null };
		}),
	showEphemeral: (text) => set({ ephemeral: { text, timestamp: Date.now() } }),
	clearEphemeral: () => set({ ephemeral: null }),
	clearAll: () =>
		set({
			items: [],
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: false,
			isTranscribing: false,
			recordingSessionId: 0,
			transcribingStartedAt: null,
		}),
}));
