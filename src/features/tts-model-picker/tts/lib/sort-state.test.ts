import { describe, expect, test } from "bun:test";
import type { TtsModelInfo } from "@/entities/tts-catalog";
import { sortTtsModels } from "./sort-state";

const BASE: TtsModelInfo = {
	available: true,
	availableQuantizations: ["fp16"],
	cloning: "none",
	description: "",
	displayName: "Model",
	engine: "kokoro",
	id: "model",
	languages: ["en"],
	maker: "Maker",
	maxRefClipSecs: 0,
	numVoices: 1,
	paramCountM: 1,
	requiresReferenceClip: false,
	qualityScore: 0.5,
	sampleRate: 24_000,
	sizeBytesByQuantization: {},
	sizeLabel: "",
	speedScore: 0.5,
	tagSyntax: "none",
	tags: [],
	voiceDesign: false,
	voiceDesignMaxChars: 0,
	voiceInstruct: false,
};

const model = (overrides: Partial<TtsModelInfo>): TtsModelInfo => ({
	...BASE,
	...overrides,
});
const ids = (models: readonly TtsModelInfo[]) => models.map(({ id }) => id);

describe("sortTtsModels", () => {
	test("sorts TTS quality, speed, voice count, size, and name", () => {
		const models = [
			model({
				id: "z",
				displayName: "Zulu",
				qualityScore: 0.2,
				speedScore: 0.9,
				numVoices: 2,
				sizeBytesByQuantization: { fp16: 900 },
			}),
			model({
				id: "a",
				displayName: "Alpha",
				qualityScore: 0.9,
				speedScore: 0.2,
				numVoices: 20,
				sizeBytesByQuantization: { fp16: 100 },
			}),
		];
		expect(ids(sortTtsModels(models, "quality"))).toEqual(["a", "z"]);
		expect(ids(sortTtsModels(models, "speed"))).toEqual(["z", "a"]);
		expect(ids(sortTtsModels(models, "voices"))).toEqual(["a", "z"]);
		expect(ids(sortTtsModels(models, "size"))).toEqual(["a", "z"]);
		expect(ids(sortTtsModels(models, "name"))).toEqual(["a", "z"]);
	});
});
