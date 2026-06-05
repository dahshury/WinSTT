import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import { IPC } from "@/shared/api/ipc-channels";
import { ModelFamilySchema, TranscriberBackendSchema } from "@/shared/api/schema.zod";

// ---------------------------------------------------------------------------
// Why this test routes through `window.nativeBridge` instead of overriding
// exports via `mock.module`:
//
// bun:test evaluates EVERY `mock.module()` during the module-load phase and,
// for a given module path, the LAST-registered factory wins PROCESS-GLOBALLY
// for all files (there is no per-file teardown). So if this file overrode
// `fetchModelCatalog`/`onModelCatalog` with local spies, those spies would
// leak into (or be clobbered by) every other test that imports ipc-client,
// producing order-dependent cross-file failures (StatusBar's catalog goes
// empty, etc.).
//
// Instead we install the COMPLETE, behavior-faithful `ipcClientMock()` — the
// SAME clean fake every other partial-mock file installs, so whichever wins
// globally is identical and harmless — and drive this suite's data through a
// per-file `window.nativeBridge` stub that is restored in afterEach. The real
// catalog-store routes `fetchModelCatalog` → invoke(STT_GET_MODEL_CATALOG)
// and `onModelCatalog` → on(STT_MODEL_CATALOG), so the faithful fake honours
// our stub exactly as the real module would.
// ---------------------------------------------------------------------------

mock.module("@/shared/api/ipc-client", () => ipcClientMock());

const originalNativeBridge = window.nativeBridge;

let catalogPayload: unknown[] = [];
let catalogListener: ((raw: unknown[]) => void) | null = null;
const fetchInvokes: string[] = [];
const onSubscriptions: string[] = [];

function installNativeBridgeStub(): void {
	catalogPayload = [];
	catalogListener = null;
	fetchInvokes.length = 0;
	onSubscriptions.length = 0;
	window.nativeBridge = {
		getPathForFile: () => "",
		send: () => undefined,
		invoke: async (channel: string) => {
			if (channel === IPC.STT_GET_MODEL_CATALOG) {
				fetchInvokes.push(channel);
				return catalogPayload;
			}
			return;
		},
		secureInvoke: async () => undefined,
		on: (channel: string, cb: (...args: unknown[]) => void) => {
			if (channel === IPC.STT_MODEL_CATALOG) {
				onSubscriptions.push(channel);
				catalogListener = (raw: unknown[]) => cb({ models: raw });
			}
			return () => {
				catalogListener = null;
			};
		},
	};
}

const { useCatalogStore, initCatalogStore, _resetCatalogStoreInitForTests } =
	await import("./catalog-store");

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
	preview_capable: true,
	native_streaming: false,
	final_reuse_safe: false,
	onnx_model_name: null,
	description: "Smallest whisper",
};

const invalidRaw = {
	id: "broken",
	displayName: "no snake case",
};

beforeEach(() => {
	_resetCatalogStoreInitForTests();
	installNativeBridgeStub();
	useCatalogStore.setState({ models: [], isLoaded: false });
});

afterEach(() => {
	_resetCatalogStoreInitForTests();
	window.nativeBridge = originalNativeBridge;
});

