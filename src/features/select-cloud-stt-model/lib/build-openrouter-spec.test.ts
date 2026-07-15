import { describe, expect, test } from "bun:test";
import type { ModelsDevEntry } from "@/entities/llm-catalog";
import type { OpenRouterModel } from "@/shared/api/models";
import { buildOpenRouterSpec } from "./build-openrouter-spec";

function makeModel(overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
	return {
		id: "moonshotai/kimi-k2-0905",
		name: "Kimi K2 (0905)",
		model_name: "Kimi K2 (0905)",
		maker: "moonshotai",
		description: "Enhanced version with longer context.",
		context_length: 262_144,
		supported_parameters: ["tools", "structured_outputs", "reasoning"],
		pricing: { prompt: "0.000003", completion: "0.000015" },
		...overrides,
	};
}

const ENRICHMENT: ModelsDevEntry = {
	id: "kimi-k2",
	name: "Kimi K2",
	developer: "Moonshot AI",
	knowledge: "2024-12",
	releaseDate: "2025-09-05",
	reasoning: true,
	toolCall: true,
	inputModalities: ["text", "image"],
	contextLimit: 262_144,
	openWeights: true,
};

describe("buildOpenRouterSpec (catalog only)", () => {
	test("always shows the OpenRouter provider + a developer fact", () => {
		const spec = buildOpenRouterSpec(makeModel(), null);
		const provider = spec.facts.find((f) => f.key === "provider");
		expect(provider?.value).toBe("OpenRouter");
		expect(spec.facts.some((f) => f.key === "developer")).toBe(true);
	});

	test("derives capability features from supported_parameters", () => {
		const keys = buildOpenRouterSpec(makeModel(), null).features.map(
			(f) => f.key,
		);
		expect(keys).toContain("tools");
		expect(keys).toContain("structured");
		expect(keys).toContain("reasoning");
	});

	test("prices into a tier + shows context", () => {
		const spec = buildOpenRouterSpec(makeModel(), null);
		expect(spec.priceTier).toBe(3);
		expect(spec.facts.find((f) => f.key === "context")?.value).toBe("262K");
	});

	test("no online source label without enrichment", () => {
		expect(buildOpenRouterSpec(makeModel(), null).sourceLabel).toBeUndefined();
	});

	test("loading flag only applies before enrichment lands", () => {
		expect(
			buildOpenRouterSpec(makeModel(), null, { loading: true }).loading,
		).toBe(true);
		expect(
			buildOpenRouterSpec(makeModel(), ENRICHMENT, { loading: true }).loading,
		).toBeUndefined();
	});
});

describe("buildOpenRouterSpec (enriched)", () => {
	test("adds knowledge cutoff, release date and developer from models.dev", () => {
		const spec = buildOpenRouterSpec(makeModel(), ENRICHMENT);
		expect(spec.facts.find((f) => f.key === "knowledge")?.value).toBe(
			"Dec 2024",
		);
		expect(spec.facts.find((f) => f.key === "added")?.value).toBe("Sep 2025");
		expect(spec.facts.find((f) => f.key === "developer")?.value).toBe(
			"Moonshot AI",
		);
		expect(spec.sourceLabel).toBe("via models.dev");
	});

	test("adds a vision feature from enrichment modalities", () => {
		const spec = buildOpenRouterSpec(
			makeModel({ supported_parameters: [] }),
			ENRICHMENT,
		);
		expect(spec.features.some((f) => f.key === "vision")).toBe(true);
	});
});
