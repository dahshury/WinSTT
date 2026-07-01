import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";

const fetchSpy = mock(async () => ({
	models: [{ id: "model-x", name: "Model X" }],
	reachable: true,
}));

// Spread the COMPLETE, behavior-faithful ipc-client fake, then override only
// the export this suite controls. bun:test's `mock.module` is process-global
// and never torn down, so a partial shim leaks an incomplete module into
// every later test file. `ipcClientMock()` exposes every real export and
// routes each through `window.nativeBridge` exactly as the real module, so the
// leak is harmless regardless of file order.
mock.module("@/shared/api/ipc-client", () => ({
	...ipcClientMock(),
	fetchOpenRouterModels: fetchSpy,
}));

const { useOpenRouterCatalogStore } =
	await import("./openrouter-catalog-store");

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
	beforeEach(() => {
		// The store is a process-global singleton; reset the loaded-cache flag so
		// each test exercises a fresh fetch (scanModels now short-circuits once the
		// catalog is already loaded).
		useOpenRouterCatalogStore.setState({
			error: null,
			isLoaded: false,
			isReachable: false,
			isScanning: false,
			models: [],
		});
	});

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

	test("reuses the cached catalog on a plain call, refetches only when forced", async () => {
		fetchSpy.mockClear();
		const { scanModels } = useOpenRouterCatalogStore.getState();
		await scanModels();
		await scanModels();
		// Second plain call is served from cache (no refetch / spin on reopen).
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		await scanModels(true);
		// Forced (e.g. after saving an API key) bypasses the cache.
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	test("warms the catalog without entering the loading state", async () => {
		fetchSpy.mockClear();
		fetchSpy.mockImplementationOnce(async () => ({
			models: [{ id: "warm-model", name: "Warm Model" }],
			reachable: true,
		}));

		const warm = useOpenRouterCatalogStore.getState().warmModels();

		expect(useOpenRouterCatalogStore.getState().isScanning).toBe(false);
		await warm;

		const state = useOpenRouterCatalogStore.getState();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(state.isScanning).toBe(false);
		expect(state.isLoaded).toBe(true);
		expect(state.models).toEqual([{ id: "warm-model", name: "Warm Model" }]);
	});
});
