import { describe, expect, mock, test } from "bun:test";
import type { ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";

// Per-test overrides so different cases can flip what fetchModelsWithState
// resolves with and capture the callbacks wired by onModelCacheChanged /
// onModelSwapCompleted. Bun's `mock.module` installs a PROCESS-GLOBAL cache,
// so the implementations defined here are also visible to other tests that
// import `@/shared/api/ipc-client` — keep the surface in sync with catalog-store.test.ts.
const ipcOverrides: {
	payload: { states: ModelStateEntry[]; system_info: SystemInfoEntry } | null;
	cacheCb: ((id: string) => void) | null;
	swapCb: (() => void) | null;
} = {
	payload: null,
	cacheCb: null,
	swapCb: null,
};

const fetchSpy = mock(async () => ipcOverrides.payload);

mock.module("@/shared/api/ipc-client", () => ({
	// Surface required by model-state-store.ts itself:
	fetchModelsWithState: fetchSpy,
	onModelCacheChanged: (cb: (id: string) => void) => {
		ipcOverrides.cacheCb = cb;
		return () => {
			ipcOverrides.cacheCb = null;
		};
	},
	onModelSwapCompleted: (cb: () => void) => {
		ipcOverrides.swapCb = cb;
		return () => {
			ipcOverrides.swapCb = null;
		};
	},
	// Padding surface so that other modules pulled in transitively by the
	// store (or by cross-test mock-cache pollution) keep resolving.
	fetchModelCatalog: async () => [],
	onModelCatalog: () => () => undefined,
	fetchOllamaModels: async () => ({ models: [], reachable: false }),
	fetchOpenRouterModels: async () => ({ models: [], reachable: false }),
	onLlmCatalog: () => () => undefined,
	onModelSwapStarted: () => () => undefined,
	onModelSwapFailed: () => () => undefined,
	onRuntimeInfo: () => () => undefined,
	fetchRuntimeInfo: async () => null,
	sttReloadModel: () => undefined,
}));

const { useModelStateStore, initModelStateStore } = await import("./model-state-store");

const SYSTEM_INFO: SystemInfoEntry = {
	gpus: [{ name: "RTX 4090", total_vram_bytes: 24 * 1024 ** 3 }],
	total_ram_bytes: 32 * 1024 ** 3,
};

function makeEntry(id: string): ModelStateEntry {
	return {
		id,
		cache: { downloaded_bytes: 0, progress: 0, state: "not_cached", total_bytes: 100 },
		comfortable_on_cpu: true,
		comfortable_on_gpu: true,
		estimated_bytes: 100,
	};
}

function resetStore(): void {
	useModelStateStore.setState({ statesById: {}, systemInfo: null, isLoaded: false });
}

describe("useModelStateStore.setAll (covers toMap)", () => {
	test("maps array of entries into statesById keyed by id and flips isLoaded", () => {
		resetStore();
		const entries = [makeEntry("tiny"), makeEntry("base"), makeEntry("small")];
		useModelStateStore.getState().setAll(entries, SYSTEM_INFO);
		const state = useModelStateStore.getState();
		expect(Object.keys(state.statesById).sort()).toEqual(["base", "small", "tiny"]);
		expect(state.statesById.tiny?.id).toBe("tiny");
		expect(state.statesById.base?.id).toBe("base");
		expect(state.systemInfo).toEqual(SYSTEM_INFO);
		expect(state.isLoaded).toBe(true);
	});

	test("setAll with empty entries clears statesById but still marks isLoaded", () => {
		resetStore();
		useModelStateStore.getState().setAll([], SYSTEM_INFO);
		const state = useModelStateStore.getState();
		expect(state.statesById).toEqual({});
		expect(state.isLoaded).toBe(true);
		expect(state.systemInfo).toEqual(SYSTEM_INFO);
	});

	test("toMap overwrites duplicates with the last entry for a given id", () => {
		resetStore();
		const first = makeEntry("dup");
		const second: ModelStateEntry = { ...makeEntry("dup"), estimated_bytes: 999 };
		useModelStateStore.getState().setAll([first, second], SYSTEM_INFO);
		expect(useModelStateStore.getState().statesById.dup?.estimated_bytes).toBe(999);
	});
});

describe("useModelStateStore.getState (selector)", () => {
	test("returns the entry for a known id, undefined for missing", () => {
		resetStore();
		useModelStateStore.getState().setAll([makeEntry("tiny")], SYSTEM_INFO);
		expect(useModelStateStore.getState().getState("tiny")?.id).toBe("tiny");
		expect(useModelStateStore.getState().getState("absent")).toBeUndefined();
	});
});

describe("useModelStateStore.refresh", () => {
	test("populates store from IPC payload (happy path → covers all 3 branches)", async () => {
		resetStore();
		ipcOverrides.payload = {
			states: [makeEntry("tiny"), makeEntry("base")],
			system_info: SYSTEM_INFO,
		};
		await useModelStateStore.getState().refresh();
		const state = useModelStateStore.getState();
		expect(state.isLoaded).toBe(true);
		expect(state.statesById.tiny).toBeDefined();
		expect(state.statesById.base).toBeDefined();
		expect(state.systemInfo).toEqual(SYSTEM_INFO);
	});

	test("ignores null payload and does NOT mark loaded (kills `if(payload)` mutant)", async () => {
		resetStore();
		ipcOverrides.payload = null;
		await useModelStateStore.getState().refresh();
		const state = useModelStateStore.getState();
		expect(state.isLoaded).toBe(false);
		expect(state.statesById).toEqual({});
		expect(state.systemInfo).toBeNull();
	});

	test("ignores payload whose `states` is not an array (kills Array.isArray mutant)", async () => {
		resetStore();
		// Intentionally malformed: states must be an array but it's a string.
		ipcOverrides.payload = {
			states: "not-an-array" as unknown as ModelStateEntry[],
			system_info: SYSTEM_INFO,
		};
		await useModelStateStore.getState().refresh();
		const state = useModelStateStore.getState();
		expect(state.isLoaded).toBe(false);
		expect(state.statesById).toEqual({});
	});

	test("accepts empty states array as a valid load", async () => {
		resetStore();
		ipcOverrides.payload = { states: [], system_info: SYSTEM_INFO };
		await useModelStateStore.getState().refresh();
		const state = useModelStateStore.getState();
		expect(state.isLoaded).toBe(true);
		expect(state.statesById).toEqual({});
		expect(state.systemInfo).toEqual(SYSTEM_INFO);
	});
});

describe("initModelStateStore", () => {
	test("subscribes to cache + swap pushes and triggers refresh on callback", async () => {
		resetStore();
		ipcOverrides.cacheCb = null;
		ipcOverrides.swapCb = null;
		const unsub = initModelStateStore();
		expect(ipcOverrides.cacheCb).not.toBeNull();
		expect(ipcOverrides.swapCb).not.toBeNull();

		// Cache-changed push should trigger a fresh refresh().
		ipcOverrides.payload = { states: [makeEntry("from-cache")], system_info: SYSTEM_INFO };
		const cacheCb = ipcOverrides.cacheCb as ((id: string) => void) | null;
		cacheCb?.("from-cache");
		// Wait a microtask so the in-flight refresh() promise resolves.
		await new Promise((r) => setTimeout(r, 0));
		expect(useModelStateStore.getState().statesById["from-cache"]).toBeDefined();

		// Swap-completed push should also trigger a refresh().
		ipcOverrides.payload = { states: [makeEntry("from-swap")], system_info: SYSTEM_INFO };
		const swapCb = ipcOverrides.swapCb as (() => void) | null;
		swapCb?.();
		await new Promise((r) => setTimeout(r, 0));
		expect(useModelStateStore.getState().statesById["from-swap"]).toBeDefined();

		// Unsubscribing tears both callbacks down.
		unsub();
		expect(ipcOverrides.cacheCb).toBeNull();
		expect(ipcOverrides.swapCb).toBeNull();
	});
});
