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

mock.module("@/shared/api/ipc-client", () => ({
	fetchOllamaModels: fetchSpy,
	onLlmCatalog: () => noop,
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
});
