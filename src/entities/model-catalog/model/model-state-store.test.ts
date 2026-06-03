import { afterEach, describe, expect, mock, test } from "bun:test";
import { asInvalid } from "@test/lib/cast";
import { ipcClientMock } from "@test/mocks/ipc-client";
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

// Spread the COMPLETE, behavior-faithful ipc-client fake, then override only
// the exports this suite controls. bun:test's `mock.module` is process-global
// and never torn down, so a partial shim leaks an incomplete module into
// every later test file. `ipcClientMock()` exposes every real export and
// routes each through `window.nativeBridge` exactly as the real module, so the
// leak is harmless regardless of file order.
mock.module("@/shared/api/ipc-client", () => ({
	...ipcClientMock(),
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
}));

const {
	useModelStateStore,
	initModelStateStore,
	_resetModelStateRetryForTests,
	_setModelStateRetryDelaysForTests,
} = await import("./model-state-store");

const SYSTEM_INFO: SystemInfoEntry = {
	gpus: [{ name: "RTX 4090", total_vram_bytes: 24 * 1024 ** 3 }],
	total_ram_bytes: 32 * 1024 ** 3,
};

function makeEntry(id: string): ModelStateEntry {
	return {
		id,
		cache: { downloaded_bytes: 0, progress: 0, state: "not_cached", total_bytes: 100 },
		cache_by_quantization: {},
		available_quantizations: [""],
		comfortable_on_cpu: true,
		comfortable_on_gpu: true,
		estimated_bytes: 100,
	};
}

function resetStore(): void {
	useModelStateStore.setState({ statesById: {}, systemInfo: null, isLoaded: false });
}

afterEach(() => {
	// Cancel any pending retry timer a failed refresh() armed — a leaked
	// timer would fire in a sibling test (the store is a process-global
	// singleton) and call refresh() against another test's payload.
	_resetModelStateRetryForTests();
});

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
			states: asInvalid<ModelStateEntry[]>("not-an-array"),
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

	test("retries after a failed first fetch until the server responds (no model switch needed)", async () => {
		// Repro: on launch the server's first `list_models_with_state` can
		// exceed the IPC timeout while the startup HF language-overlay refresh
		// saturates (~25s of per-model `model_info` GETs). Before the retry,
		// `refresh()` gave up silently and the picker stayed empty until a
		// `model_cache_changed` (i.e. a model switch) re-triggered it.
		resetStore();
		_setModelStateRetryDelaysForTests([5, 5, 5, 5]);
		ipcOverrides.payload = null; // first attempt times out → null
		await useModelStateStore.getState().refresh();
		expect(useModelStateStore.getState().isLoaded).toBe(false);

		// Server becomes responsive; a scheduled retry must pick it up.
		ipcOverrides.payload = { states: [makeEntry("vosk")], system_info: SYSTEM_INFO };
		await new Promise((r) => setTimeout(r, 60));

		const state = useModelStateStore.getState();
		expect(state.isLoaded).toBe(true);
		expect(state.statesById.vosk).toBeDefined();
	});

	test("stops retrying once a fetch succeeds (no runaway timers)", async () => {
		resetStore();
		_setModelStateRetryDelaysForTests([5, 5, 5, 5]);
		fetchSpy.mockClear();
		ipcOverrides.payload = { states: [makeEntry("tiny")], system_info: SYSTEM_INFO };
		await useModelStateStore.getState().refresh();
		expect(useModelStateStore.getState().isLoaded).toBe(true);
		const callsAfterSuccess = fetchSpy.mock.calls.length;
		await new Promise((r) => setTimeout(r, 40));
		// No further fetches scheduled after a successful load.
		expect(fetchSpy.mock.calls.length).toBe(callsAfterSuccess);
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
