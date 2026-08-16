import { describe, expect, test } from "bun:test";
import { createTranslator } from "use-intl";
import messages from "../../../../../messages/en.json";
import type { TtsModelInfo } from "@/entities/tts-catalog";
import { buildTtsSpec } from "./build-tts-spec";

/** The real English bundle, so the spec-card copy under test is the copy that
 *  ships — a missing key fails here instead of rendering a raw key at runtime. */
const t = createTranslator({
	locale: "en",
	messages,
	namespace: "modelPicker",
});

function makeModel(overrides: Partial<TtsModelInfo> = {}): TtsModelInfo {
	return {
		available: true,
		availableQuantizations: [""],
		cloning: "none",
		maxRefClipSecs: 0,
		tagSyntax: "none",
		tags: [],
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
		const spec = buildTtsSpec(makeModel(), t);
		expect(spec.name).toBe("Kokoro 82M");
		expect(spec.makerLabel).toBe("Hexgrad");
		expect(spec.description).toBe("A fast neural TTS voice.");
	});

	test("emits voices + sample-rate facts", () => {
		const spec = buildTtsSpec(makeModel(), t);
		const voices = spec.facts.find((f) => f.key === "voices");
		expect(voices?.value).toBe("54 voices");
		expect(spec.facts.find((f) => f.key === "sample-rate")?.value).toBe(
			"24 kHz",
		);
	});

	test("multilingual feature only when >1 language", () => {
		expect(
			buildTtsSpec(makeModel(), t).features.some(
				(f) => f.key === "multilingual",
			),
		).toBe(true);
		expect(
			buildTtsSpec(makeModel({ languages: ["English"] }), t).features.some(
				(f) => f.key === "multilingual",
			),
		).toBe(false);
	});

	test("cloning + voice-design features", () => {
		const cloner = buildTtsSpec(
			makeModel({ cloning: "zero_shot_audio", voiceDesign: true }),
			t,
		);
		expect(cloner.features.some((f) => f.key === "cloning")).toBe(true);
		expect(cloner.features.some((f) => f.key === "voice-design")).toBe(true);
	});

	test("the two cloning tiers are labelled apart (clip vs clip + transcript)", () => {
		const clipOnly = buildTtsSpec(
			makeModel({ cloning: "zero_shot_audio" }),
			t,
		).features.find((f) => f.key === "cloning");
		const withTranscript = buildTtsSpec(
			makeModel({ cloning: "zero_shot_audio_transcript" }),
			t,
		).features.find((f) => f.key === "cloning");
		// Spark needs a transcript on top of the clip — a user reading the spec
		// card must be able to tell that apart from Chatterbox's clip-only tier.
		expect(clipOnly?.label).not.toBe(withTranscript?.label);
	});

	test("the reference-clip budget comes from the catalog row", () => {
		const cloner = buildTtsSpec(
			makeModel({ cloning: "zero_shot_audio", maxRefClipSecs: 30 }),
			t,
		).features.find((f) => f.key === "cloning");
		expect(cloner?.description).toContain("30");
	});

	test("inline-tag feature renders the vocabulary in the model's own syntax", () => {
		const square = buildTtsSpec(
			makeModel({ tagSyntax: "square", tags: ["laugh", "cough"] }),
			t,
		).features.find((f) => f.key === "inline-tags");
		expect(square?.description).toContain("[laugh]");
		expect(square?.description).toContain("[cough]");

		const angle = buildTtsSpec(
			makeModel({ tagSyntax: "angle", tags: ["laugh"] }),
			t,
		).features.find((f) => f.key === "inline-tags");
		expect(angle?.description).toContain("<laugh>");

		expect(
			buildTtsSpec(makeModel(), t).features.some(
				(f) => f.key === "inline-tags",
			),
		).toBe(false);
	});

	test("singular voice label", () => {
		expect(
			buildTtsSpec(makeModel({ numVoices: 1 }), t).facts.find(
				(f) => f.key === "voices",
			)?.value,
		).toBe("1 voice");
	});
});
