import { describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";

const fetchSpy = mock(async () => ({
	models: [{ id: "model-x", name: "Model X" }],
	reachable: true,
}));

// Spread the COMPLETE, behavior-faithful ipc-client fake, then override only
// the export this suite controls. bun:test's `mock.module` is process-global
// and never torn down, so a partial shim leaks an incomplete module into
// every later test file. `ipcClientMock()` exposes every real export and
// routes each through `window.electronAPI` exactly as the real module, so the
// leak is harmless regardless of file order.
mock.module("@/shared/api/ipc-client", () => ({
	...ipcClientMock(),
	fetchOpenRouterModels: fetchSpy,
}));

const { useOpenRouterCatalogStore } = await import("./openrouter-catalog-store");

describe("useOpenRouterCatalogStore initial state", () => {
	// Use getInitialState() to inspect the literal defaults from the store
	// factory, immune to other tests' mutations.
	test("models defaults to an empty array (not a placeholder)", () => {
		expect(useOpenRouterCatalogStore.getInitialState().models).toEqual([]);
	});

	test("isLoaded defaults to false", () => {
		expect(useOpenRouterCatalogStore.getInitialState().isLoaded).toBe(false);
	});

	test("isReachable defaults to false", () => {
		expect(useOpenRouterCatalogStore.getInitialState().isReachable).toBe(false);
	});
});

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
