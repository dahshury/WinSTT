import { describe, expect, mock, test } from "bun:test";

const fetchSpy = mock(async () => ({
	models: [{ id: "model-x", name: "Model X" }],
	reachable: true,
}));

// Provide a complete-enough shim so other tests' imports of the same module
// (mock-cached globally by bun:test) do not error on missing exports.
mock.module("@/shared/api/ipc-client", () => ({
	fetchOpenRouterModels: fetchSpy,
	fetchOllamaModels: async () => ({ models: [], reachable: false }),
	fetchModelCatalog: async () => [],
	onModelCatalog: () => () => undefined,
	onLlmCatalog: () => () => undefined,
}));

const { useOpenRouterCatalogStore } = await import("./openrouter-catalog-store");

describe("useOpenRouterCatalogStore.scanModels", () => {
	test("collapses overlapping calls into a single fetch", async () => {
		fetchSpy.mockClear();
		const { scanModels } = useOpenRouterCatalogStore.getState();

		await Promise.all([scanModels(), scanModels(), scanModels()]);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const state = useOpenRouterCatalogStore.getState();
		expect(state.isLoaded).toBe(true);
		expect(state.isScanning).toBe(false);
		expect(state.isReachable).toBe(true);
		expect(state.models).toHaveLength(1);
	});

	test("captures unreachable + error from IPC result", async () => {
		fetchSpy.mockImplementationOnce(async () => ({
			models: [],
			reachable: false,
			error: "rate-limited",
		}));
		await useOpenRouterCatalogStore.getState().scanModels();
		const state = useOpenRouterCatalogStore.getState();
		expect(state.isReachable).toBe(false);
		expect(state.error).toBe("rate-limited");
	});

	test("captures thrown errors from the fetcher", async () => {
		fetchSpy.mockImplementationOnce(async () => {
			throw new Error("offline");
		});
		await useOpenRouterCatalogStore.getState().scanModels();
		const state = useOpenRouterCatalogStore.getState();
		expect(state.isScanning).toBe(false);
		expect(state.isReachable).toBe(false);
		expect(state.error).toContain("offline");
		expect(state.isLoaded).toBe(true);
	});
});
