import { describe, expect, test } from "bun:test";
import { computePillReveal } from "./OverlayPage";

// `computePillReveal` is the gate that decides WHEN the overlay pill
// (floating-bottom chip/bubble OR dynamic island) becomes visible during a
// dictation session. The contract: it must NOT reveal on the bare
// recording-start (PTT held through a silent lead-in), only once the user
// actually SPEAKS — the recorder's real smoothed-Silero VAD reports speech
// onset (`isSpeaking`, the snappy signal) or words get transcribed (`hasText`,
// a slower fallback) — or the post-recording LLM thinking indicator is up. The
// caller latches the result sticky for the rest of the session, so this only
// governs the FIRST reveal.

const BASE = {
	isRecordingActive: false,
	isSpeaking: false,
	hasText: false,
	isThinking: false,
};

describe("computePillReveal", () => {
	test("recording armed but silent (no speech, no words) → hidden (the 'pops before I speak' bug)", () => {
		expect(computePillReveal({ ...BASE, isRecordingActive: true })).toBe(false);
	});

	test("recording + real VAD speech onset → revealed (snappy, lands on speech)", () => {
		expect(computePillReveal({ ...BASE, isRecordingActive: true, isSpeaking: true })).toBe(true);
	});

	test("recording + transcribed words → revealed (fallback when VAD is quiet)", () => {
		expect(computePillReveal({ ...BASE, isRecordingActive: true, hasText: true })).toBe(true);
	});

	test("LLM thinking (recording already ended) → revealed", () => {
		expect(computePillReveal({ ...BASE, isThinking: true })).toBe(true);
	});

	test("idle (nothing happening) → hidden", () => {
		expect(computePillReveal(BASE)).toBe(false);
	});

	test("stale VAD speech without an armed recording → hidden (between-session guard)", () => {
		// A prior session may leave `isSpeaking=true` behind; it must not flash the
		// pill before the next recording_start re-arms `isRecordingActive`.
		expect(computePillReveal({ ...BASE, isSpeaking: true })).toBe(false);
	});

	test("stale text without an armed recording → hidden (between-session guard)", () => {
		expect(computePillReveal({ ...BASE, hasText: true })).toBe(false);
	});
});