describe("useCatalogStore.setModels", () => {
	test("validates raw input via zod and maps snake_case to camelCase", () => {
		useCatalogStore.getState().setModels([validRaw]);
		const state = useCatalogStore.getState();
		expect(state.models).toHaveLength(1);
		expect(state.models[0]?.id).toBe("tiny");
		expect(state.models[0]?.displayName).toBe("Tiny");
		expect(state.models[0]?.supportsLanguageDetection).toBe(true);
		expect(state.models[0]?.sizeLabel).toBe("39M");
		expect(state.models[0]?.previewCapable).toBe(true);
		expect(state.models[0]?.nativeStreaming).toBe(false);
		expect(state.models[0]?.finalReuseSafe).toBe(false);
		expect(state.models[0]?.supportsRealtime).toBe(true);
		expect(state.isLoaded).toBe(true);
	});

	test("strips native streaming latency tokens out of display names", () => {
		useCatalogStore.getState().setModels([
			{
				...validRaw,
				id: "streaming-nemotron-en-1120ms-int8",
				display_name: "Streaming Nemotron 1120ms INT8",
				native_streaming: true,
			},
		]);
		expect(useCatalogStore.getState().models[0]?.displayName).toBe(
			"Streaming Nemotron",
		);
	});

	test("falls back from split preview field to the legacy realtime flag", () => {
		const legacyRaw = {
			...validRaw,
			preview_capable: undefined,
			native_streaming: undefined,
			final_reuse_safe: undefined,
		};
		useCatalogStore.getState().setModels([legacyRaw]);
		const model = useCatalogStore.getState().models[0];
		expect(model?.previewCapable).toBe(true);
		expect(model?.supportsRealtime).toBe(true);
		expect(model?.nativeStreaming).toBe(false);
		expect(model?.finalReuseSafe).toBe(false);
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
		initCatalogStore();
		// Give the async fetchModelCatalog a chance to settle
		await new Promise((r) => setTimeout(r, 0));
		expect(fetchInvokes.length).toBeGreaterThan(0);
		expect(onSubscriptions.length).toBeGreaterThan(0);
	});

	test("populates store when fetchModelCatalog resolves with non-empty array", async () => {
		catalogPayload = [validRaw];
		useCatalogStore.setState({ models: [], isLoaded: false });
		initCatalogStore();
		await new Promise((r) => setTimeout(r, 0));
		expect(useCatalogStore.getState().models).toHaveLength(1);
	});

	test("does not call setModels when fetchModelCatalog resolves with empty array", async () => {
		catalogPayload = [];
		useCatalogStore.setState({ models: [], isLoaded: false });
		initCatalogStore();
		await new Promise((r) => setTimeout(r, 0));
		// isLoaded remains false because setModels was not called
		expect(useCatalogStore.getState().isLoaded).toBe(false);
	});

	test("retries initialization after the native bridge is installed later", async () => {
		_resetCatalogStoreInitForTests();
		window.nativeBridge = undefined as unknown as Window["nativeBridge"];

		initCatalogStore();
		expect(fetchInvokes).toHaveLength(0);
		expect(onSubscriptions).toHaveLength(0);

		installNativeBridgeStub();
		catalogPayload = [validRaw];
		initCatalogStore();
		await new Promise((r) => setTimeout(r, 0));

		expect(fetchInvokes).toEqual([IPC.STT_GET_MODEL_CATALOG]);
		expect(onSubscriptions).toEqual([IPC.STT_MODEL_CATALOG]);
		expect(useCatalogStore.getState().models[0]?.id).toBe("tiny");
	});
});

describe("zod enum guards (mutation guards on enum entries)", () => {
	test.each(TranscriberBackendSchema.options)("backend enum accepts %s", (backend) => {
		useCatalogStore.setState({ models: [], isLoaded: false });
		useCatalogStore.getState().setModels([{ ...validRaw, backend }]);
		expect(useCatalogStore.getState().models).toHaveLength(1);
		expect(useCatalogStore.getState().models[0]?.backend).toBe(backend);
	});

	test.each(ModelFamilySchema.options)("family enum accepts %s", (family) => {
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

describe("catalog-store self-init block (window.nativeBridge != null)", () => {
	test("fetchModelCatalog is invoked and onModelCatalog subscribes on init", async () => {
		initCatalogStore();
		await new Promise((r) => setTimeout(r, 0));
		expect(onSubscriptions.length).toBeGreaterThan(0);
		expect(fetchInvokes.length).toBeGreaterThan(0);
	});

	test("live catalog update via onModelCatalog callback updates the store", async () => {
		initCatalogStore();
		await new Promise((r) => setTimeout(r, 0));
		expect(catalogListener).not.toBeNull();
		catalogListener?.([validRaw]);
		const state = useCatalogStore.getState();
		expect(state.models.some((m) => m.id === "tiny")).toBe(true);
	});

	test("live empty catalog update does not clear the last valid catalog", async () => {
		catalogPayload = [validRaw];
		useCatalogStore.setState({ models: [], isLoaded: false });
		initCatalogStore();
		await new Promise((r) => setTimeout(r, 0));
		expect(useCatalogStore.getState().models).toHaveLength(1);

		catalogListener?.([]);

		const state = useCatalogStore.getState();
		expect(state.models).toHaveLength(1);
		expect(state.models[0]?.id).toBe("tiny");
		expect(state.isLoaded).toBe(true);
	});
});
