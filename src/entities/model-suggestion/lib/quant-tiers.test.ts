import { describe, expect, test } from "bun:test";
import { ONNX_QUANTIZATIONS } from "@/shared/config/defaults";
import {
	effectiveScores,
	QUANT_ACCURACY_PENALTY,
	QUANT_SPEED_DELTA_CPU,
	QUANT_SPEED_DELTA_GPU,
	quantTierForLabel,
	UNKNOWN_SCORE_SENTINEL,
} from "./quant-tiers";

describe("tier tables", () => {
	test("cover every published OnnxQuantization", () => {
		for (const quant of ONNX_QUANTIZATIONS) {
			expect(QUANT_ACCURACY_PENALTY[quant]).toBeNumber();
			expect(QUANT_SPEED_DELTA_GPU[quant]).toBeNumber();
			expect(QUANT_SPEED_DELTA_CPU[quant]).toBeNumber();
		}
	});

	test("fp32 base export is the zero reference in every table", () => {
		expect(QUANT_ACCURACY_PENALTY[""]).toBe(0);
		expect(QUANT_SPEED_DELTA_GPU[""]).toBe(0);
		expect(QUANT_SPEED_DELTA_CPU[""]).toBe(0);
	});
});

describe("effectiveScores", () => {
	test("applies the accuracy penalty for the quant", () => {
		const result = effectiveScores(
			{ accuracy: 0.9, speed: 0.7 },
			"int8",
			"cpu",
		);
		expect(result.accuracy).toBeCloseTo(0.9 - 0.03);
	});

	test("clamps accuracy at 0 when the penalty exceeds the base", () => {
		const result = effectiveScores(
			{ accuracy: 0.02, speed: 0.7 },
			"int4",
			"cpu",
		);
		expect(result.accuracy).toBe(0);
	});

	test("fp16 is a speed BONUS on GPU", () => {
		const result = effectiveScores(
			{ accuracy: 0.8, speed: 0.6 },
			"fp16",
			"gpu",
		);
		expect(result.speed).toBeCloseTo(0.7);
	});

	test("fp16 is a speed PENALTY on CPU (ORT CPU EP up-casts fp16)", () => {
		const result = effectiveScores(
			{ accuracy: 0.8, speed: 0.6 },
			"fp16",
			"cpu",
		);
		expect(result.speed).toBeCloseTo(0.3);
		expect(result.speed).toBeLessThan(0.6);
	});

	test("clamps speed to [0, 1]", () => {
		const high = effectiveScores({ accuracy: 0.8, speed: 0.95 }, "fp16", "gpu");
		expect(high.speed).toBe(1);
		const low = effectiveScores({ accuracy: 0.8, speed: 0.1 }, "fp16", "cpu");
		expect(low.speed).toBe(0);
	});

	test("0.5 unknown sentinel passes through untouched on both axes", () => {
		const result = effectiveScores(
			{ accuracy: UNKNOWN_SCORE_SENTINEL, speed: UNKNOWN_SCORE_SENTINEL },
			"int4",
			"cpu",
		);
		expect(result.accuracy).toBe(UNKNOWN_SCORE_SENTINEL);
		expect(result.speed).toBe(UNKNOWN_SCORE_SENTINEL);
	});

	test("known scores near 0.5 are still adjusted (sentinel is exact)", () => {
		const result = effectiveScores(
			{ accuracy: 0.51, speed: 0.49 },
			"int8",
			"cpu",
		);
		expect(result.accuracy).toBeCloseTo(0.48);
		expect(result.speed).toBeCloseTo(0.57);
	});
});

describe("quantTierForLabel", () => {
	test("ONNX quants map to themselves", () => {
		for (const quant of ONNX_QUANTIZATIONS) {
			expect(quantTierForLabel(quant)).toBe(quant);
		}
	});

	test('"fp32" maps to the unsuffixed base export', () => {
		expect(quantTierForLabel("fp32")).toBe("");
	});

	test("Ollama labels map onto the closest tier", () => {
		expect(quantTierForLabel("Q8_0")).toBe("int8");
		expect(quantTierForLabel("fp16")).toBe("fp16");
		expect(quantTierForLabel("F16")).toBe("fp16");
		expect(quantTierForLabel("QAT")).toBe("int4");
		expect(quantTierForLabel("Q4_K_M")).toBe("q4");
		expect(quantTierForLabel("Q5_K_M")).toBe("q4");
	});

	test("default/latest fall to the q4 tier (Ollama defaults are Q4_K_M)", () => {
		expect(quantTierForLabel("default")).toBe("q4");
		expect(quantTierForLabel("latest")).toBe("q4");
		expect(quantTierForLabel("")).toBe("");
	});
});
