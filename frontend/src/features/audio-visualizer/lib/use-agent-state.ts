import { useVisualizerStore } from "../model/visualizer-store";
import type { AgentState } from "./audio-visualizer";

/** audioLevel above this counts as "speaking" even without a VAD signal (PTT mode). */
const SPEAKING_LEVEL_THRESHOLD = 0.02;

/**
 * Derives an {@link AgentState} from the visualizer store.
 *
 * VAD's `vad_detect_start` only fires in modes that go through the LISTENING
 * state (e.g. listen mode). Push-to-talk jumps straight to RECORDING and
 * never emits it, so we treat any audible level during recording as "speaking".
 */
export function useAgentState(): AgentState {
	const isRecording = useVisualizerStore((s) => s.isRecording);
	const isSpeaking = useVisualizerStore((s) => s.isSpeaking);
	const audioLevel = useVisualizerStore((s) => s.audioLevel);

	if (!isRecording && audioLevel < 0.01) {
		return "disconnected";
	}
	if (isRecording && (isSpeaking || audioLevel > SPEAKING_LEVEL_THRESHOLD)) {
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
