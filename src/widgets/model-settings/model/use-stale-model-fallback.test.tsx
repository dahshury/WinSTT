import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import type { ModelInfo } from "@/entities/model-catalog";
import type { useSettingsStore } from "@/entities/setting";
import type { ModelStateEntry } from "@/shared/api/ipc-client";
import {
	_setStaleModelFallbackPatchApplierForTests,
	useStaleModelFallback,
} from "./use-stale-model-fallback";

// Mirror the production action signature exactly so the mock satisfies the
// hook's `update` parameter under exactOptionalPropertyTypes (the previous
// hand-rolled optional-property shape was not assignable to `ModelPatch`).
type Update = ReturnType<
	typeof useSettingsStore.getState
>["updateModelSettings"];
type StatesById = Record<string, ModelStateEntry>;

function model(
	overrides: Partial<ModelInfo> & Pick<ModelInfo, "id">,
): ModelInfo {
	const previewCapable =
		overrides.previewCapable ?? overrides.supportsRealtime ?? false;
	return {
		displayName: overrides.displayName ?? overrides.id,
		backend: overrides.backend ?? "onnx_asr",
		family: overrides.family ?? "whisper",
		languages: [],
		supportsLanguageDetection: false,
		sizeLabel: "",
		previewCapable,
		nativeStreaming: overrides.nativeStreaming ?? false,
		finalReuseSafe: overrides.finalReuseSafe ?? previewCapable,
		supportsRealtime: previewCapable,
		onnxModelName: null,
		description: "",
		availableQuantizations: [],
		sizeBytesByQuantization: {},
		available: true,
		errorMessage: "",
		localPath: null,
		speedScore: 0.5,
		accuracyScore: 0.5,
		...overrides,
	};
}

function stateEntry(estimatedBytes: number, cached: boolean): ModelStateEntry {
	return {
		cache: {
			state: cached ? "cached" : "not_cached",
			progress: cached ? 1 : 0,
		},
		estimated_bytes: estimatedBytes,
		comfortable_on_cpu: true,
		comfortable_on_gpu: true,
	} as unknown as ModelStateEntry;
}

interface HookArgs {
	catalogLoaded: boolean;
	catalogModels: ModelInfo[];
	currentMainModel: string | undefined;
	currentRealtimeModel: string | undefined;
	cloudFallbackModel?: string | null;
	statesById: StatesById;
	statesLoaded?: boolean;
	update: Update;
}

function renderFallback(args: HookArgs) {
	_setStaleModelFallbackPatchApplierForTests(args.update);
	return renderHook(
		(p: HookArgs) =>
			useStaleModelFallback(
				p.catalogLoaded,
				p.catalogModels,
				p.statesById,
				p.statesLoaded ?? true,
				p.currentMainModel,
				p.currentRealtimeModel,
				undefined,
				p.cloudFallbackModel ?? null,
			),
		{ initialProps: args },
	);
}

// A typical valid catalog: "tiny" is the smallest native-streaming realtime model.
const CATALOG: ModelInfo[] = [
	model({
		id: "tiny",
		backend: "onnx_asr",
		previewCapable: true,
		nativeStreaming: true,
	}),
	model({
		id: "base",
		backend: "faster_whisper",
		previewCapable: true,
		nativeStreaming: true,
	}),
	model({ id: "large", backend: "onnx_asr", previewCapable: false }),
];

const STATES: StatesById = {
	tiny: stateEntry(100, true),
	base: stateEntry(200, true),
	large: stateEntry(900, true),
};

