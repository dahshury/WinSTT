import { describe, expect, it } from "bun:test";

import { isLiteOllamaModel, ollamaEffectiveParamsBillions } from "./lite-model";

describe("ollamaEffectiveParamsBillions", () => {
	it("parses plain, decimal, effective, and sub-billion sizes", () => {
		expect(ollamaEffectiveParamsBillions("qwen3.5:2b")).toBe(2);
		expect(ollamaEffectiveParamsBillions("qwen3.5:0.8b")).toBeCloseTo(0.8);
		expect(ollamaEffectiveParamsBillions("smollm2:135m")).toBeCloseTo(0.135);
		expect(ollamaEffectiveParamsBillions("gemma4:e2b")).toBe(2);
		expect(ollamaEffectiveParamsBillions("gemma4:e4b-it-qat")).toBe(4);
		expect(ollamaEffectiveParamsBillions("phi4-mini:3.8b")).toBeCloseTo(3.8);
		expect(ollamaEffectiveParamsBillions("gemma4:12b-it-q4_K_M")).toBe(12);
		expect(ollamaEffectiveParamsBillions("lfm2.5:8b-a1b-q4_K_M")).toBe(8);
	});

	it("never parses quant markers as sizes", () => {
		expect(ollamaEffectiveParamsBillions("llama3.2:1b-instruct-q8_0")).toBe(1);
	});

	it("returns null for bare bases and alias tags", () => {
		expect(ollamaEffectiveParamsBillions("gemma4")).toBeNull();
		expect(ollamaEffectiveParamsBillions("phi3:mini")).toBeNull();
		expect(ollamaEffectiveParamsBillions("qwen3.5:latest")).toBeNull();
	});
});

describe("isLiteOllamaModel", () => {
	it("marks sub-4B models lite", () => {
		for (const name of [
			"smollm2:135m",
			"qwen3.5:0.8b",
			"llama3.2:1b",
			"qwen3.5:2b",
			"gemma4:e2b",
			"gemma4:e2b-it-qat",
			"granite4.1:3b",
			"phi4-mini:3.8b",
		]) {
			expect(isLiteOllamaModel(name)).toBe(true);
		}
	});

	it("keeps 4B-and-up and unknown-size models full-tier", () => {
		// gemma4:e4b (effective 4B) is the verified full-envelope floor.
		for (const name of [
			"gemma4:e4b",
			"gemma4:e4b-it-qat",
			"qwen3.5:4b",
			"gemma4:12b",
			"command-r7b:7b",
			"gemma4",
			"phi3:mini",
		]) {
			expect(isLiteOllamaModel(name)).toBe(false);
		}
	});
});
