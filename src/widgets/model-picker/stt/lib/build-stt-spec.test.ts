import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@/entities/model-catalog";
import { buildSttSpec } from "./build-stt-spec";

function makeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
	return {
		accuracyScore: 0.8,
		available: true,
		availableQuantizations: ["", "int8"],
		description: "A multilingual speech model.",
		displayName: "Whisper Large v3",
		errorMessage: "",
		family: "whisper",
		id: "whisper-large-v3",
		languages: ["English", "Arabic", "French"],
		localPath: null,
		onnxModelName: null,
		sizeBytesByQuantization: {},
		sizeLabel: "1.5B",
		speedScore: 0.4,
		supportsLanguageDetection: true,
		previewCapable: true,
		nativeStreaming: false,
		finalReuseSafe: false,
		...overrides,
	} as ModelInfo;
}

describe("buildSttSpec", () => {
	test("maps identity, maker and description", () => {
		const spec = buildSttSpec(makeModel());
		expect(spec.name).toBe("Whisper Large v3");
		expect(spec.makerLabel).toBe("OpenAI");
		expect(spec.description).toBe("A multilingual speech model.");
	});

	test("surfaces multilingual + parameter facts", () => {
		const spec = buildSttSpec(makeModel());
		expect(spec.features.some((f) => f.key === "multilingual")).toBe(true);
		expect(spec.facts.some((f) => f.key === "languages")).toBe(true);
		expect(spec.facts.some((f) => f.key === "params")).toBe(true);
	});

	test("includes a streaming feature only for native streamers", () => {
		expect(
			buildSttSpec(makeModel({ nativeStreaming: true })).features.some(
				(f) => f.key === "streaming",
			),
		).toBe(true);
		expect(
			buildSttSpec(makeModel({ nativeStreaming: false })).features.some(
				(f) => f.key === "streaming",
			),
		).toBe(false);
	});

	test("advertises a translation feature for translate-capable families", () => {
		// Multilingual Whisper → English-only translate.
		const whisper = buildSttSpec(makeModel());
		const whisperTranslate = whisper.features.find(
			(f) => f.key === "translate",
		);
		expect(whisperTranslate).toBeDefined();
		expect(whisperTranslate?.description).toContain("English");
		// NeMo Canary → any→any translate.
		const canary = buildSttSpec(
			makeModel({ id: "nemo-canary-1b-v2", family: "nemo" }),
		);
		expect(canary.features.some((f) => f.key === "translate")).toBe(true);
		// English-only Whisper and other families can't translate.
		expect(
			buildSttSpec(
				makeModel({ id: "tiny.en", supportsLanguageDetection: false }),
			).features.some((f) => f.key === "translate"),
		).toBe(false);
		expect(
			buildSttSpec(
				makeModel({ id: "moonshine-base", family: "moonshine" }),
			).features.some((f) => f.key === "translate"),
		).toBe(false);
	});

	test("drops the 0.5 unknown perf sentinel", () => {
		const spec = buildSttSpec(
			makeModel({ accuracyScore: 0.9, speedScore: 0.5 }),
		);
		const keys = (spec.stats ?? []).map((s) => s.key);
		expect(keys).toContain("accuracy");
		expect(keys).not.toContain("speed");
	});

	test("omits description when empty", () => {
		expect(
			buildSttSpec(makeModel({ description: "" })).description,
		).toBeUndefined();
	});
});