describe("useStaleModelFallback", () => {
	beforeEach(() => {
		cleanup();
		_setStaleModelFallbackPatchApplierForTests(null);
	});

	afterEach(() => {
		cleanup();
		_setStaleModelFallbackPatchApplierForTests(null);
	});

	test("skips entirely while the catalog is still loading (both effects)", () => {
		const update = mock<Update>(() => undefined);
		renderFallback({
			catalogLoaded: false,
			catalogModels: CATALOG,
			statesById: STATES,
			// Both stale — but the loading guard must suppress any fallback.
			currentMainModel: "ghost-main",
			currentRealtimeModel: "ghost-rt",
			update,
		});
		expect(update).not.toHaveBeenCalled();
	});

	test("does not touch a cloud provider:* main id", () => {
		const update = mock<Update>(() => undefined);
		renderFallback({
			catalogLoaded: true,
			catalogModels: CATALOG,
			statesById: STATES,
			// providerOf returns "openrouter" → main effect bails before the
			// needsModelFallback check.
			currentMainModel: "openrouter:openai/gpt-4o-transcribe",
			// Keep realtime valid so the second effect doesn't fire either.
			currentRealtimeModel: "tiny",
			update,
		});
		expect(update).not.toHaveBeenCalled();
	});

	test("leaves a valid main model alone", () => {
		const update = mock<Update>(() => undefined);
		renderFallback({
			catalogLoaded: true,
			catalogModels: CATALOG,
			statesById: STATES,
			currentMainModel: "large",
			currentRealtimeModel: "tiny",
			update,
		});
		expect(update).not.toHaveBeenCalled();
	});

	test("migrates a saved low-latency streaming main model to the high-latency row", () => {
		const update = mock<Update>(() => undefined);
		const catalog = [
			model({
				id: "streaming-nemo-rnnt-en-80ms-int8",
				nativeStreaming: true,
			}),
			model({
				id: "streaming-nemo-rnnt-en-1040ms-int8",
				nativeStreaming: true,
			}),
		];
		renderFallback({
			catalogLoaded: true,
			catalogModels: catalog,
			statesById: {
				"streaming-nemo-rnnt-en-80ms-int8": stateEntry(50, true),
				"streaming-nemo-rnnt-en-1040ms-int8": stateEntry(100, true),
			},
			currentMainModel: "streaming-nemo-rnnt-en-80ms-int8",
			currentRealtimeModel: "streaming-nemo-rnnt-en-1040ms-int8",
			update,
		});
		expect(update).toHaveBeenCalledWith({
			model: "streaming-nemo-rnnt-en-1040ms-int8",
			backend: "onnx_asr",
		});
	});

	test("migrates a saved low-latency realtime model to the high-latency row", () => {
		const update = mock<Update>(() => undefined);
		const catalog = [
			model({ id: "main-en", languages: ["en"], nativeStreaming: false }),
			model({
				id: "streaming-parakeet-unified-en-240ms-int8",
				languages: ["en"],
				nativeStreaming: true,
			}),
			model({
				id: "streaming-parakeet-unified-en-1120ms-int8",
				languages: ["en"],
				nativeStreaming: true,
			}),
		];
		renderFallback({
			catalogLoaded: true,
			catalogModels: catalog,
			statesById: {
				"main-en": stateEntry(300, true),
				"streaming-parakeet-unified-en-240ms-int8": stateEntry(50, true),
				"streaming-parakeet-unified-en-1120ms-int8": stateEntry(100, true),
			},
			currentMainModel: "main-en",
			currentRealtimeModel: "streaming-parakeet-unified-en-240ms-int8",
			update,
		});
		expect(update).toHaveBeenCalledWith({
			realtimeModel: "streaming-parakeet-unified-en-1120ms-int8",
		});
	});

	test("falls back the main model when the selected local model is no longer cached", () => {
		const update = mock<Update>(() => undefined);
		renderFallback({
			catalogLoaded: true,
			catalogModels: CATALOG,
			statesById: {
				tiny: stateEntry(100, true),
				base: stateEntry(200, false),
				large: stateEntry(900, false),
			},
			currentMainModel: "base",
			currentRealtimeModel: "tiny",
			update,
		});
		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith({ model: "tiny", backend: "onnx_asr" });
	});

	test("does NOT patch the main model when no cached local model remains", () => {
		const update = mock<Update>(() => undefined);
		renderFallback({
			catalogLoaded: true,
			catalogModels: CATALOG,
			statesById: {
				tiny: stateEntry(100, false),
				base: stateEntry(200, false),
				large: stateEntry(900, false),
			},
			currentMainModel: "base",
			currentRealtimeModel: "",
			update,
		});
		expect(update).not.toHaveBeenCalled();
	});

	test("falls back the main model to cloud when no cached local model remains and cloud is keyed", () => {
		const update = mock<Update>(() => undefined);
		renderFallback({
			catalogLoaded: true,
			catalogModels: CATALOG,
			statesById: {
				tiny: stateEntry(100, false),
				base: stateEntry(200, false),
				large: stateEntry(900, false),
			},
			currentMainModel: "base",
			currentRealtimeModel: "",
			cloudFallbackModel: "elevenlabs:scribe_v1",
			update,
		});
		expect(update).toHaveBeenCalledWith({
			model: "elevenlabs:scribe_v1",
			backend: "onnx_asr",
		});
	});

	test("falls back the main model AND patches backend together when the saved id is stale", () => {
		const update = mock<Update>(() => undefined);
		renderFallback({
			catalogLoaded: true,
			catalogModels: CATALOG,
			statesById: STATES,
			// Stale main id; realtime kept valid so only the main effect fires.
			currentMainModel: "deleted-model",
			currentRealtimeModel: "tiny",
			update,
		});
		// Smallest cached = tiny; backend MUST travel with the model patch
		// (the original drift bug wrote model-only and left backend stale).
		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith({ model: "tiny", backend: "onnx_asr" });
	});

	test("falls back the main model when the saved id is empty (corrupted settings)", () => {
		const update = mock<Update>(() => undefined);
		renderFallback({
			catalogLoaded: true,
			catalogModels: CATALOG,
			statesById: STATES,
			currentMainModel: "",
			currentRealtimeModel: "tiny",
			update,
		});
		expect(update).toHaveBeenCalledWith({ model: "tiny", backend: "onnx_asr" });
	});

	test("falls back the main model when the saved id is undefined", () => {
		const update = mock<Update>(() => undefined);
		renderFallback({
			catalogLoaded: true,
			catalogModels: CATALOG,
			statesById: STATES,
			currentMainModel: undefined,
			currentRealtimeModel: "tiny",
			update,
		});
		expect(update).toHaveBeenCalledWith({ model: "tiny", backend: "onnx_asr" });
	});

	test("does NOT patch when the resolved fallback equals the (stale-by-empty) current model", () => {
		// Catalog contains a model whose id is the empty string — a degenerate
		// catalog. currentMainModel="" needsFallback (empty) but pickDefault
		// returns "" too, so next === currentMainModel → no patch.
		const update = mock<Update>(() => undefined);
		const weirdCatalog: ModelInfo[] = [model({ id: "", backend: "onnx_asr" })];
		renderFallback({
			catalogLoaded: true,
			catalogModels: weirdCatalog,
			statesById: { "": stateEntry(1, true) },
			currentMainModel: "",
			currentRealtimeModel: "",
			update,
		});
		// next ("") === currentMainModel ("") → main effect must not patch.
		expect(update).not.toHaveBeenCalled();
	});

	test("does NOT patch the main model when no fallback entry has a backend", () => {
		// pickDefaultSttModel returns an id, but the matching catalog entry has
		// no backend → the `fallbackEntry?.backend` guard rejects the patch.
		const update = mock<Update>(() => undefined);
		const noBackend: ModelInfo[] = [
			{
				...model({ id: "tiny" }),
				backend: "" as unknown as ModelInfo["backend"],
			},
		];
		renderFallback({
			catalogLoaded: true,
			catalogModels: noBackend,
			statesById: { tiny: stateEntry(1, true) },
			currentMainModel: "stale",
			currentRealtimeModel: "",
			update,
		});
		// Main: next="tiny" !== "stale", but backend is falsy → no main patch.
		expect(update).not.toHaveBeenCalled();
	});

	test("does NOT patch main when catalog is empty (boot race → null pick)", () => {
		const update = mock<Update>(() => undefined);
		renderFallback({
			catalogLoaded: true,
			catalogModels: [],
			statesById: {},
			currentMainModel: "anything",
			currentRealtimeModel: "anything",
			update,
		});
		// pickDefaultSttModel over [] returns null → neither effect patches.
		expect(update).not.toHaveBeenCalled();
	});

	test("falls back the realtime model to the smallest native-streaming id", () => {
		const update = mock<Update>(() => undefined);
		renderFallback({
			catalogLoaded: true,
			catalogModels: CATALOG,
			statesById: STATES,
			// Main valid so it doesn't fire; realtime stale → should pick "tiny"
			// (smallest cached native-streaming model).
			currentMainModel: "large",
			currentRealtimeModel: "deleted-rt",
			update,
		});
		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith({ realtimeModel: "tiny" });
	});

	test("clears realtime instead of selecting an uncached native-streaming model", () => {
		const update = mock<Update>(() => undefined);
		renderFallback({
			catalogLoaded: true,
			catalogModels: CATALOG,
			statesById: {
				tiny: stateEntry(100, false),
				base: stateEntry(200, false),
				large: stateEntry(900, true),
			},
			currentMainModel: "large",
			currentRealtimeModel: "deleted-rt",
			update,
		});
		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith({ realtimeModel: "" });
	});

	test("clears a valid realtime model when it is not cached", () => {
		const update = mock<Update>(() => undefined);
		renderFallback({
			catalogLoaded: true,
			catalogModels: CATALOG,
			statesById: {
				tiny: stateEntry(100, false),
				base: stateEntry(200, false),
				large: stateEntry(900, true),
			},
			currentMainModel: "large",
			currentRealtimeModel: "tiny",
			update,
		});
		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith({ realtimeModel: "" });
	});

	test("does not repair realtime before model cache state has loaded", () => {
		const update = mock<Update>(() => undefined);
		renderFallback({
			catalogLoaded: true,
			catalogModels: CATALOG,
			statesById: {},
			statesLoaded: false,
			currentMainModel: "base",
			currentRealtimeModel: "tiny",
			update,
		});
		expect(update).not.toHaveBeenCalled();
	});

	test("clears a stale realtime id when only a non-streaming model could be picked", () => {
		const update = mock<Update>(() => undefined);
		// Only a non-streaming model exists.
		// needsModelFallback("stale", []) true, pickDefault(native-streaming filter)
		// over a catalog with no streaming models -> null -> no realtime patch.
		const onlyLarge: ModelInfo[] = [
			model({ id: "large", previewCapable: true, nativeStreaming: false }),
		];
		renderFallback({
			catalogLoaded: true,
			catalogModels: onlyLarge,
			statesById: { large: stateEntry(900, true) },
			currentMainModel: "large", // valid main → no main patch
			currentRealtimeModel: "stale-rt",
			update,
		});
		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith({ realtimeModel: "" });
	});

	test("leaves a valid realtime model alone", () => {
		const update = mock<Update>(() => undefined);
		renderFallback({
			catalogLoaded: true,
			catalogModels: CATALOG,
			statesById: STATES,
			currentMainModel: "base",
			currentRealtimeModel: "base", // native-streaming and present
			update,
		});
		expect(update).not.toHaveBeenCalled();
	});

	test("replaces a separate realtime model when the cached main model can stream", () => {
		const update = mock<Update>(() => undefined);
		renderFallback({
			catalogLoaded: true,
			catalogModels: CATALOG,
			statesById: STATES,
			currentMainModel: "base",
			currentRealtimeModel: "tiny",
			update,
		});
		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith({ realtimeModel: "base" });
	});

	test("falls back realtime when the saved native-streaming model has no language overlap with main", () => {
		const update = mock<Update>(() => undefined);
		const catalog: ModelInfo[] = [
			model({
				id: "main-en",
				languages: ["en"],
				previewCapable: true,
				nativeStreaming: false,
			}),
			model({
				id: "rt-ru",
				languages: ["ru"],
				previewCapable: true,
				nativeStreaming: true,
			}),
			model({
				id: "rt-en",
				languages: ["en"],
				previewCapable: true,
				nativeStreaming: true,
			}),
		];
		renderFallback({
			catalogLoaded: true,
			catalogModels: catalog,
			statesById: {
				"main-en": stateEntry(100, true),
				"rt-ru": stateEntry(50, true),
				"rt-en": stateEntry(200, true),
			},
			currentMainModel: "main-en",
			currentRealtimeModel: "rt-ru",
			update,
		});
		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith({ realtimeModel: "rt-en" });
	});

	test("clears realtime when no native-streaming model can overlap main", () => {
		const update = mock<Update>(() => undefined);
		const catalog: ModelInfo[] = [
			model({
				id: "main-en",
				languages: ["en"],
				previewCapable: true,
				nativeStreaming: false,
			}),
			model({
				id: "rt-ru",
				languages: ["ru"],
				previewCapable: true,
				nativeStreaming: true,
			}),
		];
		renderFallback({
			catalogLoaded: true,
			catalogModels: catalog,
			statesById: {
				"main-en": stateEntry(100, true),
				"rt-ru": stateEntry(50, true),
			},
			currentMainModel: "main-en",
			currentRealtimeModel: "deleted-rt",
			update,
		});
		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith({ realtimeModel: "" });
	});

	test("does NOT patch realtime when the resolved pick equals the current realtime model", () => {
		// currentRealtimeModel is empty (needs fallback) but the only realtime
		// model also has id "" → next === current → no patch.
		const update = mock<Update>(() => undefined);
		const emptyIdRealtime: ModelInfo[] = [
			model({ id: "", previewCapable: true, nativeStreaming: true }),
		];
		renderFallback({
			catalogLoaded: true,
			catalogModels: emptyIdRealtime,
			statesById: { "": stateEntry(1, true) },
			currentMainModel: "", // main effect: next "" === current "" → no patch
			currentRealtimeModel: "",
			update,
		});
		expect(update).not.toHaveBeenCalled();
	});

	test("falls back BOTH slots in one render when both are stale", () => {
		const update = mock<Update>(() => undefined);
		renderFallback({
			catalogLoaded: true,
			catalogModels: CATALOG,
			statesById: STATES,
			currentMainModel: "gone-main",
			currentRealtimeModel: "gone-rt",
			update,
		});
		expect(update).toHaveBeenCalledTimes(2);
		expect(update).toHaveBeenCalledWith({ model: "tiny", backend: "onnx_asr" });
		expect(update).toHaveBeenCalledWith({ realtimeModel: "tiny" });
	});
});
