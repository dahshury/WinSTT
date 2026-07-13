import { describe, expect, test } from "bun:test";
import { SPEAKING_LEVEL_THRESHOLD } from "../lib/use-agent-state";
import { createVisualizerStore } from "../model/visualizer-store";
import { demoSpeechLevel } from "./VisualizerTypePreview.helpers";

describe("demoSpeechLevel", () => {
	test("stays above the speaking threshold across a full sweep", () => {
		// The hovered preview must HOLD the speaking state — a dip below the
		// 0.02 threshold would flick the visualizer back to listening/idle
		// mid-hover. Sample two full envelope periods at 60fps granularity.
		for (let t = 0; t < 12; t += 1 / 60) {
			expect(demoSpeechLevel(t)).toBeGreaterThan(SPEAKING_LEVEL_THRESHOLD);
		}
	});

	test("stays within a plausible speech RMS range (never clips to 1)", () => {
		for (let t = 0; t < 12; t += 1 / 60) {
			const level = demoSpeechLevel(t);
			expect(level).toBeGreaterThanOrEqual(0.04);
			expect(level).toBeLessThan(0.35);
		}
	});

	test("varies over time (not a flat envelope)", () => {
		const samples = Array.from({ length: 120 }, (_, i) =>
			demoSpeechLevel(i / 30),
		);
		expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.05);
	});
});

describe("createVisualizerStore", () => {
	test("returns isolated instances (driving one never leaks to another)", () => {
		const a = createVisualizerStore();
		const b = createVisualizerStore();
		a.getState().recordingStarted();
		a.getState().setSpeaking(true);
		a.getState().setAudioLevel(0.5);
		expect(b.getState().isRecording).toBe(false);
		expect(b.getState().isSpeaking).toBe(false);
		expect(b.getState().audioLevel).toBe(0);
	});

	test("starts idle so a never-hovered preview renders the disconnected look", () => {
		const store = createVisualizerStore();
		const s = store.getState();
		expect(s.isRecording).toBe(false);
		expect(s.isSpeaking).toBe(false);
		expect(s.audioLevel).toBe(0);
	});

	test("recordingStopped returns a driven store to idle (unhover contract)", () => {
		const store = createVisualizerStore();
		store.getState().recordingStarted();
		store.getState().setSpeaking(true);
		store.getState().setAudioLevel(0.3);
		store.getState().recordingStopped();
		const s = store.getState();
		expect(s.isRecording).toBe(false);
		expect(s.isSpeaking).toBe(false);
		expect(s.audioLevel).toBe(0);
	});
});
