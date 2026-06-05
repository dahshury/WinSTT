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
		previewCapable: true,
		nativeStreaming: false,
		finalReuseSafe: false,
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
	test("true when supportsLanguageDetection (driving card 'Multilingual' badge)", () => {
		// Post-runtime-refresh, Whisper/Canary carry a populated languages
		// whitelist (~25-99 codes). The badge follows the detection flag so
		// the picker shows "Multilingual" instead of dumping the whitelist.
		expect(
			isMultilingual(model({ languages: ["en", "de", "fr"], supportsLanguageDetection: true }))
		).toBe(true);
	});
	test("false when supportsLanguageDetection is off (constrained-language model)", () => {
		expect(isMultilingual(model({ languages: ["ru"], supportsLanguageDetection: false }))).toBe(
			false
		);
	});
});

describe("variantMeta", () => {
	test("flags a small multilingual model as realtime", () => {
		expect(
			variantMeta(
				model({
					sizeLabel: "39M",
					languages: ["en", "de"],
					supportsLanguageDetection: true,
				})
			)
		).toEqual({
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
			model({
				id: "tiny",
				sizeLabel: "39M",
				languages: ["en", "de", "fr"],
				supportsLanguageDetection: true,
			}),
			model({
				id: "tiny.en",
				sizeLabel: "39M",
				languages: ["en"],
				supportsLanguageDetection: false,
			}),
			model({
				id: "large-v3",
				sizeLabel: "1.5B",
				languages: ["en", "de", "fr"],
				supportsLanguageDetection: true,
			}),
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
			model({
				id: "a",
				sizeLabel: "600M",
				languages: ["ru"],
				supportsLanguageDetection: false,
			}),
			model({
				id: "b",
				sizeLabel: "600M",
				languages: ["ru"],
				supportsLanguageDetection: false,
			}),
		]);
		expect(s.sizeRange).toBe("600M");
		expect(s.languageNote).toBe("RU");
	});

	test("unparseable sizes yield an empty range", () => {
		const s = summarizeFamily([model({ id: "z", sizeLabel: "" })]);
		expect(s.sizeRange).toBe("");
	});

	test("range is order-independent (smallest variant listed last)", () => {
		const s = summarizeFamily([
			model({
				id: "large",
				sizeLabel: "1.5B",
				languages: ["en", "de"],
				supportsLanguageDetection: true,
			}),
			model({
				id: "mid",
				sizeLabel: "769M",
				languages: ["en", "de"],
				supportsLanguageDetection: true,
			}),
			model({
				id: "tiny",
				sizeLabel: "39M",
				languages: ["en", "de"],
				supportsLanguageDetection: true,
			}),
		]);
		expect(s.sizeRange).toBe("39M – 1.5B");
	});

	test("explicit non-English languages are upper-cased, deduped, sorted", () => {
		const s = summarizeFamily([
			model({
				id: "a",
				sizeLabel: "39M",
				languages: ["ru"],
				supportsLanguageDetection: false,
			}),
			model({
				id: "b",
				sizeLabel: "39M",
				languages: ["de", "ru"],
				supportsLanguageDetection: false,
			}),
			model({
				id: "c",
				sizeLabel: "39M",
				languages: ["en", "fr"],
				supportsLanguageDetection: true,
			}),
		]);
		expect(s.languageNote).toBe("Multilingual · DE · RU");
	});
});
