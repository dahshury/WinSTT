import { describe, expect, mock, test } from "bun:test";

// Provide a complete-enough shim so other tests' imports of the same module
// (mock-cached globally by bun:test) do not error on missing exports.
mock.module("@/shared/api/ipc-client", () => ({
	fetchModelCatalog: async () => [],
	onModelCatalog: () => () => undefined,
	fetchOllamaModels: async () => ({ models: [], reachable: false }),
	fetchOpenRouterModels: async () => ({ models: [], reachable: false }),
	onLlmCatalog: () => () => undefined,
}));

const { useCatalogStore } = await import("./catalog-store");

const validRaw = {
	id: "tiny",
	display_name: "Tiny",
	backend: "faster_whisper",
	family: "whisper",
	languages: ["en", "fr"],
	supports_language_detection: true,
	size_label: "39M",
	supports_realtime: true,
	onnx_model_name: null,
	description: "Smallest whisper",
};

const invalidRaw = {
	id: "broken",
	displayName: "no snake case",
};

describe("useCatalogStore.setModels", () => {
	test("validates raw input via zod and maps snake_case to camelCase", () => {
		useCatalogStore.getState().setModels([validRaw]);
		const state = useCatalogStore.getState();
		expect(state.models).toHaveLength(1);
		expect(state.models[0]?.id).toBe("tiny");
		expect(state.models[0]?.displayName).toBe("Tiny");
		expect(state.models[0]?.supportsLanguageDetection).toBe(true);
		expect(state.models[0]?.sizeLabel).toBe("39M");
		expect(state.isLoaded).toBe(true);
	});

	test("silently drops items that fail zod validation", () => {
		useCatalogStore.getState().setModels([validRaw, invalidRaw]);
		const state = useCatalogStore.getState();
		expect(state.models).toHaveLength(1);
		expect(state.models[0]?.id).toBe("tiny");
	});

	test("setModels with empty array still marks isLoaded true", () => {
		useCatalogStore.getState().setModels([]);
		expect(useCatalogStore.getState().isLoaded).toBe(true);
		expect(useCatalogStore.getState().models).toEqual([]);
	});
});

describe("useCatalogStore selectors", () => {
	test("getModel returns the model with matching id, undefined otherwise", () => {
		useCatalogStore.getState().setModels([validRaw]);
		expect(useCatalogStore.getState().getModel("tiny")?.id).toBe("tiny");
		expect(useCatalogStore.getState().getModel("missing")).toBeUndefined();
	});

	test("getFamilies returns unique families", () => {
		useCatalogStore
			.getState()
			.setModels([
				validRaw,
				{ ...validRaw, id: "base", family: "whisper" },
				{ ...validRaw, id: "x", family: "nemo" },
			]);
		const families = useCatalogStore.getState().getFamilies().sort();
		expect(families).toEqual(["nemo", "whisper"].sort());
	});
});
