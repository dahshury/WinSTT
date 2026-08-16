import { describe, expect, test } from "bun:test";
import type { TtsModelInfo } from "@/entities/tts-catalog";
import {
	defaultVoiceForTtsModel,
	resolveTtsModelSelectionPatch,
} from "./tts-model-selection";

function model(engine: string, voiceDesign = false): TtsModelInfo {
	return { engine, id: `${engine}-model`, voiceDesign } as TtsModelInfo;
}

describe("TTS model voice defaults", () => {
	test("uses a valid engine-specific voice", () => {
		const cases: [TtsModelInfo, string][] = [
			[model("kokoro"), "af_heart"],
			[model("kitten"), "expr-voice-5-m"],
			[model("piper"), "en_US-lessac-medium"],
			[model("supertonic"), "M3"],
			[model("chatterbox"), "default"],
			[model("qwen3tts"), "vivian"],
			[model("orpheus"), "tara"],
			[model("spark"), "female"],
			[model("neutts"), "emily-neutral"],
			[model("omnivoice"), "default"],
			[model("qwen3tts", true), ""],
		];
		for (const [info, voice] of cases) {
			expect(defaultVoiceForTtsModel(info)).toBe(voice);
		}
	});

	test("resets a stale voice when switching engines", () => {
		const piper = model("piper");
		expect(resolveTtsModelSelectionPatch(piper.id, [piper], 1)).toEqual({
			model: piper.id,
			voice: "en_US-lessac-medium",
		});
	});

	test("keeps Supertonic's language and speed constraints", () => {
		const supertonic = model("supertonic");
		expect(
			resolveTtsModelSelectionPatch(supertonic.id, [supertonic], 2),
		).toEqual({
			model: supertonic.id,
			voice: "M3",
			lang: "en",
			speed: 1.3,
		});
	});
});
