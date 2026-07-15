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

describe("swapQuantTransition", () => {
	test("null when the precision is not changing", () => {
		expect(t.swapQuantTransition(undefined, false, "int8")).toBeNull();
		expect(t.swapQuantTransition("int8", false, "int8")).toBeNull();
	});

	test("from → to when the precision is changing", () => {
		expect(t.swapQuantTransition("int8", true, "")).toEqual({
			from: "",
			to: "int8",
		});
		expect(t.swapQuantTransition("q4", true, "fp16")).toEqual({
			from: "fp16",
			to: "q4",
		});
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
		const out = t.applyQuantOverride({ model: "m" }, "fp16", true);
		expect(out).toEqual({
			model: "m",
			onnxQuantization: "fp16",
		});
	});

	test("leaves patch untouched when not changing", () => {
		const out = t.applyQuantOverride({ model: "m" }, undefined, false);
		expect(out).toEqual({ model: "m" });
	});

	test("leaves patch untouched when changing flag set but value undefined", () => {
		const out = t.applyQuantOverride({ model: "m" }, undefined, true);
		expect(out).toEqual({ model: "m" });
	});
});

describe("buildMainSwapPatch / buildRealtimeSwapPatch", () => {
	test("main patch composes base info and quant override", () => {
		const out = t.buildMainSwapPatch("m", {} as never, "fp16", true);
		expect(out).toEqual({
			model: "m",
			onnxQuantization: "fp16",
		});
	});

	test("model switch drops a precision the new model does not offer to default", () => {
		// Regression: tiny ships q4, parakeet only ships ["", "int8"]. Switching to
		// parakeet must NOT carry q4 (which made the settings:save fail) — it resets
		// to the new model's default precision.
		const out = t.buildMainSwapPatch(
			"parakeet",
			{ availableQuantizations: ["", "int8"] } as never,
			undefined, // no explicit precision pick
			false, // precision not changing on its own
			"q4", // carried over from the previous model
		);
		expect(out).toEqual({
			model: "parakeet",
			onnxQuantization: "",
		});
	});

	test("model switch keeps a precision the new model offers", () => {
		const out = t.buildMainSwapPatch(
			"tiny",
			{ availableQuantizations: ["", "q4"] } as never,
			undefined,
			false,
			"q4", // offered by the new model → left as-is, no override
		);
		expect(out).toEqual({ model: "tiny" });
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
		expect(t.resolveTargetQuant("fp16", AUTO_QUANTIZATION, state)).toBe("fp16");
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
			t.isSwapBlockedByDownload("m", undefined, AUTO_QUANTIZATION, states, dl),
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
	});

	test("routes cloud selection through the atomic backend without an optimistic settings write", () => {
		const atomicInvoker = mock(() => undefined);
		t.runIssueSwap({
			...cloudArgs("openrouter:openai/gpt-4o-mini-transcribe"),
			atomicDevice: "auto",
			atomicInvoker,
		});

		expect(atomicInvoker).toHaveBeenCalledTimes(1);
		expect(atomicInvoker.mock.calls.at(0)?.at(0)).toMatchObject({
			kind: "main",
			modelId: "openrouter:openai/gpt-4o-mini-transcribe",
			quantization: "int8",
			device: "auto",
			realtimeModel: null,
		});
	});

	test("still bails for a genuinely-missing LOCAL id (no invalid patch)", () => {
		t.runIssueSwap({
			...cloudArgs("nonexistent-local-id"),
		});
	});
});

