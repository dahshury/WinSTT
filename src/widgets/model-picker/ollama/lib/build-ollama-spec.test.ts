import { describe, expect, test } from "bun:test";
import type { OllamaModel } from "@/shared/api/models";
import { buildOllamaSpec } from "./build-ollama-spec";

function makeModel(overrides: Partial<OllamaModel> = {}): OllamaModel {
	return {
		name: "llama3.2:3b",
		size: 2_000_000_000,
		capabilities: ["tools", "thinking", "vision"],
		contextLength: 131_072,
		details: {
			parameterSize: "3.2B",
			quantizationLevel: "Q4_K_M",
		},
		...overrides,
	} as OllamaModel;
}

describe("buildOllamaSpec", () => {
	test("maps identity and publisher", () => {
		const spec = buildOllamaSpec(makeModel());
		expect(spec.name.toLowerCase()).toContain("llama");
		expect(spec.makerLabel?.length ?? 0).toBeGreaterThan(0);
	});

	test("passes through an optional description", () => {
		expect(
			buildOllamaSpec(makeModel(), "A tiny local model.").description,
		).toBe("A tiny local model.");
		expect(buildOllamaSpec(makeModel()).description).toBeUndefined();
	});

	test("surfaces params, context, quant and size facts", () => {
		const keys = buildOllamaSpec(makeModel()).facts.map((f) => f.key);
		expect(keys).toContain("params");
		expect(keys).toContain("context");
		expect(keys).toContain("quant");
		expect(keys).toContain("size");
	});

	test("context is compacted", () => {
		expect(
			buildOllamaSpec(makeModel()).facts.find((f) => f.key === "context")
				?.value,
		).toBe("131K");
	});

	test("derives tool + reasoning + vision capability features", () => {
		const keys = buildOllamaSpec(makeModel()).features.map((f) => f.key);
		expect(keys).toContain("tools");
		expect(keys).toContain("reasoning");
		expect(keys.some((k) => k.startsWith("cap-"))).toBe(true);
	});

	test("no perf bars for local models", () => {
		expect(buildOllamaSpec(makeModel()).stats).toBeUndefined();
	});
});
