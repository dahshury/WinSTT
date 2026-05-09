import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useVisualizerStore } from "../model/visualizer-store";
import { useAgentState } from "./use-agent-state";

beforeEach(() => {
	useVisualizerStore.setState({
		isRecording: false,
		isSpeaking: false,
		audioLevel: 0,
		sentencePulse: 0,
	});
});

afterEach(() => {
	useVisualizerStore.setState({
		isRecording: false,
		isSpeaking: false,
		audioLevel: 0,
		sentencePulse: 0,
	});
});

describe("useAgentState", () => {
	test("returns 'disconnected' when not recording and silence", () => {
		const { result } = renderHook(() => useAgentState());
		expect(result.current).toBe("disconnected");
	});

	test("returns 'speaking' when recording with audible level (PTT path)", () => {
		useVisualizerStore.setState({ isRecording: true, audioLevel: 0.05 });
		const { result } = renderHook(() => useAgentState());
		expect(result.current).toBe("speaking");
	});

	test("returns 'speaking' when recording AND VAD says speaking even at low audio level", () => {
		useVisualizerStore.setState({ isRecording: true, isSpeaking: true, audioLevel: 0.001 });
		const { result } = renderHook(() => useAgentState());
		expect(result.current).toBe("speaking");
	});

	test("returns 'listening' when recording but quiet (no VAD speaking)", () => {
		useVisualizerStore.setState({ isRecording: true, isSpeaking: false, audioLevel: 0.005 });
		const { result } = renderHook(() => useAgentState());
		expect(result.current).toBe("listening");
	});

	test("returns 'speaking' when not recording but tail-end audio is still audible", () => {
		useVisualizerStore.setState({ isRecording: false, audioLevel: 0.05 });
		const { result } = renderHook(() => useAgentState());
		expect(result.current).toBe("speaking");
	});
});
