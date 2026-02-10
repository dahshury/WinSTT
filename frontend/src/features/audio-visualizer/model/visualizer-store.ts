import { create } from "zustand";

interface VisualizerState {
	/** Mic is recording (between recording_start / recording_stop). */
	isRecording: boolean;
	/** VAD has detected speech (between vad_start / vad_stop). */
	isSpeaking: boolean;
	/**
	 * 0-1 normalized RMS audio level from the server.
	 * Updated externally by the sync hook.
	 */
	audioLevel: number;
	/**
	 * 0-1 pulse that fires on each full sentence then decays.
	 * Gives a brief visual "pop" when a sentence lands.
	 */
	sentencePulse: number;

	setRecording: (v: boolean) => void;
	setSpeaking: (v: boolean) => void;
	setAudioLevel: (v: number) => void;
	setSentencePulse: (v: number) => void;
}

export const useVisualizerStore = create<VisualizerState>((set) => ({
	isRecording: false,
	isSpeaking: false,
	audioLevel: 0,
	sentencePulse: 0,

	setRecording: (v) => set({ isRecording: v }),
	setSpeaking: (v) => set({ isSpeaking: v }),
	setAudioLevel: (v) => set({ audioLevel: v }),
	setSentencePulse: (v) => set({ sentencePulse: v }),
}));
