import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { FitAssessmentEntry } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import {
	__testables,
	type PendingDownload,
	type PendingFitWarning,
} from "./use-model-swap-controller";

const t = __testables;
const AUTO_QUANTIZATION = "auto" as OnnxQuantization;

// Some helpers depend on imported sideeffect modules (ipc-client, picker,
// cloud-stt-provider). We stub the global symbol surface they reach for so
// the tests stay hermetic.
const originalConsoleError = console.error;

beforeEach(() => {
	console.error = mock(() => undefined);
});

afterEach(() => {
	console.error = originalConsoleError;
});

describe("isQuantizationChanging", () => {
	test("false when quantization is undefined", () => {
		expect(t.isQuantizationChanging(undefined, "int8")).toBe(false);
	});

	test("false when equal to current", () => {
		expect(t.isQuantizationChanging("int8", "int8")).toBe(false);
	});

	test("true when different from current", () => {
		expect(t.isQuantizationChanging("fp16", "int8")).toBe(true);
	});
});

// ``baseMainPatch`` was removed alongside the typed ``ModelPatch`` change —
// a bare ``{ model }`` patch is no longer representable, and the catalog-
// miss path is now handled by an early return in ``applyMainSwap``. See
// the new ``buildMainSwapPatch`` tests below.

describe("toQuantPatch / definedQuantPatches", () => {
	test("toQuantPatch wraps a quantization", () => {
		expect(t.toQuantPatch("fp16")).toEqual({ onnxQuantization: "fp16" });
	});

	test("definedQuantPatches yields empty for undefined", () => {
		expect(t.definedQuantPatches(undefined)).toEqual([]);
	});

	test("definedQuantPatches yields a single patch for a defined value", () => {
		expect(t.definedQuantPatches("int8")).toEqual([
			{ onnxQuantization: "int8" },
		]);
	});
});

describe("applyQuantOverride", () => {
	test("merges the quant override when changing", () => {
		const out = t.applyQuantOverride(
			{ model: "m", backend: "onnx_asr" },
			"fp16",
			true,
		);
		expect(out).toEqual({
			model: "m",
			backend: "onnx_asr",
			onnxQuantization: "fp16",
		});
	});

	test("leaves patch untouched when not changing", () => {
		const out = t.applyQuantOverride(
			{ model: "m", backend: "onnx_asr" },
			undefined,
			false,
		);
		expect(out).toEqual({ model: "m", backend: "onnx_asr" });
	});

	test("leaves patch untouched when changing flag set but value undefined", () => {
		const out = t.applyQuantOverride(
			{ model: "m", backend: "onnx_asr" },
			undefined,
			true,
		);
		expect(out).toEqual({ model: "m", backend: "onnx_asr" });
	});
});

describe("buildMainSwapPatch / buildRealtimeSwapPatch", () => {
	test("main patch composes base info and quant override", () => {
		const out = t.buildMainSwapPatch(
			"m",
			{ backend: "onnx_asr" } as never,
			"fp16",
			true,
		);
		expect(out).toEqual({
			model: "m",
			backend: "onnx_asr",
			onnxQuantization: "fp16",
		});
	});

	test("realtime patch swaps just the realtime model", () => {
		expect(t.buildRealtimeSwapPatch("rt", undefined, false)).toEqual({
			realtimeModel: "rt",
		});
	});

	test("realtime patch with quant override", () => {
		expect(t.buildRealtimeSwapPatch("rt", "int8", true)).toEqual({
			realtimeModel: "rt",
			onnxQuantization: "int8",
		});
	});
});

describe("maybeHotReload", () => {
	// These exercise the four (quantizationChanging, modelChanging) branches.
	// ``sttReloadModel`` is a fire-and-forget IPC send; in the hermetic test
	// env it no-ops, so we only assert the call doesn't throw and rely on
	// ``shouldReloadForHotSwap`` below for the branch logic.
	test("same model, quant changing → skips immediate reload (settings save owns it)", () => {
		t.maybeHotReload("main", "m", undefined, true, false);
	});

	test("model changing AND quant changing → still reloads the new model", () => {
		t.maybeHotReload("main", "new", "fp16", true, true);
	});

	test("model changing, quant unchanged → reloads", () => {
		t.maybeHotReload("main", "new", undefined, false, true);
	});

	test("same model, quant unchanged → reloads (idempotent re-pick)", () => {
		t.maybeHotReload("realtime", "m", undefined, false, false);
	});
});

describe("shouldReloadForHotSwap", () => {
	// Pure predicate behind maybeHotReload's branch — see the regression note
	// in the implementation. The only case that skips the model reload is a
	// pure same-model quant change (the Tauri settings-save path reloads after
	// persisting the new quantization).
	test("skips ONLY when quant changes and model is unchanged", () => {
		expect(t.shouldReloadForHotSwap(true, false)).toBe(false);
	});

	test("reloads when the model changes even if quant also changes", () => {
		expect(t.shouldReloadForHotSwap(true, true)).toBe(true);
	});

	test("reloads when only the model changes", () => {
		expect(t.shouldReloadForHotSwap(false, true)).toBe(true);
	});

	test("reloads on an idempotent same-model re-pick (nothing changing)", () => {
		expect(t.shouldReloadForHotSwap(false, false)).toBe(true);
	});
});

