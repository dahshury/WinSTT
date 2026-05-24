import { describe, expect, mock, test } from "bun:test";
import fc from "fast-check";

// Mute the validator's per-failure warning — property tests intentionally
// generate thousands of malformed inputs and the noise drowns real output.
console.warn = mock(() => undefined);

import { SUPPORTED_EVENT_TYPES, type SupportedEventType, validateServerEvent } from "./contract";

// ── fc generators ────────────────────────────────────────────────────
//
// One generator per event type. Each generator produces a payload that
// the matching schema MUST accept; the round-trip property below asserts
// that pairing. Optional fields are deliberately included in some cases
// (model_download_progress) to exercise both paths.

type PayloadGen = fc.Arbitrary<Record<string, unknown>>;

const validEventArbitraries: Record<SupportedEventType, PayloadGen> = {
	realtime: fc.record({
		type: fc.constant("realtime"),
		text: fc.string(),
	}),
	fullSentence: fc.record({
		type: fc.constant("fullSentence"),
		text: fc.string(),
	}),
	recording_start: fc.record({
		type: fc.constant("recording_start"),
	}),
	recording_stop: fc.record({
		type: fc.constant("recording_stop"),
	}),
	vad_detect_start: fc.record({
		type: fc.constant("vad_detect_start"),
	}),
	vad_detect_stop: fc.record({
		type: fc.constant("vad_detect_stop"),
	}),
	audio_level: fc.record({
		type: fc.constant("audio_level"),
		level: fc.double({ min: 0, max: 1, noNaN: true }),
	}),
	model_download_progress: fc.record({
		type: fc.constant("model_download_progress"),
		model: fc.string(),
		progress: fc.double({ min: 0, max: 1, noNaN: true }),
	}),
	wakeword_detected: fc.record({
		type: fc.constant("wakeword_detected"),
	}),
};

const anyValidEvent: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
	...Object.values(validEventArbitraries)
);

// ── Property 1: totality ─────────────────────────────────────────────

describe("validateServerEvent — totality", () => {
	test("never throws on arbitrary input from fc.anything()", () => {
		fc.assert(
			fc.property(fc.anything(), (raw) => {
				let result: unknown;
				let threw = false;
				try {
					result = validateServerEvent(raw);
				} catch {
					threw = true;
				}
				// Either parses to an object or returns null — but never throws.
				return !threw && (result === null || typeof result === "object");
			}),
			{ numRuns: 500 }
		);
	});

	test("never throws on JSON-like arbitrary input", () => {
		fc.assert(
			fc.property(fc.jsonValue(), (raw) => {
				let threw = false;
				try {
					validateServerEvent(raw);
				} catch {
					threw = true;
				}
				return !threw;
			}),
			{ numRuns: 500 }
		);
	});
});

// ── Property 2: round-trip ───────────────────────────────────────────
//
// For every event type, any payload our generator produces is accepted by
// `validateServerEvent` and the parser returns the same logical object.
// We compare the round-tripped event back to the original payload via
// `expect(...).toEqual(...)` so any silent field drop / coerce is caught.

describe("validateServerEvent — round-trip per event type", () => {
	for (const eventType of SUPPORTED_EVENT_TYPES) {
		test(`round-trips a generated ${eventType}`, () => {
			fc.assert(
				fc.property(validEventArbitraries[eventType], (payload) => {
					const parsed = validateServerEvent(payload);
					if (parsed === null) {
						return false;
					}
					// `payload` is typed as `Record<string, unknown>` (the generator's
					// shape) — cast through `unknown` for `toEqual`'s strict signature.
					expect(parsed as unknown).toEqual(payload as unknown);
					return true;
				}),
				{ numRuns: 200 }
			);
		});
	}

	test("any valid event (from the union of generators) round-trips", () => {
		fc.assert(
			fc.property(anyValidEvent, (payload) => {
				const parsed = validateServerEvent(payload);
				return parsed !== null && parsed.type === payload.type;
			}),
			{ numRuns: 500 }
		);
	});
});

// ── Property 3: rejection on discriminator removal ───────────────────
//
// Strip the `type` field from any valid payload and the parser MUST
// return null. The discriminator is the load-bearing piece — without it,
// zod can't route the value to any branch of the union.

describe("validateServerEvent — rejection without discriminator", () => {
	test("always rejects payloads with the type field stripped", () => {
		fc.assert(
			fc.property(anyValidEvent, (payload) => {
				const { type: _stripped, ...rest } = payload;
				return validateServerEvent(rest) === null;
			}),
			{ numRuns: 500 }
		);
	});

	test("always rejects payloads with the type field replaced by garbage", () => {
		fc.assert(
			fc.property(
				anyValidEvent,
				// Anything that is NOT one of our known discriminator literals.
				fc.string().filter((s) => !(SUPPORTED_EVENT_TYPES as readonly string[]).includes(s)),
				(payload, badType) => {
					const tampered = { ...payload, type: badType };
					return validateServerEvent(tampered) === null;
				}
			),
			{ numRuns: 500 }
		);
	});
});
