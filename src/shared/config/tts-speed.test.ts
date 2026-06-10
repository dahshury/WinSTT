import { describe, expect, it } from "bun:test";
import {
	clampTtsSpeed,
	nextTtsSpeedPreset,
	ttsSpeedPresets,
	ttsSpeedRange,
} from "./tts-speed";

describe("ttsSpeedRange", () => {
	it("caps Supertonic's speed-up at 1.3 (officially supported), wide slow floor", () => {
		expect(ttsSpeedRange("supertonic-3")).toEqual({ min: 0.4, max: 1.3 });
	});

	it("gives other local engines the full 0.5–2.0", () => {
		expect(ttsSpeedRange("kokoro-82m")).toEqual({ min: 0.5, max: 2.0 });
		expect(ttsSpeedRange("kitten-nano-0.2")).toEqual({ min: 0.5, max: 2.0 });
		expect(ttsSpeedRange(undefined)).toEqual({ min: 0.5, max: 2.0 });
	});
});

describe("ttsSpeedPresets", () => {
	it("drops the >max steps for Supertonic so the island never offers a broken speed", () => {
		expect(ttsSpeedPresets("supertonic-3", false)).toEqual([1, 1.25]);
	});

	it("keeps the full local ladder for other engines", () => {
		expect(ttsSpeedPresets("kokoro-82m", false)).toEqual([1, 1.25, 1.5, 2]);
	});

	it("uses the cloud ladder regardless of model when cloud", () => {
		expect(ttsSpeedPresets("supertonic-3", true)).toEqual([0.9, 1, 1.1, 1.2]);
	});
});

describe("nextTtsSpeedPreset", () => {
	it("cycles within the list and wraps at the end", () => {
		expect(nextTtsSpeedPreset(1, [1, 1.25])).toBe(1.25);
		expect(nextTtsSpeedPreset(1.25, [1, 1.25])).toBe(1); // wrap
	});

	it("snaps a non-preset value up to the next preset (else first)", () => {
		// a stale 1.5 with Supertonic's capped [1, 1.25] list → wraps to the first
		expect(nextTtsSpeedPreset(1.5, [1, 1.25])).toBe(1);
		expect(nextTtsSpeedPreset(0.4, [1, 1.25, 1.5, 2])).toBe(1);
	});
});

describe("clampTtsSpeed", () => {
	it("clamps a stale over-ceiling Supertonic speed down to its max", () => {
		expect(clampTtsSpeed("supertonic-3", 1.5)).toBe(1.3);
		expect(clampTtsSpeed("supertonic-3", 2)).toBe(1.3);
		expect(clampTtsSpeed("supertonic-3", 0.4)).toBe(0.4);
	});

	it("leaves other engines' speeds within 0.5–2.0 untouched", () => {
		expect(clampTtsSpeed("kokoro-82m", 1.5)).toBe(1.5);
		expect(clampTtsSpeed("kokoro-82m", 2)).toBe(2);
	});
});