describe("needsDownloadPrompt", () => {
	test("true when state is undefined (fail-safe: prompt download)", () => {
		// Regression: previously returned false, which made the caller issue a
		// silent swap for a model whose cache state was unknown (e.g. the
		// startup list_models_with_state IPC timed out). A not-downloaded quant
		// badge then spun the swap chip instead of downloading.
		expect(t.needsDownloadPrompt(undefined, "int8")).toBe(true);
	});

	test("false when cache state is cached", () => {
		const state = {
			id: "m",
			cache: { state: "cached" },
			cache_by_quantization: {},
		} as never;
		expect(t.needsDownloadPrompt(state, "int8")).toBe(false);
	});

	test("true when cache state is missing or not_cached", () => {
		const state = {
			id: "m",
			cache: { state: "not_cached" },
			cache_by_quantization: {},
		} as never;
		expect(t.needsDownloadPrompt(state, "int8")).toBe(true);
	});
});

describe("toPresentList / mapFirstToCache / resolveTargetCache", () => {
	test("toPresentList returns empty for undefined", () => {
		expect(t.toPresentList(undefined)).toEqual([]);
	});

	test("toPresentList wraps a present state", () => {
		const state = { id: "m" } as never;
		expect(t.toPresentList(state)).toEqual([state]);
	});

	test("mapFirstToCache returns undefined for empty list", () => {
		expect(t.mapFirstToCache([], "int8")).toBeUndefined();
	});

	test("resolveTargetCache delegates through toPresentList + mapFirstToCache", () => {
		expect(t.resolveTargetCache(undefined, "int8")).toBeUndefined();
	});
});

describe("resolveTargetQuant", () => {
	test("returns the override when provided", () => {
		expect(t.resolveTargetQuant("fp16", "int8")).toBe("fp16");
	});

	test("falls back to current when override is undefined", () => {
		expect(t.resolveTargetQuant(undefined, "int8")).toBe("int8");
	});

	test("re-resolves the auto sentinel to the server's effective precision", () => {
		// canary on "auto" loads int8 on the server; the cache check must target
		// int8, not the user's nominal selection.
		const state = { id: "m", effective_quantization: "int8" } as never;
		expect(t.resolveTargetQuant(undefined, AUTO_QUANTIZATION, state)).toBe(
			"int8",
		);
	});

	test("honors a concrete pick (incl fp32) over the auto-effective precision", () => {
		const state = { id: "m", effective_quantization: "int8" } as never;
		expect(t.resolveTargetQuant("fp16", AUTO_QUANTIZATION, state)).toBe(
			"fp16",
		);
		// "" is EXPLICIT fp32 now — a concrete pick, not re-resolved to int8.
		expect(t.resolveTargetQuant("", AUTO_QUANTIZATION, state)).toBe("");
	});
});

describe("isSwapBlockedByDownload", () => {
	const states = { m: { id: "m", effective_quantization: "int8" } } as never;

	test("blocks a row-select when the model's effective precision is downloading", () => {
		// Row select on auto → quantization undefined, currentQuantization "auto" →
		// effective int8. int8 is downloading, so switching to it must be refused.
		const dl = (id: string, q: string) => id === "m" && q === "int8";
		expect(
			t.isSwapBlockedByDownload(
				"m",
				undefined,
				AUTO_QUANTIZATION,
				states,
				dl,
			),
		).toBe(true);
	});

	test("allows switching to a cached precision while a DIFFERENT precision downloads", () => {
		// fp16 is cached + explicitly picked; only int8 is downloading → allow.
		const dl = (id: string, q: string) => id === "m" && q === "int8";
		expect(t.isSwapBlockedByDownload("m", "fp16", "", states, dl)).toBe(false);
	});

	test("blocks an explicit precision-badge pick that is downloading", () => {
		const dl = (id: string, q: string) => id === "m" && q === "int8";
		expect(t.isSwapBlockedByDownload("m", "int8", "", states, dl)).toBe(true);
	});

	test("never blocks when nothing is downloading", () => {
		expect(
			t.isSwapBlockedByDownload("m", undefined, "", states, () => false),
		).toBe(false);
	});
});

describe("isCriticalAssessment", () => {
	test("false when assessment is missing", () => {
		expect(t.isCriticalAssessment(null)).toBe(false);
		expect(t.isCriticalAssessment(undefined)).toBe(false);
	});

	test("false when severity is not critical", () => {
		const a = { severity: "warning" } as FitAssessmentEntry;
		expect(t.isCriticalAssessment(a)).toBe(false);
	});

	test("true when severity is critical", () => {
		const a = { severity: "critical" } as FitAssessmentEntry;
		expect(t.isCriticalAssessment(a)).toBe(true);
	});
});

