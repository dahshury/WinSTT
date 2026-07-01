import { describe, expect, mock, test } from "bun:test";

// picker-helpers pulls `ipcSend` (for `close()`) and a couple of pure helpers
// from the model-picker barrel; stub both so this stays a pure-function test.
mock.module("@/shared/api/ipc-client", () => ({
	ipcSend: () => undefined,
}));
mock.module("@/widgets/model-picker", () => ({
	resolveEffectiveQuant: () => "",
	STT_PICKER_WIDTH_PX: 600,
}));

const {
	DEFAULT_MODEL_PICKER_MODE,
	DESIRED_HEIGHT,
	DESIRED_WIDTH,
	desiredSizeForMode,
	normalizeDetachedModelPickerMode,
} = await import("./picker-helpers");

describe("normalizeDetachedModelPickerMode", () => {
	test("recognizes the new realtime / cloud STT and TTS modes", () => {
		expect(normalizeDetachedModelPickerMode({ kind: "stt-realtime" })).toEqual({
			kind: "stt-realtime",
		});
		expect(normalizeDetachedModelPickerMode({ kind: "stt-cloud" })).toEqual({
			kind: "stt-cloud",
		});
		expect(normalizeDetachedModelPickerMode({ kind: "tts" })).toEqual({
			kind: "tts",
		});
	});

	test("falls back to the default STT mode for unknown / missing kinds", () => {
		expect(normalizeDetachedModelPickerMode({ kind: "nope" })).toEqual(
			DEFAULT_MODEL_PICKER_MODE,
		);
		expect(normalizeDetachedModelPickerMode(null)).toEqual(
			DEFAULT_MODEL_PICKER_MODE,
		);
		expect(normalizeDetachedModelPickerMode(undefined)).toEqual(
			DEFAULT_MODEL_PICKER_MODE,
		);
	});

	test("still normalizes the LLM modes", () => {
		expect(
			normalizeDetachedModelPickerMode({
				kind: "llm-ollama",
				feature: "transforms",
			}),
		).toEqual({ kind: "llm-ollama", feature: "transforms" });
		expect(
			normalizeDetachedModelPickerMode({
				kind: "llm-openrouter",
				feature: "dictation",
				target: "fallback",
			}),
		).toEqual({
			kind: "llm-openrouter",
			feature: "dictation",
			target: "fallback",
		});
	});
});

describe("desiredSizeForMode", () => {
	test("realtime / cloud STT and TTS share the STT picker footprint", () => {
		const footprint = { width: DESIRED_WIDTH, height: DESIRED_HEIGHT };
		expect(desiredSizeForMode({ kind: "stt" })).toEqual(footprint);
		expect(desiredSizeForMode({ kind: "stt-realtime" })).toEqual(footprint);
		expect(desiredSizeForMode({ kind: "stt-cloud" })).toEqual(footprint);
		expect(desiredSizeForMode({ kind: "tts" })).toEqual(footprint);
	});

	test("LLM modes keep their own widths", () => {
		expect(
			desiredSizeForMode({ kind: "llm-ollama", feature: "dictation" }).width,
		).toBe(620);
		expect(
			desiredSizeForMode({
				kind: "llm-openrouter",
				feature: "dictation",
				target: "primary",
			}).width,
		).toBe(580);
	});
});
