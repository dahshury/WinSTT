import { describe, expect, test } from "bun:test";
import {
	asrPromptCapability,
	nativeAsrCleanupActive,
	shouldConfirmSeparateCleanup,
} from "./asr-prompting";

const model = {
	model: "nemotron-3.5-transcribe-30b-a4b",
	asrPromptModel: "nemotron-3.5-transcribe-30b-a4b",
	asrPromptSource: "cleanupPresets",
	asrInstruction: "",
	asrAllowSeparateCleanup: false,
};

describe("direct ASR cleanup routing", () => {
	test("context and task prompts do not qualify a recognizer for cleanup", () => {
		for (const id of [
			"tiny",
			"vibevoice-asr",
			"qwen3-asr-1.7b",
			"streaming-nemotron-3.5-multi-1120ms-int8",
			"granite-speech-4.1-2b-plus",
			"granite-speech-4.1-2b-nar",
		]) {
			expect(nativeAsrCleanupActive({ model: { ...model, model: id } })).toBe(
				false,
			);
		}
		expect(asrPromptCapability("granite-speech-4.1-2b-plus")).toBe("task");
	});
	test("custom instructions must be nonempty and Listen mode never runs cleanup", () => {
		expect(
			nativeAsrCleanupActive({
				model: { ...model, asrPromptSource: "custom", asrInstruction: "  " },
			}),
		).toBe(false);
		expect(
			nativeAsrCleanupActive({
				model: {
					...model,
					asrPromptSource: "custom",
					asrInstruction: "Omit fillers.",
				},
			}),
		).toBe(true);
		expect(
			nativeAsrCleanupActive({ model, general: { recordingMode: "listen" } }),
		).toBe(false);
	});
	test("a second pass needs an explicit acknowledgement", () => {
		expect(shouldConfirmSeparateCleanup({ model })).toBe(true);
		expect(
			shouldConfirmSeparateCleanup({
				model: { ...model, asrAllowSeparateCleanup: true },
			}),
		).toBe(false);
		expect(
			shouldConfirmSeparateCleanup({
				model: { ...model, asrPromptSource: "off" },
			}),
		).toBe(false);
	});
});