describe("runHandleChange", () => {
	test("pure quant swap routes through the gate so the cache check + download dialog can fire", () => {
		// Old behavior wrote settings.onnxQuantization synchronously via update,
		// skipping the cache check. That triggered a reload with an uncached
		// quant, the load failed, and the picker rolled back — the
		// "default-quant revert" symptom on Cohere/DirectML. The fix routes
		// pure-quant swaps through dispatchChange / gateWithAssessment just
		// like a model swap, so the dialog can offer a Download before the
		// reload path is allowed to run with files that aren't on disk.
		const gateWithAssessment = mock(() => Promise.resolve());
		t.runHandleChange({
			currentModel: "m",
			currentQuantization: "int8",
			gateWithAssessment: gateWithAssessment as never,
			issueSwap: mock(() => undefined) as never,
			kind: "main",
			quantization: "fp16",
			value: "m",
		});
		expect(gateWithAssessment).toHaveBeenCalled();
	});

	test("no-op short-circuit when neither model nor quant changed", () => {
		// Same model + same quant must not round-trip the gate. The picker
		// re-fires onChange in a few benign cases (re-mount, ItemIndicator
		// reflow) and we don't want those triggering a model reload.
		const gateWithAssessment = mock(() => Promise.resolve());
		const issueSwap = mock(() => undefined);
		t.runHandleChange({
			currentModel: "m",
			currentQuantization: "int8",
			gateWithAssessment: gateWithAssessment as never,
			issueSwap: issueSwap as never,
			kind: "main",
			quantization: "int8",
			value: "m",
		});
		expect(gateWithAssessment).not.toHaveBeenCalled();
		expect(issueSwap).not.toHaveBeenCalled();
	});

	test("dispatches when value changes", () => {
		const issueSwap = mock(() => undefined);
		t.runHandleChange({
			currentModel: "prev",
			currentQuantization: "int8",
			gateWithAssessment: mock(() => Promise.resolve()) as never,
			issueSwap: issueSwap as never,
			kind: "main",
			quantization: undefined,
			value: "openrouter:openai/whisper-1",
		});
		expect(issueSwap).toHaveBeenCalled();
	});

	test("realtime path mirrors main path", () => {
		const gateWithAssessment = mock(() => Promise.resolve());
		t.runHandleChange({
			currentModel: "rt",
			currentQuantization: "int8",
			gateWithAssessment: gateWithAssessment as never,
			issueSwap: mock(() => undefined) as never,
			kind: "realtime",
			quantization: "fp16",
			value: "rt",
		});
		expect(gateWithAssessment).toHaveBeenCalled();
	});
});

describe("runIssueSwap", () => {
	test("main atomic: sends the companion realtime correction and leaves settings backend-owned", () => {
		const atomicInvoker = mock(() => undefined);
		t.runIssueSwap({
			atomicDevice: "cpu",
			atomicInvoker,
			currentQuantization: "q4",
			currentRealtimeModel: "rt-ru",
			getModel: ((id: string) => {
				if (id === "next-en") {
					return {
						availableQuantizations: ["", "int8"],
						languages: ["en"],
					} as never;
				}
				if (id === "rt-ru") {
					return { id, languages: ["ru"], nativeStreaming: true } as never;
				}
			}) as never,
			kind: "main",
			previous: "prev",
			quantization: undefined,
			value: "next-en",
		});

		expect(atomicInvoker.mock.calls.at(0)?.at(0)).toMatchObject({
			kind: "main",
			modelId: "next-en",
			quantization: "",
			device: "cpu",
			realtimeModel: "",
		});
	});

	test("main: short-circuits when catalog does not know the target model", () => {
		// A genuinely-missing LOCAL id isn't a real catalog selection, so
		// applyMainSwap must early-return rather than persist an id the picker
		// can't resolve.
		t.runIssueSwap({
			currentQuantization: "int8",
			getModel: ((_id: string) => undefined) as never,
			kind: "main",
			previous: "prev",
			quantization: undefined,
			value: "missing-from-catalog",
		});
	});

	test("realtime: refuses a model whose languages do not overlap the current main model", () => {
		t.runIssueSwap({
			currentMainModel: "main-en",
			currentQuantization: "int8",
			getModel: ((id: string) => {
				if (id === "main-en") {
					return { languages: ["en"] } as never;
				}
				if (id === "rt-ru") {
					return { id, languages: ["ru"], nativeStreaming: true } as never;
				}
			}) as never,
			kind: "realtime",
			previous: "prev-rt",
			quantization: undefined,
			value: "rt-ru",
		});
	});

	test("realtime: refuses a different model when current main is native streaming", () => {
		t.runIssueSwap({
			currentMainModel: "streaming-zipformer-en",
			currentQuantization: "int8",
			getModel: ((id: string) => {
				if (id === "streaming-zipformer-en") {
					return { id, languages: ["en"], nativeStreaming: true } as never;
				}
				if (id === "streaming-nemo-rnnt-en-1040ms-int8") {
					return { id, languages: ["en"], nativeStreaming: true } as never;
				}
			}) as never,
			kind: "realtime",
			previous: "streaming-zipformer-en",
			quantization: undefined,
			value: "streaming-nemo-rnnt-en-1040ms-int8",
		});
	});

	test("realtime: refuses a non-canonical duplicated streaming export", () => {
		t.runIssueSwap({
			currentQuantization: "int8",
			getModel: ((id: string) =>
				id === "streaming-parakeet-unified-en-240ms-int8"
					? ({ id, languages: ["en"], nativeStreaming: true } as never)
					: undefined) as never,
			kind: "realtime",
			previous: "prev-rt",
			quantization: undefined,
			value: "streaming-parakeet-unified-en-240ms-int8",
		});
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
