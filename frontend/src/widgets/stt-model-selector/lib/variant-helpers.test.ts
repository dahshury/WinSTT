import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@/entities/model-catalog";
import { isEnglishOnly, isMultilingual, summarizeFamily, variantMeta } from "./variant-helpers";

function model(over: Partial<ModelInfo> = {}): ModelInfo {
	return {
		id: "tiny",
		displayName: "Tiny",
		family: "whisper",
		backend: "onnx_asr",
		languages: [],
		supportsLanguageDetection: true,
		sizeLabel: "39M",
		supportsRealtime: true,
		onnxModelName: "x/y",
		description: "",
		availableQuantizations: [""],
		...over,
	} as ModelInfo;
}

describe("isEnglishOnly", () => {
	test("true for .en ids", () => {
		expect(isEnglishOnly(model({ id: "small.en", languages: ["en"] }))).toBe(true);
	});
	test("true for sole en language", () => {
		expect(isEnglishOnly(model({ id: "x", languages: ["en"] }))).toBe(true);
	});
	test("false for multilingual", () => {
		expect(isEnglishOnly(model({ languages: [] }))).toBe(false);
	});
	test("false for ru-only", () => {
		expect(isEnglishOnly(model({ id: "vosk", languages: ["ru"] }))).toBe(false);
	});
});

describe("isMultilingual", () => {
	test("true when no explicit languages", () => {
		expect(isMultilingual(model({ languages: [] }))).toBe(true);
	});
	test("false when languages listed", () => {
		expect(isMultilingual(model({ languages: ["en"] }))).toBe(false);
	});
});

describe("variantMeta", () => {
	test("flags a small multilingual model as realtime", () => {
		expect(variantMeta(model({ sizeLabel: "39M", languages: [] }))).toEqual({
			englishOnly: false,
			multilingual: true,
			realtime: true,
		});
	});
	test("heavy model is not realtime", () => {
		expect(variantMeta(model({ sizeLabel: "1.5B" })).realtime).toBe(false);
	});
});

describe("summarizeFamily", () => {
	test("ranges sizes and notes mixed coverage", () => {
		const s = summarizeFamily([
			model({ id: "tiny", sizeLabel: "39M", languages: [] }),
			model({ id: "tiny.en", sizeLabel: "39M", languages: ["en"] }),
			model({ id: "large-v3", sizeLabel: "1.5B", languages: [] }),
		]);
		expect(s.variantCount).toBe(3);
		expect(s.sizeRange).toBe("39M – 1.5B");
		expect(s.hasMultilingual).toBe(true);
		expect(s.hasEnglishOnly).toBe(true);
		expect(s.languageNote).toBe("Multilingual · English-only");
		expect(s.realtimeCount).toBe(2);
	});

	test("single size collapses the range", () => {
		const s = summarizeFamily([
			model({ id: "a", sizeLabel: "600M", languages: ["ru"] }),
			model({ id: "b", sizeLabel: "600M", languages: ["ru"] }),
		]);
		expect(s.sizeRange).toBe("600M");
		expect(s.languageNote).toBe("RU");
	});

	test("unparseable sizes yield an empty range", () => {
		const s = summarizeFamily([model({ id: "z", sizeLabel: "" })]);
		expect(s.sizeRange).toBe("");
	});
});
