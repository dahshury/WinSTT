import { describe, expect, test } from "bun:test";
import type { TtsModelInfo } from "@/entities/tts-catalog";
import { buildTtsSpec } from "./build-tts-spec";

function makeModel(overrides: Partial<TtsModelInfo> = {}): TtsModelInfo {
	return {
		available: true,
		availableQuantizations: [""],
		cloning: "none",
		description: "A fast neural TTS voice.",
		voiceDesign: false,
		displayName: "Kokoro 82M",
		id: "kokoro-82m",
		engine: "kokoro",
		languages: ["English", "Japanese"],
		maker: "Hexgrad",
		numVoices: 54,
		paramCountM: 82,
		qualityScore: 0.7,
		sampleRate: 24_000,
		sizeBytesByQuantization: {},
		sizeLabel: "82M",
		speedScore: 0.9,
		...overrides,
	} as TtsModelInfo;
}

describe("buildTtsSpec", () => {
	test("maps identity, maker and description", () => {
		const spec = buildTtsSpec(makeModel());
		expect(spec.name).toBe("Kokoro 82M");
		expect(spec.makerLabel).toBe("Hexgrad");
		expect(spec.description).toBe("A fast neural TTS voice.");
	});

	test("emits voices + sample-rate facts", () => {
		const spec = buildTtsSpec(makeModel());
		const voices = spec.facts.find((f) => f.key === "voices");
		expect(voices?.value).toBe("54 voices");
		expect(spec.facts.find((f) => f.key === "sample-rate")?.value).toBe(
			"24 kHz",
		);
	});

	test("multilingual feature only when >1 language", () => {
		expect(
			buildTtsSpec(makeModel()).features.some((f) => f.key === "multilingual"),
		).toBe(true);
		expect(
			buildTtsSpec(makeModel({ languages: ["English"] })).features.some(
				(f) => f.key === "multilingual",
			),
		).toBe(false);
	});

	test("cloning + voice-design features", () => {
		const cloner = buildTtsSpec(
			makeModel({ cloning: "zero_shot_audio", voiceDesign: true }),
		);
		expect(cloner.features.some((f) => f.key === "cloning")).toBe(true);
		expect(cloner.features.some((f) => f.key === "voice-design")).toBe(true);
	});

	test("singular voice label", () => {
		expect(
			buildTtsSpec(makeModel({ numVoices: 1 })).facts.find(
				(f) => f.key === "voices",
			)?.value,
		).toBe("1 voice");
	});
});
