import { describe, test } from "bun:test";
import fc from "fast-check";
import { decodeSettingsPayload } from "./settings-codec";

// Arbitrary for "anything reasonably invalid": strings, numbers, arrays,
// booleans, nulls — none of which match the AppSettings object shape.
const invalidPayloadArb = fc.oneof(
	fc.string(),
	fc.integer(),
	fc.double({ noNaN: true }),
	fc.boolean(),
	fc.constant(null),
	fc.constant(undefined),
	fc.array(fc.string()),
);

describe("decodeSettingsPayload property tests", () => {
	test("always returns the full schema shape (deterministic structure)", () => {
		fc.assert(
			fc.property(invalidPayloadArb, (payload) => {
				const result = decodeSettingsPayload(payload);
				// Top-level keys come from appSettingsSchema. If any are missing
				// the codec failed to fill defaults.
				return (
					typeof result === "object" &&
					result !== null &&
					"general" in result &&
					"model" in result &&
					"audio" in result &&
					"hotkey" in result &&
					"llm" in result
				);
			}),
			{ numRuns: 200 },
		);
	});

	test("idempotent under round-trip: decode(decode(x)) deep-equals decode(x)", () => {
		// timestamps/dates are not produced by the codec so structural equality
		// holds. Run with both invalid AND a few near-valid partials.
		const validPartials = fc.record({
			general: fc.record({
				recordingMode: fc.constantFrom("ptt", "toggle", "listen", "wakeword"),
				autoStart: fc.boolean(),
				minimizeToTray: fc.boolean(),
			}),
			model: fc.record({
				model: fc.string({ minLength: 1 }),
				language: fc.string({ minLength: 1 }),
			}),
		});
		fc.assert(
			fc.property(fc.oneof(invalidPayloadArb, validPartials), (payload) => {
				const first = decodeSettingsPayload(payload);
				const second = decodeSettingsPayload(first);
				return JSON.stringify(first) === JSON.stringify(second);
			}),
			{ numRuns: 200 },
		);
	});

	test("recordingMode preservation: valid value round-trips, invalid falls to default 'ptt'", () => {
		const validModes = ["ptt", "toggle", "listen", "wakeword"] as const;
		fc.assert(
			fc.property(
				fc.oneof(
					fc.constantFrom(...validModes),
					fc.string().filter((s) => !validModes.includes(s as never)),
				),
				(mode) => {
					const result = decodeSettingsPayload({
						general: { recordingMode: mode },
					});
					if (validModes.includes(mode as never)) {
						return result.general.recordingMode === mode;
					}
					// Invalid → falls back to schema defaults
					return result.general.recordingMode === "ptt";
				},
			),
			{ numRuns: 200 },
		);
	});

	test("defaults are stable: empty payload always yields identical result", () => {
		fc.assert(
			fc.property(
				fc.constantFrom({}, undefined, null, "", 0, false),
				(empty) => {
					const a = decodeSettingsPayload(empty);
					const b = decodeSettingsPayload({});
					// All "empty-ish" inputs should produce schema defaults.
					// Non-object payloads fall to the safeParse-failure branch.
					return JSON.stringify(a) === JSON.stringify(b);
				},
			),
			{ numRuns: 200 },
		);
	});

	test("never throws on arbitrary inputs (codec must be total)", () => {
		fc.assert(
			fc.property(fc.anything(), (payload) => {
				try {
					decodeSettingsPayload(payload);
					return true;
				} catch {
					return false;
				}
			}),
			{ numRuns: 300 },
		);
	});
});
