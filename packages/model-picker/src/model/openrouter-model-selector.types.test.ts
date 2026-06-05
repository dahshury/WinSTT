import { describe, expect, test } from "bun:test";
import type { OpenRouterModelSelectorProps } from "./openrouter-model-selector.types";

describe("OpenRouterModelSelectorProps type", () => {
	test("can be instantiated with the minimal required surface", () => {
		const minimal: OpenRouterModelSelectorProps = {
			models: [],
			onChange: () => undefined,
			value: "",
		};
		expect(typeof minimal.onChange).toBe("function");
		expect(minimal.models).toEqual([]);
		expect(minimal.value).toBe("");
	});

	test("supports all optional fields", () => {
		const full: OpenRouterModelSelectorProps = {
			description: "Pick a model",
			disabled: false,
			disabledModelIds: ["openai/gpt-4o"],
			exclusionConfig: {
				excludedModelId: undefined,
				excludeAllProviders: false,
				excludedProviderSlug: undefined,
			},
			isLoading: false,
			label: "Model",
			models: [],
			onChange: () => undefined,
			placeholder: "Search…",
			value: "",
		};
		expect(full.disabledModelIds).toEqual(["openai/gpt-4o"]);
	});
});
