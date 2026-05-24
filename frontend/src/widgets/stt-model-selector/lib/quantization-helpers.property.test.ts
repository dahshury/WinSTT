import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { ModelInfo } from "@/entities/model-catalog";
import { ONNX_QUANTIZATIONS, type OnnxQuantization } from "@/shared/config/defaults";
import { getQuantizationOptions, supportsQuantization } from "./quantization-helpers";

// Property tests for the quantization-options filter. The function takes a
// model's free-form `availableQuantizations` array and returns the subset the
// UI can label, in the canonical ONNX_QUANTIZATIONS order.

const KNOWN_QUANTS = ONNX_QUANTIZATIONS as readonly OnnxQuantization[];
const KNOWN_SET = new Set<string>(KNOWN_QUANTS);

// Arbitrary that mixes known + unknown suffix strings — the function must
// only emit known ones but the caller is free to feed anything.
const availableArb: fc.Arbitrary<string[]> = fc.array(
	fc.oneof(fc.constantFrom<string>(...KNOWN_QUANTS), fc.string({ minLength: 1, maxLength: 6 })),
	{ maxLength: 12 }
);

const backendArb = fc.constantFrom<ModelInfo["backend"]>("onnx_asr", "faster_whisper");

function model(availableQuantizations: string[], backend: ModelInfo["backend"]): ModelInfo {
	return {
		id: "m",
		displayName: "M",
		family: "nemo",
		backend,
		languages: ["en"],
		supportsLanguageDetection: false,
		sizeLabel: "300M",
		supportsRealtime: true,
		onnxModelName: "model.onnx",
		description: "",
		availableQuantizations,
	} as ModelInfo;
}

describe("getQuantizationOptions properties", () => {
	test("output values are a subset of the input set intersected with the known catalog", () => {
		fc.assert(
			fc.property(availableArb, backendArb, (avail, backend) => {
				const opts = getQuantizationOptions(model(avail, backend));
				const inputSet = new Set(avail);
				for (const opt of opts) {
					expect(inputSet.has(opt.value)).toBe(true);
					expect(KNOWN_SET.has(opt.value)).toBe(true);
				}
			}),
			{ numRuns: 300 }
		);
	});

	test("idempotent: feeding output values back yields the same options", () => {
		fc.assert(
			fc.property(availableArb, backendArb, (avail, backend) => {
				const first = getQuantizationOptions(model(avail, backend));
				const second = getQuantizationOptions(
					model(
						first.map((o) => o.value),
						backend
					)
				);
				expect(second.map((o) => o.value)).toEqual(first.map((o) => o.value));
			}),
			{ numRuns: 300 }
		);
	});

	test("deterministic canonical ordering: output index follows ONNX_QUANTIZATIONS order", () => {
		fc.assert(
			fc.property(availableArb, backendArb, (avail, backend) => {
				const opts = getQuantizationOptions(model(avail, backend));
				const indices = opts.map((o) => KNOWN_QUANTS.indexOf(o.value));
				const sorted = [...indices].sort((a, b) => a - b);
				expect(indices).toEqual(sorted);
				// No duplicates in output (the canonical list is deduped by filter+Set membership).
				expect(new Set(indices).size).toBe(indices.length);
			}),
			{ numRuns: 300 }
		);
	});

	test("deterministic: same input always yields the same output", () => {
		fc.assert(
			fc.property(availableArb, backendArb, (avail, backend) => {
				const a = getQuantizationOptions(model(avail, backend));
				const b = getQuantizationOptions(model([...avail], backend));
				expect(a).toEqual(b);
			}),
			{ numRuns: 200 }
		);
	});

	test("supportsQuantization is false for non-onnx backends regardless of inputs", () => {
		fc.assert(
			fc.property(availableArb, (avail) => {
				expect(supportsQuantization(model(avail, "faster_whisper"))).toBe(false);
			}),
			{ numRuns: 200 }
		);
	});

	test("supportsQuantization for onnx ↔ ≥2 known quantizations among input", () => {
		fc.assert(
			fc.property(availableArb, (avail) => {
				const expected = avail.filter((q) => KNOWN_SET.has(q)).length > 1; // raw counts include duplicates (matches source)
				expect(supportsQuantization(model(avail, "onnx_asr"))).toBe(expected);
			}),
			{ numRuns: 300 }
		);
	});
});
