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
			[model("paradee"), "af_heart"],
			[model("piper"), "en_US-lessac-medium"],
			[model("supertonic"), "M3"],
			[model("chatterbox"), "default"],
			[model("qwen3tts"), "vivian"],
			[{ ...model("qwen3tts"), cloning: "none" } as TtsModelInfo, "vivian"],
			[
				{
					...model("qwen3tts"),
					cloning: "zero_shot_audio_transcript",
				} as TtsModelInfo,
				"default",
			],
			[model("maya1", true), ""],
			[model("neutts"), "emily-neutral"],
			[model("omnivoice"), "default"],
			[model("magpie"), "sofia"],
			[model("cosyvoice3"), "en-male"],
			[model("qwen3tts", true), ""],
		];
		for (const [info, voice] of cases) {
			expect(defaultVoiceForTtsModel(info)).toBe(voice);
		}
	});

	test("an unknown engine (e.g. the removed Spark-TTS) falls back to the settings default", () => {
		expect(defaultVoiceForTtsModel(model("spark"))).not.toBe("female");
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

	test("seeds Magpie's separate language axis without touching speed", () => {
		const magpie = model("magpie");
		expect(resolveTtsModelSelectionPatch(magpie.id, [magpie], 2)).toEqual({
			model: magpie.id,
			voice: "sofia",
			lang: "en",
		});
	});
});
