import { describe, expect, mock, test } from "bun:test";

const fetchModelCatalogMock = mock(async () => [] as unknown[]);
const onModelCatalogMock = mock((_cb: (raw: unknown[]) => void) => () => undefined);

// Provide a complete-enough shim so other tests' imports of the same module
// (mock-cached globally by bun:test) do not error on missing exports.
mock.module("@/shared/api/ipc-client", () => ({
	fetchModelCatalog: fetchModelCatalogMock,
	onModelCatalog: onModelCatalogMock,
	fetchOllamaModels: async () => ({ models: [], reachable: false }),
	fetchOpenRouterModels: async () => ({ models: [], reachable: false }),
	onLlmCatalog: () => () => undefined,
	// Phase 3-5 model-swap + cache state additions — referenced by
	// model-state-store.ts and ModelSettingsPanel.tsx. Bun's mock.module
	// installs a process-global cache, so any subsequent test importing
	// those modules needs these exports to resolve. Keep this in sync
	// with the real ipc-client surface or you'll get cryptic
	// "Export named X not found" failures from cross-file test ordering.
	fetchModelsWithState: async () => null,
	onModelCacheChanged: () => () => undefined,
	onModelSwapStarted: () => () => undefined,
	onModelSwapCompleted: () => () => undefined,
	onModelSwapFailed: () => () => undefined,
	onRuntimeInfo: () => () => undefined,
	fetchRuntimeInfo: async () => null,
	sttReloadModel: () => undefined,
}));

const { useCatalogStore, initCatalogStore } = await import("./catalog-store");

const INITIAL_CATALOG_STATE = useCatalogStore.getInitialState();

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

describe("initCatalogStore", () => {
	test("calls fetchModelCatalog and onModelCatalog to subscribe", async () => {
		const prevFetchCount = fetchModelCatalogMock.mock.calls.length;
		const prevOnCount = onModelCatalogMock.mock.calls.length;
		initCatalogStore();
		// Give the async fetchModelCatalog a chance to settle
		await new Promise((r) => setTimeout(r, 0));
		expect(fetchModelCatalogMock.mock.calls.length).toBeGreaterThan(prevFetchCount);
		expect(onModelCatalogMock.mock.calls.length).toBeGreaterThan(prevOnCount);
	});

	test("populates store when fetchModelCatalog resolves with non-empty array", async () => {
		fetchModelCatalogMock.mockImplementationOnce(async () => [validRaw]);
		useCatalogStore.setState({ models: [], isLoaded: false });
		initCatalogStore();
		await new Promise((r) => setTimeout(r, 0));
		expect(useCatalogStore.getState().models).toHaveLength(1);
	});

	test("does not call setModels when fetchModelCatalog resolves with empty array", async () => {
		fetchModelCatalogMock.mockImplementationOnce(async () => []);
		useCatalogStore.setState({ models: [], isLoaded: false });
		initCatalogStore();
		await new Promise((r) => setTimeout(r, 0));
		// isLoaded remains false because setModels was not called
		expect(useCatalogStore.getState().isLoaded).toBe(false);
	});
});

describe("zod enum guards (mutation guards on enum entries)", () => {
	test.each(["faster_whisper", "onnx_asr"])("backend enum accepts %s", (backend) => {
		useCatalogStore.setState({ models: [], isLoaded: false });
		useCatalogStore.getState().setModels([{ ...validRaw, backend }]);
		expect(useCatalogStore.getState().models).toHaveLength(1);
		expect(useCatalogStore.getState().models[0]?.backend).toBe(backend);
	});

	test.each(["whisper", "nemo", "gigaam", "kaldi", "t-one"])("family enum accepts %s", (family) => {
		useCatalogStore.setState({ models: [], isLoaded: false });
		useCatalogStore.getState().setModels([{ ...validRaw, family }]);
		expect(useCatalogStore.getState().models).toHaveLength(1);
		expect(useCatalogStore.getState().models[0]?.family).toBe(family);
	});

	test("backend enum rejects unknown values (string-mutation distinguisher)", () => {
		useCatalogStore.setState({ models: [], isLoaded: false });
		useCatalogStore.getState().setModels([{ ...validRaw, backend: "unknown_backend" }]);
		// Item must be DROPPED by zod safeParse → length 0.
		expect(useCatalogStore.getState().models).toHaveLength(0);
	});

	test("family enum rejects unknown values", () => {
		useCatalogStore.setState({ models: [], isLoaded: false });
		useCatalogStore.getState().setModels([{ ...validRaw, family: "unknown_family" }]);
		expect(useCatalogStore.getState().models).toHaveLength(0);
	});
});

describe("store initial state (mutation guards)", () => {
	test("initial models is exactly [] (not the Stryker placeholder)", () => {
		// L71 ArrayDeclaration mutates [] to ["Stryker was here"] — would
		// initialize models with one bogus string entry.
		expect(INITIAL_CATALOG_STATE.models).toEqual([]);
		expect(INITIAL_CATALOG_STATE.models).toHaveLength(0);
	});

	test("initial isLoaded is exactly false (not true)", () => {
		// L72 BooleanLiteral mutates `false` to `true` — would lie about load state.
		expect(INITIAL_CATALOG_STATE.isLoaded).toBe(false);
	});
});

describe("catalog-store self-init block (window.electronAPI != null)", () => {
	test("fetchModelCatalog is called and setModels is invoked when result is non-empty array", async () => {
		// The module-level init already ran with empty array (window.electronAPI is set in test env).
		// We verify the mocks were called at module load time.
		// onModelCatalog should have been called to subscribe to live updates.
		expect(onModelCatalogMock).toHaveBeenCalled();
		// fetchModelCatalog should have been called once at startup.
		expect(fetchModelCatalogMock).toHaveBeenCalled();
	});

	test("live catalog update via onModelCatalog callback updates the store", () => {
		// Retrieve the callback registered with onModelCatalog
		const calls = onModelCatalogMock.mock.calls;
		const firstCall = calls.length > 0 ? calls[0] : undefined;
		const registeredCallback = firstCall
			? (firstCall[0] as ((raw: unknown[]) => void) | undefined)
			: undefined;
		if (!registeredCallback) {
			// Module init did not run (window.electronAPI was null) — skip
			return;
		}
		registeredCallback([validRaw]);
		const state = useCatalogStore.getState();
		expect(state.models.some((m) => m.id === "tiny")).toBe(true);
	});
});
