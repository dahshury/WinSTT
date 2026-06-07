import { describe, test } from "bun:test";
import fc from "fast-check";
import {
	isPillVisible,
	isRealtimeEnabled,
	type LiveTranscriptionDisplay,
} from "./realtime-enabled";

const DISPLAYS: readonly LiveTranscriptionDisplay[] = [
	"none",
	"in-app",
	"in-pill",
	"both",
];

const display = () => fc.constantFrom(...DISPLAYS);
const state = () =>
	fc.record({
		showRecordingOverlay: fc.boolean(),
		liveTranscriptionDisplay: display(),
	});

describe("isRealtimeEnabled (property-based)", () => {
	test("deterministic: same input → same output", () => {
		fc.assert(
			fc.property(state(), (s) => {
				const a = isRealtimeEnabled(s);
				const b = isRealtimeEnabled(s);
				return a === b;
			}),
			{ numRuns: 300 },
		);
	});

	test("dominance: liveTranscriptionDisplay='none' always returns false", () => {
		fc.assert(
			fc.property(
				fc.boolean(),
				(overlay) =>
					isRealtimeEnabled({
						showRecordingOverlay: overlay,
						liveTranscriptionDisplay: "none",
					}) === false,
			),
			{ numRuns: 200 },
		);
	});

	test("dominance: word-by-word paste enables realtime", () => {
		fc.assert(
			fc.property(
				fc.boolean(),
				fc.boolean(),
				display(),
				(overlay, llmDictationEnabled, liveTranscriptionDisplay) =>
					isRealtimeEnabled({
						showRecordingOverlay: overlay,
						liveTranscriptionDisplay,
						wordByWordPasting: true,
						llmDictationEnabled,
					}) === true,
			),
			{ numRuns: 200 },
		);
	});

	test("returns a strict boolean (typeof === 'boolean'), never undefined/null/string", () => {
		fc.assert(
			fc.property(state(), (s) => {
				const r = isRealtimeEnabled(s);
				return typeof r === "boolean";
			}),
			{ numRuns: 300 },
		);
	});

	test("'in-app' and 'both' are overlay-independent (always true)", () => {
		fc.assert(
			fc.property(
				fc.boolean(),
				fc.constantFrom<LiveTranscriptionDisplay>("in-app", "both"),
				(overlay, d) =>
					isRealtimeEnabled({
						showRecordingOverlay: overlay,
						liveTranscriptionDisplay: d,
					}) === true,
			),
			{ numRuns: 200 },
		);
	});

	test("'in-pill' result tracks overlay state exactly", () => {
		fc.assert(
			fc.property(
				fc.boolean(),
				(overlay) =>
					isRealtimeEnabled({
						showRecordingOverlay: overlay,
						liveTranscriptionDisplay: "in-pill",
					}) === overlay,
			),
			{ numRuns: 200 },
		);
	});
});

describe("isPillVisible (property-based)", () => {
	test("returns a strict boolean", () => {
		fc.assert(
			fc.property(state(), (s) => typeof isPillVisible(s) === "boolean"),
			{ numRuns: 300 },
		);
	});

	test("overlay-off dominance: showRecordingOverlay=false always returns false", () => {
		fc.assert(
			fc.property(
				display(),
				(d) =>
					isPillVisible({
						showRecordingOverlay: false,
						liveTranscriptionDisplay: d,
					}) === false,
			),
			{ numRuns: 200 },
		);
	});
});
