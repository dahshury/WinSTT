import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "../model/catalog-store";
import { modelHasNativeBasicFormatting } from "./model-formatting";

const baseModel: ModelInfo = {
	id: "large-v3",
	displayName: "Whisper Large v3",
	family: "whisper",
	backend: "onnx_asr",
	languages: ["en"],
	supportsLanguageDetection: true,
	sizeLabel: "1.5B",
	previewCapable: true,
	nativeStreaming: false,
	finalReuseSafe: false,
	supportsRealtime: true,
	onnxModelName: null,
	description: "",
	availableQuantizations: [""],
	sizeBytesByQuantization: {},
	available: true,
	errorMessage: "",
	localPath: null,
	speedScore: 0.5,
	accuracyScore: 0.5,
};

function model(overrides: Partial<ModelInfo>): ModelInfo {
	return { ...baseModel, ...overrides };
}

describe("model native formatting policy", () => {
	test("treats dictation-ready generative models as already formatted", () => {
		for (const family of [
			"whisper",
			"lite-whisper",
			"cohere",
			"granite",
		] as const) {
			expect(modelHasNativeBasicFormatting(model({ family }))).toBe(true);
		}
	});

	test("only treats Canary inside NeMo as native punctuation/casing", () => {
		expect(
			modelHasNativeBasicFormatting(
				model({ family: "nemo", id: "nemo-canary-1b-v2" }),
			),
		).toBe(true);
		expect(
			modelHasNativeBasicFormatting(
				model({ family: "nemo", id: "parakeet-tdt-0.6b-v2" }),
			),
		).toBe(false);
	});

	test("leaves raw recognizer families eligible for deterministic formatting", () => {
		for (const family of [
			"dolphin",
			"gigaam",
			"kaldi",
			"moonshine",
			"sense_voice",
			"t-one",
			"custom",
		] as const) {
			expect(modelHasNativeBasicFormatting(model({ family }))).toBe(false);
		}
	});
});
