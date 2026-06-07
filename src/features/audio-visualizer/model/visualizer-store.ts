import { create } from "zustand";

interface VisualizerState {
	/**
	 * 0-1 normalized RMS audio level from the server.
	 * Updated externally by the sync hook.
	 */
	audioLevel: number;
	/** Mic is recording (between recording_start / recording_stop). */
	isRecording: boolean;
	/** VAD has detected speech (between vad_start / vad_stop). */
	isSpeaking: boolean;
	/** Reset audio + pulse to 0 and mark recording active in a single store update. */
	recordingStarted: () => void;
	/**
	 * Drop recording + speaking flags AND zero audioLevel + sentencePulse in a
	 * single store update. The store is the truth of "what audio is currently
	 * happening"; once recording ends, that truth is zero. The visualizer's
	 * smooth fade was previously driven by a post-stop rAF loop that paused
	 * (along with the rest of the renderer) while the main window was hidden,
	 * leaving the last-frame level frozen in the store and flashing on next
	 * show. By committing to truth synchronously, hidden→shown transitions
	 * paint at 0 from the first frame.
	 */
	recordingStopped: () => void;
	/**
	 * 0-1 pulse that fires on each full sentence then decays.
	 * Gives a brief visual "pop" when a sentence lands.
	 */
	sentencePulse: number;
	setAudioLevel: (v: number) => void;

	setRecording: (v: boolean) => void;
	setSentencePulse: (v: number) => void;
	setSpeaking: (v: boolean) => void;
}

export const useVisualizerStore = create<VisualizerState>()((set) => ({
	isRecording: false,
	isSpeaking: false,
	audioLevel: 0,
	sentencePulse: 0,

	recordingStarted: () =>
		set({ isRecording: true, audioLevel: 0, sentencePulse: 0 }),
	recordingStopped: () =>
		set({
			isRecording: false,
			isSpeaking: false,
			audioLevel: 0,
			sentencePulse: 0,
		}),
	setRecording: (v) => set({ isRecording: v }),
	setSpeaking: (v) => set({ isSpeaking: v }),
	setAudioLevel: (v) => set({ audioLevel: v }),
	setSentencePulse: (v) => set({ sentencePulse: v }),
}));
