import { describe, expect, test } from "bun:test";
import type { OpenRouterModel } from "@/shared/api/models";
import { filterModels } from "./model-selector-logic";

function model(overrides: Partial<OpenRouterModel>): OpenRouterModel {
	return {
		id: "openrouter/auto",
		name: "Auto",
		maker: "openrouter",
		...overrides,
	} as OpenRouterModel;
}

describe("filterModels search", () => {
	test("returns fuzzy matches synchronously in model order", () => {
		const exact = model({
			id: "acme/parakeet-v3",
			name: "Parakeet v3",
			maker: "acme",
		});
		const fuzzyOnly = model({
			id: "nvidia/parakeet-version-3",
			name: "Parakeet version 3",
			maker: "nvidia",
		});
		const miss = model({
			id: "openai/whisper",
			name: "Whisper",
			maker: "openai",
		});

		expect(
			filterModels([exact, fuzzyOnly, miss], { searchQuery: "Parkeet v3" }).map(
				(m) => m.id,
			),
		).toEqual(["acme/parakeet-v3", "nvidia/parakeet-version-3"]);
	});
});
