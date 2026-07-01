import { create } from "zustand";
import type { TranscriptionItem } from "./transcription";

interface EphemeralMessage {
	text: string;
	timestamp: number;
}

export type TranscriptionProcessingPhase = "transcribing" | "uploading";

/**
 * Cap on the in-memory live feed. Without this, `addFinalSentence` allocates
 * a fresh `[...items, new]` array per dictation forever — O(N²) total work
 * and unbounded retained heap across a long session. Persistent history
 * lives in the main-process store (`transcription-history.ts`); this slice
 * is just the live UI feed.
 */
const MAX_LIVE_ITEMS = 500;
const EPHEMERAL_HOLD_MS = 7000;
let ephemeralTimer: ReturnType<typeof setTimeout> | null = null;

function clearEphemeralTimer(): void {
	if (ephemeralTimer !== null) {
		clearTimeout(ephemeralTimer);
		ephemeralTimer = null;
	}
}

interface TranscriptionState {
	addFinalSentence: (text: string) => void;
	beginRecordingSession: () => void;
	clearAll: () => void;
	clearEphemeral: () => void;
	clearItems: () => void;
	currentRealtime: string;
	ephemeral: EphemeralMessage | null;
	isRecordingActive: boolean;
	isTranscribing: boolean;
	items: TranscriptionItem[];
	processingPhase: TranscriptionProcessingPhase | null;
	recordingSessionId: number;
	setRealtimeText: (text: string) => void;
	setRecordingActive: (active: boolean) => void;
	setTranscribing: (
		active: boolean,
		phase?: TranscriptionProcessingPhase,
	) => void;
	showEphemeral: (text: string, holdMs?: number) => void;
	transcribingStartedAt: number | null;
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
	processingPhase: null,
	recordingSessionId: 0,
	transcribingStartedAt: null,
	beginRecordingSession: () => {
		clearEphemeralTimer();
		set((state) => ({
			items: [],
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: true,
			isTranscribing: false,
			processingPhase: null,
			recordingSessionId: state.recordingSessionId + 1,
			transcribingStartedAt: null,
		}));
	},
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
				processingPhase: null,
				transcribingStartedAt: null,
			};
		});
	},
	setRealtimeText: (text) => set({ currentRealtime: text }),
	setRecordingActive: (active) => set({ isRecordingActive: active }),
	setTranscribing: (active, phase = "transcribing") =>
		set((state) => {
			if (active) {
				return {
					isTranscribing: true,
					processingPhase: phase,
					transcribingStartedAt: state.transcribingStartedAt ?? Date.now(),
				};
			}
			return {
				isTranscribing: false,
				processingPhase: null,
				transcribingStartedAt: null,
			};
		}),
	showEphemeral: (text, holdMs = EPHEMERAL_HOLD_MS) => {
		clearEphemeralTimer();
		const timestamp = Date.now();
		set({ ephemeral: { text, timestamp } });
		if (holdMs > 0) {
			ephemeralTimer = setTimeout(() => {
				set((state) =>
					state.ephemeral?.timestamp === timestamp
						? { ephemeral: null }
						: state,
				);
				ephemeralTimer = null;
			}, holdMs);
		}
	},
	clearEphemeral: () => {
		clearEphemeralTimer();
		set({ ephemeral: null });
	},
	clearItems: () => set({ items: [] }),
	clearAll: () => {
		clearEphemeralTimer();
		set({
			items: [],
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: false,
			isTranscribing: false,
			processingPhase: null,
			recordingSessionId: 0,
			transcribingStartedAt: null,
		});
	},
}));
