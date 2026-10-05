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

	test("recovers the Bonsai main-model facts from an unknown drafter payload", () => {
		const spec = buildOllamaSpec(
			makeModel({
				name: "hf.co/prism-ml/Bonsai-27B-gguf:Q1_0",
				details: {
					family: "dspark",
					parameterSize: "3.65B",
					quantizationLevel: "unknown",
				},
			}),
		);
		expect(spec.facts.find((fact) => fact.key === "params")?.value).toBe("27B");
		expect(spec.facts.find((fact) => fact.key === "quant")?.value).toBe("Q1_0");
	});

	test("shows S1-mini under Superwhisper with its bundled logo", () => {
		const spec = buildOllamaSpec(
			makeModel({
				name: "hf.co/superwhisper/s1-mini-GGUF:Q4_K_M",
				details: {
					family: "qwen3",
					parameterSize: "751.6M",
					quantizationLevel: "Q4_K_M",
				},
			}),
		);
		expect(spec.name).toBe("S1-mini");
		expect(spec.makerLabel).toBe("Superwhisper");
		expect(spec.makerLogoSrc).toContain("/provider-icons/superwhisper.png");
		expect(spec.facts.find((fact) => fact.key === "params")?.value).toBe(
			"0.6B",
		);
		expect(spec.features.map((feature) => feature.key)).not.toContain(
			"reasoning",
		);
		expect(spec.stats).toMatchObject([
			{ key: "accuracy", label: "Accuracy", score: 0.446 },
			{ key: "speed", label: "Speed", score: 0.979 },
		]);
		expect(spec.sourceLabel).toBe("Performance inherited from Qwen/Qwen3-0.6B");
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

	test("keeps perf bars absent for local models without an attributable profile", () => {
		expect(buildOllamaSpec(makeModel()).stats).toBeUndefined();
	});
});
