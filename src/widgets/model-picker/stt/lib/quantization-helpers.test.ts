import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@/entities/model-catalog";
import {
	getQuantizationOptions,
	supportsQuantization,
} from "./quantization-helpers";

function model(overrides: Partial<ModelInfo> = {}): ModelInfo {
	return {
		id: "m",
		displayName: "M",
		family: "nemo",
		backend: "onnx_asr",
		languages: ["en"],
		supportsLanguageDetection: false,
		sizeLabel: "300M",
		previewCapable: true,
		nativeStreaming: false,
		finalReuseSafe: true,
		supportsRealtime: true,
		onnxModelName: "model.onnx",
		description: "",
		availableQuantizations: ["", "int8"],
		...overrides,
	} as ModelInfo;
}

describe("getQuantizationOptions", () => {
	test("lists EVERY shipped precision incl fp32, heaviest → lightest", () => {
		// "" is the full-precision fp32 base export — now a normal selectable badge
		// (label "fp32"), and the heaviest, so it leads. The RECOMMENDED precision is
		// marked elsewhere (the card uses the model state's effective_quantization);
		// the shelf itself lists every published tier so the user can pick any.
		const opts = getQuantizationOptions(
			model({ availableQuantizations: ["int8", "", "q4"] }),
		);
		expect(opts.map((o) => o.value)).toEqual(["", "int8", "q4"]);
		expect(opts[0]?.label).toBe("fp32");
		expect(opts[0]?.tooltip).toContain("Full precision");
	});

	test("orders by precision weight, not the canonical list (fp32 then fp16 before int8)", () => {
		// Canonical ONNX_QUANTIZATIONS lists int8 before fp16, but fp16 is heavier and
		// more faithful so it renders before int8; "" (fp32) is heavier still and leads.
		const opts = getQuantizationOptions(
			model({ availableQuantizations: ["q4", "int8", "fp16", "", "q4f16"] }),
		);
		expect(opts.map((o) => o.value)).toEqual([
			"",
			"fp16",
			"int8",
			"q4f16",
			"q4",
		]);
	});

	test('ignores quantizations the UI cannot label, but keeps fp32 ("")', () => {
		// "" is fp32 (labelable → kept as a badge); an unlabelable suffix is dropped.
		const opts = getQuantizationOptions(
			model({ availableQuantizations: ["", "totally-unknown"] }),
		);
		expect(opts.map((o) => o.value)).toEqual([""]);
		expect(opts[0]?.label).toBe("fp32");
	});

	test("returns an empty list when nothing is shipped", () => {
		expect(
			getQuantizationOptions(model({ availableQuantizations: [] })),
		).toEqual([]);
	});
});

describe("supportsQuantization", () => {
	test("false for non-onnx backends", () => {
		expect(
			supportsQuantization(
				model({
					backend: "faster_whisper",
					availableQuantizations: ["", "int8"],
				}),
			),
		).toBe(false);
	});

	test("false when only a single known precision ships", () => {
		expect(supportsQuantization(model({ availableQuantizations: [""] }))).toBe(
			false,
		);
	});

	test("false when unknown suffixes pad a single known precision", () => {
		expect(
			supportsQuantization(
				model({ availableQuantizations: ["", "weird", "alsobad"] }),
			),
		).toBe(false);
	});

	test("true when more than one known precision ships for an onnx model", () => {
		expect(
			supportsQuantization(model({ availableQuantizations: ["", "int8"] })),
		).toBe(true);
	});
});
