import { describe, expect, test } from "bun:test";
import {
	computePillReveal,
	computeStickyPillReveal,
} from "../lib/overlay-reveal";

// `computePillReveal` is the gate that decides WHEN the overlay pill
// (floating-bottom chip/bubble OR dynamic island) becomes visible during a
// dictation session. The contract: it must NOT reveal on the bare
// recording-start (PTT held through a silent lead-in), only once the user
// actually SPEAKS: the recorder's real smoothed-Silero VAD must report speech
// onset (`isSpeaking`). Realtime text, final decode, and LLM thinking may keep
// an already-revealed sticky session alive, but they must not create the first
// pill on their own.

const BASE = {
	isRecordingActive: false,
	isSpeaking: false,
};

describe("computePillReveal", () => {
	test("recording armed but silent (no speech) → hidden (the 'pops before I speak' bug)", () => {
		expect(computePillReveal({ ...BASE, isRecordingActive: true })).toBe(false);
	});

	test("recording + real VAD speech onset → revealed (snappy, lands on speech)", () => {
		expect(
			computePillReveal({ ...BASE, isRecordingActive: true, isSpeaking: true }),
		).toBe(true);
	});

	test("idle (nothing happening) → hidden", () => {
		expect(computePillReveal(BASE)).toBe(false);
	});

	test("stale VAD speech without an armed recording → hidden (between-session guard)", () => {
		// A prior session may leave `isSpeaking=true` behind; it must not flash the
		// pill before the next recording_start re-arms `isRecordingActive`.
		expect(computePillReveal({ ...BASE, isSpeaking: true })).toBe(false);
	});
});

describe("computeStickyPillReveal", () => {
	test("keeps a revealed pill mounted through a brief same-session drop", () => {
		expect(
			computeStickyPillReveal({
				latchSessionId: 2,
				latched: true,
				recordingSessionId: 2,
				sessionActive: true,
				sessionShouldShow: false,
			}),
		).toBe(true);
	});

	test("does not reuse a revealed latch from a previous recording session", () => {
		expect(
			computeStickyPillReveal({
				latchSessionId: 1,
				latched: true,
				recordingSessionId: 2,
				sessionActive: true,
				sessionShouldShow: false,
			}),
		).toBe(false);
	});

	test("terminal inactive state hides even when the latch is set", () => {
		expect(
			computeStickyPillReveal({
				latchSessionId: 2,
				latched: true,
				recordingSessionId: 2,
				sessionActive: false,
				sessionShouldShow: true,
			}),
		).toBe(false);
	});
});