describe("resolveCandidateName", () => {
	test("returns the displayName from the catalog", () => {
		const get = mock(() => ({ displayName: "Pretty" })) as never;
		expect(t.resolveCandidateName(get, "m")).toBe("Pretty");
	});

	test("falls back to the raw id when the catalog has no entry", () => {
		const get = mock(() => undefined) as never;
		expect(t.resolveCandidateName(get, "raw-id")).toBe("raw-id");
	});
});

describe("resolveCurrentMainModel / resolveCurrentRealtimeModel", () => {
	test("main reads from settings when defined", () => {
		const s = { model: "x" } as never;
		expect(t.resolveCurrentMainModel(s, "fallback")).toBe("x");
	});

	test("main falls back to selected when settings is undefined", () => {
		expect(t.resolveCurrentMainModel(undefined, "fallback")).toBe("fallback");
	});

	test("realtime reads from settings when defined", () => {
		const s = { realtimeModel: "rt" } as never;
		expect(t.resolveCurrentRealtimeModel(s)).toBe("rt");
	});

	test("realtime returns empty string when missing", () => {
		expect(t.resolveCurrentRealtimeModel(undefined)).toBe("");
	});
});

describe("isCloudModel", () => {
	test("true for openrouter:... ids", () => {
		expect(t.isCloudModel("openrouter:openai/whisper-1")).toBe(true);
	});

	test("false for plain local ids", () => {
		expect(t.isCloudModel("whisper-tiny")).toBe(false);
	});
});

describe("applyPureQuantSwap", () => {
	test("applies the override patch when quantization is changing", () => {
		const update = mock(() => undefined);
		t.applyPureQuantSwap(true, "int8", update as never);
		expect((update.mock.calls as unknown[][])[0]?.[0]).toEqual({
			onnxQuantization: "int8",
		});
	});

	test("does nothing when quantization is not changing", () => {
		const update = mock(() => undefined);
		t.applyPureQuantSwap(false, "int8", update as never);
		expect(update).not.toHaveBeenCalled();
	});

	test("does nothing when quantization value is undefined", () => {
		const update = mock(() => undefined);
		t.applyPureQuantSwap(true, undefined, update as never);
		expect(update).not.toHaveBeenCalled();
	});
});

describe("dispatchChange / dispatchGate", () => {
	test("dispatchChange routes cloud ids to issueSwap directly", () => {
		const issueSwap = mock(() => undefined);
		const gate = mock(() => Promise.resolve());
		t.dispatchChange({
			currentModel: "prev",
			currentQuantization: "int8",
			gateWithAssessment: gate as never,
			issueSwap: issueSwap as never,
			kind: "main",
			quantization: undefined,
			update: mock(() => undefined) as never,
			value: "openrouter:openai/whisper-1",
		});
		expect(issueSwap).toHaveBeenCalled();
		expect(gate).not.toHaveBeenCalled();
	});

	test("dispatchChange routes local ids through the gate", () => {
		const issueSwap = mock(() => undefined);
		const gate = mock(() => Promise.resolve());
		t.dispatchChange({
			currentModel: "prev",
			currentQuantization: "int8",
			gateWithAssessment: gate as never,
			issueSwap: issueSwap as never,
			kind: "main",
			quantization: undefined,
			update: mock(() => undefined) as never,
			value: "whisper-tiny",
		});
		expect(gate).toHaveBeenCalled();
		expect(issueSwap).not.toHaveBeenCalled();
	});

	test("dispatchGate forwards rejections to the error reporter", async () => {
		const failing = mock(() => Promise.reject(new Error("boom")));
		t.dispatchGate({
			currentModel: "prev",
			currentQuantization: "int8",
			gateWithAssessment: failing as never,
			issueSwap: mock(() => undefined) as never,
			kind: "main",
			quantization: undefined,
			update: mock(() => undefined) as never,
			value: "whisper-tiny",
		});
		await new Promise((r) => setTimeout(r, 5));
		expect(console.error).toHaveBeenCalled();
	});
});

describe("runIssueSwap — cloud persistence (regression: cloud combo showed no model)", () => {
	const cloudArgs = (value: string) => ({
		kind: "main" as const,
		value,
		previous: "tiny",
		quantization: undefined,
		currentQuantization: "int8" as OnnxQuantization,
		// Cloud ids are never in the catalog, so getModel returns undefined.
		getModel: (() => undefined) as never,
		prevMainModelRef: { current: null as string | null } as never,
		prevRealtimeModelRef: { current: null as string | null } as never,
	});

	test("persists a cloud model despite the empty catalog lookup", () => {
		const update = mock(() => undefined);
		t.runIssueSwap({
			...cloudArgs("openrouter:openai/gpt-4o-mini-transcribe"),
			update: update as never,
		});
		// Without the fix `applyMainSwap` bailed on `!info` and never called
		// update, leaving model.model unchanged → the cloud combo stayed empty.
		expect(update).toHaveBeenCalledWith({
			model: "openrouter:openai/gpt-4o-mini-transcribe",
			backend: "onnx_asr",
		});
	});

	test("still bails for a genuinely-missing LOCAL id (no invalid patch)", () => {
		const update = mock(() => undefined);
		t.runIssueSwap({
			...cloudArgs("nonexistent-local-id"),
			update: update as never,
		});
		expect(update).not.toHaveBeenCalled();
	});
});

