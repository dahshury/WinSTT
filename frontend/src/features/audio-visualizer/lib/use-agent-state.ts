import { useVisualizerStore } from "../model/visualizer-store";
import type { AgentState } from "./audio-visualizer";

/** audioLevel above this counts as "speaking" even without a VAD signal (PTT mode). */
const SPEAKING_LEVEL_THRESHOLD = 0.02;

/** True when recording is active and the user appears to be producing audio. */
export function isActivelySpeaking(
	isRecording: boolean,
	isSpeaking: boolean,
	audioLevel: number
): boolean {
	return isRecording && (isSpeaking || audioLevel > SPEAKING_LEVEL_THRESHOLD);
}

/**
 * Derives the recording-active state (called only when at least some audio is
 * present). Extracted to keep `useAgentState` CC ≤ 4.
 *
 * VAD's `vad_detect_start` only fires in modes that go through the LISTENING
 * state (e.g. listen mode). Push-to-talk jumps straight to RECORDING and
 * never emits it, so we treat any audible level during recording as "speaking".
 */
export function deriveActiveState(
	isRecording: boolean,
	isSpeaking: boolean,
	audioLevel: number
): AgentState {
	if (isActivelySpeaking(isRecording, isSpeaking, audioLevel)) {
		return "speaking";
	}
	if (isRecording) {
		return "listening";
	}
	// Fading out after recording stops
	if (audioLevel > 0.01) {
		return "speaking";
	}
	return "disconnected";
}

/**
 * Derives an {@link AgentState} from the visualizer store.
 */
export function useAgentState(): AgentState {
	const isRecording = useVisualizerStore((s) => s.isRecording);
	const isSpeaking = useVisualizerStore((s) => s.isSpeaking);
	const audioLevel = useVisualizerStore((s) => s.audioLevel);

	if (!isRecording && audioLevel < 0.01) {
		return "disconnected";
	}
	return deriveActiveState(isRecording, isSpeaking, audioLevel);
}
