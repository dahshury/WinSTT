import { beforeEach, describe, expect, test } from "bun:test";
import { useVisualizerStore } from "./visualizer-store";

beforeEach(() => {
	useVisualizerStore.setState({
		isRecording: false,
		isSpeaking: false,
		audioLevel: 0,
		sentencePulse: 0,
	});
});

describe("useVisualizerStore", () => {
	test("initial state", () => {
		const state = useVisualizerStore.getState();
		expect(state.isRecording).toBe(false);
		expect(state.isSpeaking).toBe(false);
		expect(state.audioLevel).toBe(0);
		expect(state.sentencePulse).toBe(0);
	});

	test("setRecording toggles isRecording without affecting other fields", () => {
		useVisualizerStore.getState().setAudioLevel(0.5);
		useVisualizerStore.getState().setRecording(true);
		expect(useVisualizerStore.getState().isRecording).toBe(true);
		expect(useVisualizerStore.getState().audioLevel).toBe(0.5);
	});

	test("setSpeaking, setAudioLevel, setSentencePulse update only their fields", () => {
		useVisualizerStore.getState().setSpeaking(true);
		useVisualizerStore.getState().setAudioLevel(0.75);
		useVisualizerStore.getState().setSentencePulse(0.3);
		const state = useVisualizerStore.getState();
		expect(state.isSpeaking).toBe(true);
		expect(state.audioLevel).toBe(0.75);
		expect(state.sentencePulse).toBe(0.3);
		expect(state.isRecording).toBe(false);
	});
});