describe("runHandleMainChange / runHandleRealtimeChange", () => {
	test("pure quant swap routes through the gate so the cache check + download dialog can fire", () => {
		// Old behavior wrote settings.onnxQuantization synchronously via update,
		// skipping the cache check. That triggered a reload with an uncached
		// quant, the load failed, and the picker rolled back — the
		// "default-quant revert" symptom on Cohere/DirectML. The fix routes
		// pure-quant swaps through dispatchChange / gateWithAssessment just
		// like a model swap, so the dialog can offer a Download before the
		// reload path is allowed to run with files that aren't on disk.
		const update = mock(() => undefined);
		const gateWithAssessment = mock(() => Promise.resolve());
		t.runHandleMainChange({
			currentModel: "m",
			currentQuantization: "int8",
			gateWithAssessment: gateWithAssessment as never,
			issueSwap: mock(() => undefined) as never,
			kind: "main",
			quantization: "fp16",
			update: update as never,
			value: "m",
		});
		expect(gateWithAssessment).toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	test("no-op short-circuit when neither model nor quant changed", () => {
		// Same model + same quant must not round-trip the gate. The picker
		// re-fires onChange in a few benign cases (re-mount, ItemIndicator
		// reflow) and we don't want those triggering a model reload.
		const update = mock(() => undefined);
		const gateWithAssessment = mock(() => Promise.resolve());
		const issueSwap = mock(() => undefined);
		t.runHandleMainChange({
			currentModel: "m",
			currentQuantization: "int8",
			gateWithAssessment: gateWithAssessment as never,
			issueSwap: issueSwap as never,
			kind: "main",
			quantization: "int8",
			update: update as never,
			value: "m",
		});
		expect(gateWithAssessment).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
		expect(issueSwap).not.toHaveBeenCalled();
	});

	test("dispatches when value changes", () => {
		const issueSwap = mock(() => undefined);
		t.runHandleMainChange({
			currentModel: "prev",
			currentQuantization: "int8",
			gateWithAssessment: mock(() => Promise.resolve()) as never,
			issueSwap: issueSwap as never,
			kind: "main",
			quantization: undefined,
			update: mock(() => undefined) as never,
			value: "openrouter:openai/whisper-1",
		});
		expect(issueSwap).toHaveBeenCalled();
	});

	test("realtime path mirrors main path", () => {
		const update = mock(() => undefined);
		const gateWithAssessment = mock(() => Promise.resolve());
		t.runHandleRealtimeChange({
			currentModel: "rt",
			currentQuantization: "int8",
			gateWithAssessment: gateWithAssessment as never,
			issueSwap: mock(() => undefined) as never,
			kind: "realtime",
			quantization: "fp16",
			update: update as never,
			value: "rt",
		});
		expect(gateWithAssessment).toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});
});

describe("runIssueSwap", () => {
	test("main: updates settings with the new model AND backend from the catalog", () => {
		const update = mock(() => undefined);
		const refMain = { current: null as string | null };
		const refRt = { current: null as string | null };
		t.runIssueSwap({
			currentQuantization: "int8",
			getModel: ((id: string) =>
				id === "next"
					? ({ backend: "onnx_asr" } as never)
					: undefined) as never,
			kind: "main",
			previous: "prev",
			prevMainModelRef: refMain as never,
			prevRealtimeModelRef: refRt as never,
			quantization: undefined,
			update: update as never,
			value: "next",
		});
		expect(update).toHaveBeenCalledWith({ model: "next", backend: "onnx_asr" });
		expect(refMain.current).toBe("prev");
	});

	test("main: clears saved realtime model when languages no longer overlap", () => {
		const update = mock(() => undefined);
		const refMain = { current: null as string | null };
		const refRt = { current: null as string | null };
		t.runIssueSwap({
			currentQuantization: "int8",
			currentRealtimeModel: "rt-ru",
			getModel: ((id: string) => {
				if (id === "next-en") {
					return { backend: "onnx_asr", languages: ["en"] } as never;
				}
				if (id === "rt-ru") {
					return {
						backend: "onnx_asr",
						id,
						languages: ["ru"],
						nativeStreaming: true,
					} as never;
				}
				return undefined;
			}) as never,
			kind: "main",
			previous: "prev",
			prevMainModelRef: refMain as never,
			prevRealtimeModelRef: refRt as never,
			quantization: undefined,
			update: update as never,
			value: "next-en",
		});
		expect(update).toHaveBeenCalledWith({
			model: "next-en",
			backend: "onnx_asr",
			realtimeModel: "",
		});
		expect(refMain.current).toBe("prev");
	});

	test("main: preserves saved realtime model when languages overlap", () => {
		const update = mock(() => undefined);
		const refMain = { current: null as string | null };
		const refRt = { current: null as string | null };
		t.runIssueSwap({
			currentQuantization: "int8",
			currentRealtimeModel: "rt-en",
			getModel: ((id: string) => {
				if (id === "next-en") {
					return { backend: "onnx_asr", languages: ["en"] } as never;
				}
				if (id === "rt-en") {
					return {
						backend: "onnx_asr",
						id,
						languages: ["en", "de"],
						nativeStreaming: true,
					} as never;
				}
				return undefined;
			}) as never,
			kind: "main",
			previous: "prev",
			prevMainModelRef: refMain as never,
			prevRealtimeModelRef: refRt as never,
			quantization: undefined,
			update: update as never,
			value: "next-en",
		});
		expect(update).toHaveBeenCalledWith({
			model: "next-en",
			backend: "onnx_asr",
		});
		expect(refMain.current).toBe("prev");
	});

	test("main: native-streaming target owns the realtime slot", () => {
		const update = mock(() => undefined);
		const refMain = { current: null as string | null };
		const refRt = { current: null as string | null };
		t.runIssueSwap({
			currentQuantization: "int8",
			currentRealtimeModel: "rt-en",
			getModel: ((id: string) => {
				if (id === "streaming-zipformer-en") {
					return {
						backend: "onnx_asr",
						id,
						languages: ["en"],
						nativeStreaming: true,
					} as never;
				}
				if (id === "rt-en") {
					return {
						backend: "onnx_asr",
						id,
						languages: ["en"],
						nativeStreaming: true,
					} as never;
				}
				return undefined;
			}) as never,
			kind: "main",
			previous: "prev",
			prevMainModelRef: refMain as never,
			prevRealtimeModelRef: refRt as never,
			quantization: undefined,
			update: update as never,
			value: "streaming-zipformer-en",
		});
		expect(update).toHaveBeenCalledWith({
			model: "streaming-zipformer-en",
			backend: "onnx_asr",
			realtimeModel: "streaming-zipformer-en",
		});
		expect(refMain.current).toBe("prev");
	});

	test("main: short-circuits when catalog does not know the target model", () => {
		// Regression guard: writing { model: x } without a paired backend was the
		// drift that produced model=canary, backend=faster_whisper on disk. The
		// typed ModelPatch now forbids it; applyMainSwap must early-return so we
		// never write an inconsistent pair.
		const update = mock(() => undefined);
		const refMain = { current: null as string | null };
		const refRt = { current: null as string | null };
		t.runIssueSwap({
			currentQuantization: "int8",
			getModel: ((_id: string) => undefined) as never,
			kind: "main",
			previous: "prev",
			prevMainModelRef: refMain as never,
			prevRealtimeModelRef: refRt as never,
			quantization: undefined,
			update: update as never,
			value: "missing-from-catalog",
		});
		expect(update).not.toHaveBeenCalled();
		expect(refMain.current).toBeNull();
	});

	test("realtime: updates realtime model", () => {
		const update = mock(() => undefined);
		const refMain = { current: null as string | null };
		const refRt = { current: null as string | null };
		t.runIssueSwap({
			currentQuantization: "int8",
			getModel: ((id: string) =>
				id === "rt-next"
					? ({
							backend: "onnx_asr",
							id,
							languages: ["en"],
							nativeStreaming: true,
						} as never)
					: undefined) as never,
			kind: "realtime",
			previous: "prev-rt",
			prevMainModelRef: refMain as never,
			prevRealtimeModelRef: refRt as never,
			quantization: undefined,
			update: update as never,
			value: "rt-next",
		});
		expect(update).toHaveBeenCalledWith({ realtimeModel: "rt-next" });
		expect(refRt.current).toBe("prev-rt");
	});

	test("realtime: refuses a model whose languages do not overlap the current main model", () => {
		const update = mock(() => undefined);
		const refMain = { current: null as string | null };
		const refRt = { current: null as string | null };
		t.runIssueSwap({
			currentMainModel: "main-en",
			currentQuantization: "int8",
			getModel: ((id: string) => {
				if (id === "main-en") {
					return { backend: "onnx_asr", languages: ["en"] } as never;
				}
				if (id === "rt-ru") {
					return {
						backend: "onnx_asr",
						id,
						languages: ["ru"],
						nativeStreaming: true,
					} as never;
				}
				return undefined;
			}) as never,
			kind: "realtime",
			previous: "prev-rt",
			prevMainModelRef: refMain as never,
			prevRealtimeModelRef: refRt as never,
			quantization: undefined,
			update: update as never,
			value: "rt-ru",
		});
		expect(update).not.toHaveBeenCalled();
		expect(refRt.current).toBeNull();
	});

	test("realtime: refuses a different model when current main is native streaming", () => {
		const update = mock(() => undefined);
		const refMain = { current: null as string | null };
		const refRt = { current: null as string | null };
		t.runIssueSwap({
			currentMainModel: "streaming-zipformer-en",
			currentQuantization: "int8",
			getModel: ((id: string) => {
				if (id === "streaming-zipformer-en") {
					return {
						backend: "onnx_asr",
						id,
						languages: ["en"],
						nativeStreaming: true,
					} as never;
				}
				if (id === "streaming-nemo-rnnt-en-1040ms-int8") {
					return {
						backend: "onnx_asr",
						id,
						languages: ["en"],
						nativeStreaming: true,
					} as never;
				}
				return undefined;
			}) as never,
			kind: "realtime",
			previous: "streaming-zipformer-en",
			prevMainModelRef: refMain as never,
			prevRealtimeModelRef: refRt as never,
			quantization: undefined,
			update: update as never,
			value: "streaming-nemo-rnnt-en-1040ms-int8",
		});
		expect(update).not.toHaveBeenCalled();
		expect(refRt.current).toBeNull();
	});

	test("realtime: refuses a non-canonical duplicated streaming export", () => {
		const update = mock(() => undefined);
		const refMain = { current: null as string | null };
		const refRt = { current: null as string | null };
		t.runIssueSwap({
			currentQuantization: "int8",
			getModel: ((id: string) =>
				id === "streaming-parakeet-unified-en-240ms-int8"
					? ({
							backend: "onnx_asr",
							id,
							languages: ["en"],
							nativeStreaming: true,
						} as never)
					: undefined) as never,
			kind: "realtime",
			previous: "prev-rt",
			prevMainModelRef: refMain as never,
			prevRealtimeModelRef: refRt as never,
			quantization: undefined,
			update: update as never,
			value: "streaming-parakeet-unified-en-240ms-int8",
		});
		expect(update).not.toHaveBeenCalled();
		expect(refRt.current).toBeNull();
	});
});

describe("runProceedWithSelection", () => {
	test("prompts download when target precision is missing", () => {
		const setPending = mock(() => undefined);
		const issueSwap = mock(() => undefined);
		const states = {
			m: {
				id: "m",
				cache: { state: "not_cached" },
				cache_by_quantization: {},
			},
		} as never;
		t.runProceedWithSelection({
			currentQuantization: "int8",
			issueSwap: issueSwap as never,
			kind: "main",
			previous: "prev",
			quantization: undefined,
			setPendingDownload: setPending as never,
			statesById: states,
			value: "m",
		});
		expect(setPending).toHaveBeenCalled();
		expect(issueSwap).not.toHaveBeenCalled();
	});

	test("issues a swap when target precision is already cached", () => {
		const setPending = mock(() => undefined);
		const issueSwap = mock(() => undefined);
		const states = {
			m: {
				id: "m",
				cache: { state: "cached" },
				cache_by_quantization: {},
			},
		} as never;
		t.runProceedWithSelection({
			currentQuantization: "int8",
			issueSwap: issueSwap as never,
			kind: "main",
			previous: "prev",
			quantization: undefined,
			setPendingDownload: setPending as never,
			statesById: states,
			value: "m",
		});
		expect(issueSwap).toHaveBeenCalled();
		expect(setPending).not.toHaveBeenCalled();
	});

	test("prompts download when the effective precision is missing even though the default export is cached", () => {
		// The canary-1b-flash repro: user on "auto", the fp32 export ("") is on
		// disk (cached), but the server loads int8 — which is NOT on disk. Pre-fix
		// this issued a silent swap (no prompt) and the server background-downloaded
		// int8. It must now prompt the download.
		const setPending = mock(() => undefined);
		const issueSwap = mock(() => undefined);
		const states = {
			m: {
				id: "m",
				effective_quantization: "int8",
				cache: { state: "cached" },
				cache_by_quantization: {
					"": { state: "cached" },
					int8: { state: "not_cached" },
				},
			},
		} as never;
		t.runProceedWithSelection({
			currentQuantization: AUTO_QUANTIZATION,
			issueSwap: issueSwap as never,
			kind: "main",
			previous: "prev",
			quantization: undefined,
			setPendingDownload: setPending as never,
			statesById: states,
			value: "m",
		});
		expect(setPending).toHaveBeenCalled();
		expect(issueSwap).not.toHaveBeenCalled();
	});
});

describe("promptDownload / surfaceFitWarning", () => {
	test("promptDownload forwards the candidate metadata", () => {
		const setPending = mock(() => undefined);
		t.promptDownload({
			currentQuantization: "int8",
			issueSwap: mock(() => undefined) as never,
			kind: "main",
			previous: "prev",
			quantization: "fp16",
			setPendingDownload: setPending as never,
			statesById: {} as never,
			value: "m",
		});
		expect(setPending).toHaveBeenCalledWith({
			kind: "main",
			modelId: "m",
			previousModelId: "prev",
			quantization: "fp16",
		});
	});

	test("surfaceFitWarning packages the next-callback", () => {
		const setFit = mock((_v: PendingFitWarning | null) => undefined);
		const proceed = mock(() => undefined);
		t.surfaceFitWarning(
			{
				assessDictationFitOnServer: mock(() => Promise.resolve(null)) as never,
				currentQuantization: "int8",
				deviceValue: "auto",
				getModel: ((_id: string) => undefined) as never,
				kind: "main",
				previous: "prev",
				proceed: proceed as never,
				quantization: undefined,
				setPendingFitWarning: setFit as never,
				statesById: {} as never,
				value: "m",
			},
			{ severity: "critical" } as FitAssessmentEntry,
			"Pretty",
		);
		expect(setFit).toHaveBeenCalledTimes(1);
		const call = setFit.mock.calls[0]?.[0] as PendingFitWarning | undefined;
		expect(call?.candidateName).toBe("Pretty");
		call?.next();
		expect(proceed).toHaveBeenCalled();
	});
});

describe("runConfirmPendingDownload", () => {
	test("does nothing when there is no pending download", () => {
		const issueSwap = mock(() => undefined);
		t.runConfirmPendingDownload(null, issueSwap as never);
		expect(issueSwap).not.toHaveBeenCalled();
	});

	test("forwards the pending download to issueSwap", () => {
		const issueSwap = mock(() => undefined);
		const pending: PendingDownload = {
			kind: "main",
			modelId: "m",
			previousModelId: "prev",
			quantization: "fp16",
		};
		t.runConfirmPendingDownload(pending, issueSwap as never);
		expect(issueSwap).toHaveBeenCalledWith("main", "m", "prev", "fp16");
	});
});

describe("toIssueSwapInvoker", () => {
	test("produces a thunk that calls issueSwap with the unpacked fields", () => {
		const issueSwap = mock(() => undefined);
		const thunk = t.toIssueSwapInvoker(issueSwap as never)({
			kind: "realtime",
			modelId: "rt",
			previousModelId: "prev",
			quantization: undefined,
		} as PendingDownload);
		thunk();
		expect(issueSwap).toHaveBeenCalledWith("realtime", "rt", "prev", undefined);
	});
});

describe("handleDownloadCompleteEvent / closePendingDownloadFor / clearIfMatches", () => {
	test("does nothing when the download was cancelled", () => {
		const setPending = mock(() => undefined);
		t.handleDownloadCompleteEvent("m", true, setPending as never);
		expect(setPending).not.toHaveBeenCalled();
	});

	test("clears the pending download when the model matches", () => {
		const setPending = mock(() => undefined);
		t.handleDownloadCompleteEvent("m", false, setPending as never);
		expect(setPending).toHaveBeenCalled();
	});

	test("clearIfMatches returns null when the modelId matches", () => {
		const pending: PendingDownload = {
			kind: "main",
			modelId: "m",
			previousModelId: "prev",
		};
		expect(t.clearIfMatches(pending, "m")).toBeNull();
	});

	test("clearIfMatches keeps the pending download when the id is different", () => {
		const pending: PendingDownload = {
			kind: "main",
			modelId: "m",
			previousModelId: "prev",
		};
		expect(t.clearIfMatches(pending, "other")).toBe(pending);
	});

	test("matchesPending returns false when current is null", () => {
		expect(t.matchesPending(null, "m")).toBe(false);
	});
});

describe("handleSwapFailedEvent / rollbackMain / rollbackRealtime", () => {
	const fakeGetModel = (id: string) =>
		id === "prev-main" ? ({ backend: "onnx_asr" } as never) : undefined;

	test("main rollback uses the captured main ref and resolves backend from the catalog", () => {
		const update = mock(() => undefined);
		const refMain = { current: "prev-main" };
		const refRt = { current: null as string | null };
		t.handleSwapFailedEvent(
			"main",
			"unknown",
			refMain as never,
			refRt as never,
			update as never,
			fakeGetModel as never,
		);
		expect((update.mock.calls as unknown[][])[0]?.[0]).toEqual({
			model: "prev-main",
			backend: "onnx_asr",
		});
	});

	test("realtime rollback uses the captured realtime ref", () => {
		const update = mock(() => undefined);
		const refMain = { current: null as string | null };
		const refRt = { current: "prev-rt" };
		t.handleSwapFailedEvent(
			"realtime",
			"unknown",
			refMain as never,
			refRt as never,
			update as never,
			fakeGetModel as never,
		);
		expect((update.mock.calls as unknown[][])[0]?.[0]).toEqual({
			realtimeModel: "prev-rt",
		});
	});

	test("superseded failure does NOT roll back (the winning swap owns the model)", () => {
		// Regression: a redundant onnx_quantization reload that got superseded
		// must not revert the picker off the model the winning swap committed.
		const update = mock(() => undefined);
		t.handleSwapFailedEvent(
			"main",
			"superseded",
			{ current: "prev-main" } as never,
			{ current: null } as never,
			update as never,
			fakeGetModel as never,
		);
		expect(update).not.toHaveBeenCalled();
	});

	test("cancelled failure does NOT roll back (user already owns the intent)", () => {
		const update = mock(() => undefined);
		t.handleSwapFailedEvent(
			"main",
			"cancelled",
			{ current: "prev-main" } as never,
			{ current: null } as never,
			update as never,
			fakeGetModel as never,
		);
		expect(update).not.toHaveBeenCalled();
	});

	test("rollbackMain is a no-op when no previous is captured", () => {
		const update = mock(() => undefined);
		t.rollbackMain(
			{ current: null } as never,
			update as never,
			fakeGetModel as never,
		);
		expect(update).not.toHaveBeenCalled();
	});

	test("rollbackRealtime is a no-op when no previous is captured", () => {
		const update = mock(() => undefined);
		t.rollbackRealtime({ current: null } as never, update as never);
		expect(update).not.toHaveBeenCalled();
	});
});

describe("reportSwapGateError", () => {
	test("logs to console.error and never throws", () => {
		expect(() => t.reportSwapGateError(new Error("nope"))).not.toThrow();
		expect(console.error).toHaveBeenCalled();
	});
});

describe("runGateWithAssessment", () => {
	test("critical assessment surfaces the fit warning and does not proceed", async () => {
		const setFit = mock((_v: PendingFitWarning | null) => undefined);
		const proceed = mock(() => undefined);
		const assess = mock(() =>
			Promise.resolve({ severity: "critical" } as FitAssessmentEntry),
		);
		await t.runGateWithAssessment({
			assessDictationFitOnServer: assess as never,
			currentQuantization: "int8",
			deviceValue: "auto",
			getModel: ((_id: string) => ({ displayName: "Pretty Model" })) as never,
			kind: "main",
			previous: "prev",
			proceed: proceed as never,
			quantization: undefined,
			setPendingFitWarning: setFit as never,
			statesById: {} as never,
			value: "candidate",
		});
		expect(assess).toHaveBeenCalledWith("candidate", "int8", "auto");
		expect(setFit).toHaveBeenCalledTimes(1);
		expect(proceed).not.toHaveBeenCalled();
		const warning = setFit.mock.calls[0]?.[0] as PendingFitWarning | undefined;
		expect(warning?.candidateName).toBe("Pretty Model");
		expect(warning?.assessment).toEqual({
			severity: "critical",
		} as FitAssessmentEntry);
		// next-callback bridges back to proceed once the user confirms.
		warning?.next();
		expect(proceed).toHaveBeenCalledWith(
			"main",
			"candidate",
			"prev",
			undefined,
		);
	});

	test("non-critical assessment proceeds with the swap without surfacing a warning", async () => {
		const setFit = mock((_v: PendingFitWarning | null) => undefined);
		const proceed = mock(() => undefined);
		const assess = mock(() =>
			Promise.resolve({ severity: "warning" } as FitAssessmentEntry),
		);
		await t.runGateWithAssessment({
			assessDictationFitOnServer: assess as never,
			currentQuantization: "int8",
			deviceValue: "cpu",
			getModel: ((_id: string) => undefined) as never,
			kind: "realtime",
			previous: "prev-rt",
			proceed: proceed as never,
			quantization: "fp16",
			setPendingFitWarning: setFit as never,
			statesById: {} as never,
			value: "next-rt",
		});
		// quantization override flows through to the assessor.
		expect(assess).toHaveBeenCalledWith("next-rt", "fp16", "cpu");
		expect(setFit).not.toHaveBeenCalled();
		expect(proceed).toHaveBeenCalledWith(
			"realtime",
			"next-rt",
			"prev-rt",
			"fp16",
		);
	});

	test("null/undefined assessment falls through to the proceed branch", async () => {
		const setFit = mock((_v: PendingFitWarning | null) => undefined);
		const proceed = mock(() => undefined);
		const assess = mock(() => Promise.resolve(null));
		await t.runGateWithAssessment({
			assessDictationFitOnServer: assess as never,
			currentQuantization: "int8",
			deviceValue: "auto",
			getModel: ((_id: string) => undefined) as never,
			kind: "main",
			previous: "prev",
			proceed: proceed as never,
			quantization: undefined,
			setPendingFitWarning: setFit as never,
			statesById: {} as never,
			value: "m",
		});
		expect(setFit).not.toHaveBeenCalled();
		expect(proceed).toHaveBeenCalledWith("main", "m", "prev", undefined);
	});
});

// Compile-time sanity: confirm the public type surface still resolves.
test("OnnxQuantization type still resolves", () => {
	const q: OnnxQuantization = "int8";
	expect(q).toBe("int8");
});
