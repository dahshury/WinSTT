import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { useVisualizerStore } from "../model/visualizer-store";
import {
	deriveActiveState,
	isActivelySpeaking,
	useAgentState,
} from "./use-agent-state";

beforeEach(() => {
	useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
	useVisualizerStore.setState({
		isRecording: false,
		isSpeaking: false,
		audioLevel: 0,
		sentencePulse: 0,
	});
});

afterEach(() => {
	useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
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
		useVisualizerStore.setState({
			isRecording: true,
			isSpeaking: true,
			audioLevel: 0.001,
		});
		const { result } = renderHook(() => useAgentState());
		expect(result.current).toBe("speaking");
	});

	test("returns 'listening' when recording but quiet (no VAD speaking)", () => {
		useVisualizerStore.setState({
			isRecording: true,
			isSpeaking: false,
			audioLevel: 0.005,
		});
		const { result } = renderHook(() => useAgentState());
		expect(result.current).toBe("listening");
	});

	test("returns 'disconnected' in listen mode when recording but quiet", () => {
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				general: {
					...DEFAULT_SETTINGS.general,
					recordingMode: "listen",
				},
			},
		});
		useVisualizerStore.setState({
			isRecording: true,
			isSpeaking: false,
			audioLevel: 0.005,
		});
		const { result } = renderHook(() => useAgentState());
		expect(result.current).toBe("disconnected");
	});

	test("returns 'speaking' when not recording but tail-end audio is still audible", () => {
		useVisualizerStore.setState({ isRecording: false, audioLevel: 0.05 });
		const { result } = renderHook(() => useAgentState());
		expect(result.current).toBe("speaking");
	});
});

describe("isActivelySpeaking", () => {
	test("returns false when not recording regardless of other params", () => {
		expect(isActivelySpeaking(false, true, 0.5)).toBe(false);
	});

	test("returns true when recording and VAD says speaking", () => {
		expect(isActivelySpeaking(true, true, 0)).toBe(true);
	});

	test("returns true when recording and audioLevel exceeds threshold", () => {
		expect(isActivelySpeaking(true, false, 0.05)).toBe(true);
	});

	test("returns false when recording but silent and no VAD", () => {
		expect(isActivelySpeaking(true, false, 0.005)).toBe(false);
	});
});

describe("deriveActiveState", () => {
	test("returns 'speaking' when actively speaking", () => {
		expect(deriveActiveState(true, true, 0.001)).toBe("speaking");
	});

	test("returns 'listening' when recording but not speaking", () => {
		expect(deriveActiveState(true, false, 0.005)).toBe("listening");
	});

	test("returns 'disconnected' when listen mode is recording but not speaking", () => {
		expect(deriveActiveState(true, false, 0.005, "listen")).toBe(
			"disconnected",
		);
	});

	test("returns 'speaking' when not recording but audio still active (fade-out)", () => {
		expect(deriveActiveState(false, false, 0.05)).toBe("speaking");
	});

	test("returns 'disconnected' when not recording and audio at or below 0.01", () => {
		expect(deriveActiveState(false, false, 0.005)).toBe("disconnected");
	});

	test("boundary: audioLevel exactly 0.01 is not above 0.01 → disconnected", () => {
		expect(deriveActiveState(false, false, 0.01)).toBe("disconnected");
	});

	test("boundary: audioLevel just above 0.01 (and not recording) → speaking (fade-out)", () => {
		expect(deriveActiveState(false, false, 0.011)).toBe("speaking");
	});

	test("recording with isSpeaking but quiet (sub-threshold) still 'speaking' via VAD signal", () => {
		expect(deriveActiveState(true, true, 0)).toBe("speaking");
	});
});
