import { describe, expect, mock, test } from "bun:test";

// Mock the IPC client before importing the store so the store sees our mocked fetcher.
const fetchSpy = mock(async () => {
	// Resolve on next microtask so concurrent calls overlap.
	await Promise.resolve();
	return {
		models: [{ name: "llama3", size: 1, modifiedAt: "" }],
		reachable: true,
	};
});

const noop = () => undefined;

// Provide a complete-enough shim so other tests' imports of the same module
// (mock-cached globally by bun:test) do not error on missing exports.
mock.module("@/shared/api/ipc-client", () => ({
	fetchOllamaModels: fetchSpy,
	onLlmCatalog: () => noop,
	onOllamaPullProgress: () => noop,
	pullOllamaModel: async (model: string) => ({ success: true, model }),
	cancelOllamaModelPull: async () => ({ cancelled: false }),
	deleteOllamaModel: async (model: string) => ({ success: true, model }),
	fetchOpenRouterModels: async () => ({ models: [], reachable: false }),
	fetchModelCatalog: async () => [],
	onModelCatalog: () => () => undefined,
}));

const { useLlmCatalogStore } = await import("./llm-catalog-store");

describe("useLlmCatalogStore.scanModels — concurrent-call gating", () => {
	test("collapses overlapping calls into a single fetch", async () => {
		fetchSpy.mockClear();
		const { scanModels } = useLlmCatalogStore.getState();

		// Three near-simultaneous calls — what happens when multiple panels mount.
		await Promise.all([scanModels(), scanModels(), scanModels()]);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const state = useLlmCatalogStore.getState();
		expect(state.isLoaded).toBe(true);
		expect(state.isScanning).toBe(false);
		expect(state.isReachable).toBe(true);
		expect(state.error).toBeNull();
	});

	test("allows a fresh scan once the previous one settles", async () => {
		fetchSpy.mockClear();
		const { scanModels } = useLlmCatalogStore.getState();

		await scanModels();
		await scanModels();

		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	test("surfaces unreachable + error from IPC result", async () => {
		fetchSpy.mockImplementationOnce(async () => ({
			models: [],
			reachable: false,
			error: "Ollama unreachable",
		}));
		const { scanModels } = useLlmCatalogStore.getState();

		await scanModels();

		const state = useLlmCatalogStore.getState();
		expect(state.isReachable).toBe(false);
		expect(state.error).toBe("Ollama unreachable");
		expect(state.models).toEqual([]);
		expect(state.isLoaded).toBe(true);
	});

	test("captures thrown errors from the fetcher and resets isScanning", async () => {
		fetchSpy.mockImplementationOnce(async () => {
			throw new Error("network down");
		});
		const { scanModels } = useLlmCatalogStore.getState();
		await scanModels();
		const state = useLlmCatalogStore.getState();
		expect(state.isScanning).toBe(false);
		expect(state.isReachable).toBe(false);
		expect(state.error).toContain("network down");
		expect(state.isLoaded).toBe(true);
	});
});

describe("useLlmCatalogStore mutators", () => {
	test("setModels marks isLoaded true and clears error", () => {
		useLlmCatalogStore.setState({ isLoaded: false, error: "old" });
		useLlmCatalogStore.getState().setModels([{ name: "m", size: 1, modifiedAt: "" }]);
		const state = useLlmCatalogStore.getState();
		expect(state.isLoaded).toBe(true);
		expect(state.error).toBeNull();
		expect(state.models).toHaveLength(1);
	});

	test("setScanning toggles isScanning flag", () => {
		useLlmCatalogStore.getState().setScanning(true);
		expect(useLlmCatalogStore.getState().isScanning).toBe(true);
		useLlmCatalogStore.getState().setScanning(false);
		expect(useLlmCatalogStore.getState().isScanning).toBe(false);
	});

	test("setError marks isLoaded true and stores the message", () => {
		useLlmCatalogStore.setState({ isLoaded: false, error: null });
		useLlmCatalogStore.getState().setError("boom");
		const state = useLlmCatalogStore.getState();
		expect(state.error).toBe("boom");
		expect(state.isLoaded).toBe(true);
	});
});
