import { describe, expect, mock, test } from "bun:test";
import * as realBindings from "@/shared/api/ipc-client";
import * as realPicker from "@/widgets/model-picker";

// picker-helpers pulls `ipcSend` (for `close()`) and a couple of pure helpers
// from the model-picker barrel. bun's `mock.module` is process-GLOBAL and
// persistent across files, so an INCOMPLETE stub here would drop every other
// export of these modules (and replace `resolveEffectiveQuant` with a landmine
// `() => ""`) for every test file that runs later in the same process —
// stranding e.g. the STT selector trigger on a bogus "FP32" quant. Spread the
// REAL modules and override ONLY `ipcSend`, so the mock is a harmless superset.
mock.module("@/shared/api/ipc-client", () => ({
	...realBindings,
	ipcSend: () => undefined,
}));
mock.module("@/widgets/model-picker", () => ({ ...realPicker }));

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
		expect(normalizeDetachedModelPickerMode({ kind: "output-device" })).toEqual(
			{ kind: "output-device" },
		);
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

	test("output-device is a compact list, narrower than the STT grid", () => {
		const size = desiredSizeForMode({ kind: "output-device" });
		expect(size.width).toBe(320);
		expect(size.height).toBe(320);
		expect(size.width).toBeLessThan(DESIRED_WIDTH);
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
