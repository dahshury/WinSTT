import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@/entities/model-catalog";
import { getQuantizationOptions, supportsQuantization } from "./quantization-helpers";

function model(overrides: Partial<ModelInfo> = {}): ModelInfo {
	return {
		id: "m",
		displayName: "M",
		family: "nemo",
		backend: "onnx_asr",
		languages: ["en"],
		supportsLanguageDetection: false,
		sizeLabel: "300M",
		supportsRealtime: true,
		onnxModelName: "model.onnx",
		description: "",
		availableQuantizations: ["", "int8"],
		...overrides,
	} as ModelInfo;
}

describe("getQuantizationOptions", () => {
	test("returns only shipped quantizations in canonical order", () => {
		const opts = getQuantizationOptions(model({ availableQuantizations: ["int8", "", "q4"] }));
		expect(opts.map((o) => o.value)).toEqual(["", "int8", "q4"]);
		expect(opts[0]?.label).toBe("Auto");
		expect(opts[1]?.label).toBe("int8");
		expect(opts[1]?.tooltip).toContain("8-bit");
	});

	test("ignores quantizations the UI cannot label", () => {
		const opts = getQuantizationOptions(model({ availableQuantizations: ["", "totally-unknown"] }));
		expect(opts.map((o) => o.value)).toEqual([""]);
	});

	test("returns an empty list when nothing is shipped", () => {
		expect(getQuantizationOptions(model({ availableQuantizations: [] }))).toEqual([]);
	});
});

describe("supportsQuantization", () => {
	test("false for non-onnx backends", () => {
		expect(
			supportsQuantization(
				model({ backend: "faster_whisper", availableQuantizations: ["", "int8"] })
			)
		).toBe(false);
	});

	test("false when only a single known precision ships", () => {
		expect(supportsQuantization(model({ availableQuantizations: [""] }))).toBe(false);
	});

	test("false when unknown suffixes pad a single known precision", () => {
		expect(supportsQuantization(model({ availableQuantizations: ["", "weird", "alsobad"] }))).toBe(
			false
		);
	});

	test("true when more than one known precision ships for an onnx model", () => {
		expect(supportsQuantization(model({ availableQuantizations: ["", "int8"] }))).toBe(true);
	});
});
