import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import { act, cleanup, renderHook } from "@testing-library/react";
import type {
	TtsInstallFailedPayload,
	TtsInstallPhase,
	TtsInstallStatusPayload,
	TtsModelStateEntry,
} from "@/shared/api/ipc-client";

// ── ipc-client mock surface ────────────────────────────────────────────────
// The hook calls FOUR ipc-client exports directly:
//   - initTts(): the retry re-trigger. We count calls.
//   - onTtsInstallStatus / onTtsInstallFailed / onTtsModelDownloadComplete:
//     the three useEffect subscriptions. We capture their callbacks so the
//     test can synthesise server pings, and hand back spy unsubscribers to
//     assert cleanup on unmount.
let initTtsCalls = 0;
let statusCb: ((payload: TtsInstallStatusPayload) => void) | null = null;
let failedCb: ((payload: TtsInstallFailedPayload) => void) | null = null;
let completeCb: ((payload: { cancelled: boolean }) => void) | null = null;
let statusUnsub = 0;
let failedUnsub = 0;
let completeUnsub = 0;

const initTtsSpy = (): Promise<{ ready: boolean }> => {
	initTtsCalls += 1;
	return Promise.resolve({ ready: false });
};
const onTtsInstallStatusSpy = (
	cb: (payload: TtsInstallStatusPayload) => void,
): (() => void) => {
	statusCb = cb;
	return () => {
		statusUnsub += 1;
		statusCb = null;
	};
};
const onTtsInstallFailedSpy = (
	cb: (payload: TtsInstallFailedPayload) => void,
): (() => void) => {
	failedCb = cb;
	return () => {
		failedUnsub += 1;
		failedCb = null;
	};
};
const onTtsModelDownloadCompleteSpy = (
	cb: (payload: { cancelled: boolean }) => void,
): (() => void) => {
	completeCb = cb;
	return () => {
		completeUnsub += 1;
		completeCb = null;
	};
};

mock.module("@/shared/api/ipc-client", () => ({
	...ipcClientMock(),
	initTts: initTtsSpy,
	onTtsInstallStatus: onTtsInstallStatusSpy,
	onTtsInstallFailed: onTtsInstallFailedSpy,
	onTtsModelDownloadComplete: onTtsModelDownloadCompleteSpy,
}));

const { DEFAULT_SETTINGS, useSettingsStore } = await import(
	"@/entities/setting"
);
const { useTtsModelStateStore } = await import("@/entities/tts-catalog");
const { useTtsModelPickerStore } = await import("@/features/tts-model-picker");
const {
	buildTtsEnablePatch,
	isTtsModelCached,
	pickCachedTtsModel,
	projectInstallPhase,
	resolveTtsEnabledModelPatch,
	resolveToggleAction,
	useTtsInstallGate,
} = await import("./use-tts-install-gate");

const TEST_MODEL = "test-voice-model";

function makeState(
	id: string,
	state: "cached" | "partial" | "not_cached",
): TtsModelStateEntry {
	return {
		id,
		effectiveQuantization: "fp32",
		estimatedBytes: 0,
		cacheByQuantization: {
			fp32: {
				state,
				downloadedBytes: 0,
				totalBytes: 0,
				progress: state === "cached" ? 1 : 0,
			},
		},
	};
}

function setModelState(state: "cached" | "partial" | "not_cached"): void {
	useTtsModelStateStore.setState({
		statesById: { [TEST_MODEL]: makeState(TEST_MODEL, state) },
		isLoaded: true,
	});
}

function setTtsHotkey(hotkey: string | undefined): void {
	useSettingsStore.setState({
		settings: {
			...DEFAULT_SETTINGS,
			tts:
				hotkey === undefined
					? ({ model: TEST_MODEL } as never)
					: { ...DEFAULT_SETTINGS.tts, model: TEST_MODEL, hotkey },
		},
		isLoaded: true,
	});
}

function currentTts(): { enabled?: boolean; hotkey?: string } {
	return useSettingsStore.getState().settings.tts as {
		enabled?: boolean;
		hotkey?: string;
	};
}

beforeEach(() => {
	initTtsCalls = 0;
	statusCb = null;
	failedCb = null;
	completeCb = null;
	statusUnsub = 0;
	failedUnsub = 0;
	completeUnsub = 0;
	useTtsModelPickerStore.getState().close();
	useTtsModelStateStore.setState({ statesById: {}, isLoaded: false });
	// Start each test from the schema defaults (enabled: false, default hotkey),
	// with the selected model pinned to the test id.
	useSettingsStore.setState({
		settings: {
			...DEFAULT_SETTINGS,
			tts: { ...DEFAULT_SETTINGS.tts, model: TEST_MODEL },
		},
		isLoaded: true,
	});
});

afterEach(() => {
	cleanup();
});

// ── Pure helpers ─────────────────────────────────────────────────────────────
describe("projectInstallPhase", () => {
	test("'ready' collapses to null (idle)", () => {
		expect(projectInstallPhase("ready")).toBeNull();
	});

	test("'engine' / 'model' / 'unknown' pass through unchanged", () => {
		expect(projectInstallPhase("engine")).toBe("engine");
		expect(projectInstallPhase("model")).toBe("model");
		expect(projectInstallPhase("unknown")).toBe("unknown");
	});
});

describe("isTtsModelCached", () => {
	test("undefined state → not cached", () => {
		expect(isTtsModelCached(undefined)).toBe(false);
	});

	test("a fully-cached quant → cached", () => {
		expect(isTtsModelCached(makeState(TEST_MODEL, "cached"))).toBe(true);
	});

	test("only a partial quant → not cached (must finish downloading)", () => {
		expect(isTtsModelCached(makeState(TEST_MODEL, "partial"))).toBe(false);
	});

	test("not-cached quant → not cached", () => {
		expect(isTtsModelCached(makeState(TEST_MODEL, "not_cached"))).toBe(false);
	});
});

describe("pickCachedTtsModel", () => {
	test("returns the first model with a cached quantization", () => {
		expect(
			pickCachedTtsModel([{ id: "uncached" }, { id: "cached" }], {
				uncached: makeState("uncached", "not_cached"),
				cached: makeState("cached", "cached"),
			}),
		).toBe("cached");
	});

	test("returns null when no model is cached", () => {
		expect(
			pickCachedTtsModel([{ id: "a" }, { id: "b" }], {
				a: makeState("a", "not_cached"),
				b: makeState("b", "partial"),
			}),
		).toBeNull();
	});
});

describe("resolveTtsEnabledModelPatch", () => {
	test("does not patch when TTS is disabled", () => {
		expect(
			resolveTtsEnabledModelPatch({
				cloudFallbackAllowed: false,
				enabled: false,
				isCloud: false,
				model: TEST_MODEL,
				models: [{ id: TEST_MODEL }],
				statesById: { [TEST_MODEL]: makeState(TEST_MODEL, "not_cached") },
				statesLoaded: true,
			}),
		).toBeNull();
	});

	test("does not patch cloud TTS", () => {
		expect(
			resolveTtsEnabledModelPatch({
				cloudFallbackAllowed: false,
				enabled: true,
				isCloud: true,
				model: TEST_MODEL,
				models: [{ id: TEST_MODEL }],
				statesById: {},
				statesLoaded: true,
			}),
		).toBeNull();
	});

	test("waits for cache state before reconciling", () => {
		expect(
			resolveTtsEnabledModelPatch({
				cloudFallbackAllowed: false,
				enabled: true,
				isCloud: false,
				model: TEST_MODEL,
				models: [{ id: TEST_MODEL }],
				statesById: {},
				statesLoaded: false,
			}),
		).toBeNull();
	});

	test("keeps enabled TTS when the selected model is cached", () => {
		expect(
			resolveTtsEnabledModelPatch({
				cloudFallbackAllowed: false,
				enabled: true,
				isCloud: false,
				model: TEST_MODEL,
				models: [{ id: TEST_MODEL }],
				statesById: { [TEST_MODEL]: makeState(TEST_MODEL, "cached") },
				statesLoaded: true,
			}),
		).toBeNull();
	});

	test("switches enabled TTS to another cached model when the selected one was deleted", () => {
		expect(
			resolveTtsEnabledModelPatch({
				cloudFallbackAllowed: false,
				enabled: true,
				isCloud: false,
				model: "deleted",
				models: [{ id: "deleted" }, { id: "fallback" }],
				statesById: {
					deleted: makeState("deleted", "not_cached"),
					fallback: makeState("fallback", "cached"),
				},
				statesLoaded: true,
			}),
		).toEqual({ model: "fallback" });
	});

	test("disables enabled local TTS when no cached models remain", () => {
		expect(
			resolveTtsEnabledModelPatch({
				cloudFallbackAllowed: false,
				enabled: true,
				isCloud: false,
				model: TEST_MODEL,
				models: [{ id: TEST_MODEL }],
				statesById: { [TEST_MODEL]: makeState(TEST_MODEL, "not_cached") },
				statesLoaded: true,
			}),
		).toEqual({ enabled: false });
	});

	test("switches enabled local TTS to cloud when no cached models remain and cloud is available", () => {
		expect(
			resolveTtsEnabledModelPatch({
				cloudFallbackAllowed: true,
				enabled: true,
				isCloud: false,
				model: TEST_MODEL,
				models: [{ id: TEST_MODEL }],
				statesById: { [TEST_MODEL]: makeState(TEST_MODEL, "not_cached") },
				statesLoaded: true,
			}),
		).toEqual({ source: "cloud" });
	});
});

describe("resolveToggleAction", () => {
	test("true → 'enable'", () => {
		expect(resolveToggleAction(true)).toBe("enable");
	});

	test("false → 'disable'", () => {
		expect(resolveToggleAction(false)).toBe("disable");
	});
});

describe("buildTtsEnablePatch", () => {
	test("non-empty current hotkey → only flips enabled (preserves user binding)", () => {
		expect(buildTtsEnablePatch("LCtrl+S", "LWin+R")).toEqual({ enabled: true });
	});

	test("empty current hotkey → folds in the default binding", () => {
		expect(buildTtsEnablePatch("", "LWin+R")).toEqual({
			enabled: true,
			hotkey: "LWin+R",
		});
	});

	test("whitespace-only hotkey is treated as empty (folds default)", () => {
		expect(buildTtsEnablePatch("   ", "LWin+R")).toEqual({
			enabled: true,
			hotkey: "LWin+R",
		});
	});
});

// ── The hook itself ─────────────────────────────────────────────────────────
describe("useTtsInstallGate (initial state + subscriptions)", () => {
	test("starts idle: no phase/error", () => {
		const { result } = renderHook(() => useTtsInstallGate());
		expect(result.current.installPhase).toBeNull();
		expect(result.current.installError).toBeNull();
	});

	test("subscribes to all three install feeds on mount", () => {
		renderHook(() => useTtsInstallGate());
		expect(statusCb).not.toBeNull();
		expect(failedCb).not.toBeNull();
		expect(completeCb).not.toBeNull();
	});

	test("unsubscribes from all three feeds on unmount", () => {
		const { unmount } = renderHook(() => useTtsInstallGate());
		unmount();
		expect(statusUnsub).toBe(1);
		expect(failedUnsub).toBe(1);
		expect(completeUnsub).toBe(1);
	});
});

describe("useTtsInstallGate — install-status ping effect", () => {
	test("projects a non-ready phase and clears any stale error banner", () => {
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => failedCb?.({ category: "network", reason: "Offline" }));
		expect(result.current.installError).toBe("Offline");

		act(() => statusCb?.({ phase: "model" }));
		expect(result.current.installPhase).toBe("model");
		expect(result.current.installError).toBeNull();
	});

	test("'ready' phase collapses to null (idle) via projectInstallPhase", () => {
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => statusCb?.({ phase: "engine" }));
		expect(result.current.installPhase).toBe("engine");
		act(() => statusCb?.({ phase: "ready" as TtsInstallPhase }));
		expect(result.current.installPhase).toBeNull();
	});
});

describe("useTtsInstallGate — download-complete effect", () => {
	test("CANCELLED completion clears the phase (install over)", () => {
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => statusCb?.({ phase: "model" }));
		expect(result.current.installPhase).toBe("model");
		act(() => completeCb?.({ cancelled: true }));
		expect(result.current.installPhase).toBeNull();
	});

	test("SUCCESSFUL completion does NOT clear the phase (avoids the re-enable flash)", () => {
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => statusCb?.({ phase: "model" }));
		expect(result.current.installPhase).toBe("model");
		act(() => completeCb?.({ cancelled: false }));
		expect(result.current.installPhase).toBe("model");
	});
});

describe("useTtsInstallGate — install-failed effect", () => {
	test("surfaces the classified reason and clears the progress phase", () => {
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => statusCb?.({ phase: "engine" }));
		act(() =>
			failedCb?.({ category: "model-not-found", reason: "Model missing" }),
		);
		expect(result.current.installPhase).toBeNull();
		expect(result.current.installError).toBe("Model missing");
	});
});

describe("useTtsInstallGate — handleEnabledToggle OFF (disable)", () => {
	test("turning OFF is immediate: flips enabled:false and clears the phase", () => {
		setModelState("cached");
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => statusCb?.({ phase: "model" }));
		act(() => result.current.handleEnabledToggle(true));
		expect(currentTts().enabled).toBe(true);

		act(() => result.current.handleEnabledToggle(false));
		expect(currentTts().enabled).toBe(false);
		expect(result.current.installPhase).toBeNull();
	});
});

describe("useTtsInstallGate — handleEnabledToggle ON (model already cached → enable)", () => {
	test("selected model on disk → enables straight away, picker stays closed", () => {
		setModelState("cached");
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => result.current.handleEnabledToggle(true));
		expect(currentTts().enabled).toBe(true);
		expect(useTtsModelPickerStore.getState().open).toBe(false);
	});

	test("enable with empty persisted hotkey folds the default binding in", () => {
		setTtsHotkey("");
		setModelState("cached");
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => result.current.handleEnabledToggle(true));
		expect(currentTts().enabled).toBe(true);
		expect(currentTts().hotkey).toBe(DEFAULT_SETTINGS.tts.hotkey);
	});

	test("enable with a user hotkey preserves it (only flips enabled)", () => {
		setTtsHotkey("LCtrl+Alt+T");
		setModelState("cached");
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => result.current.handleEnabledToggle(true));
		expect(currentTts().enabled).toBe(true);
		expect(currentTts().hotkey).toBe("LCtrl+Alt+T");
	});
});

describe("useTtsInstallGate — handleEnabledToggle ON (model NOT cached → open picker)", () => {
	test("not on disk → opens the model selector and leaves enabled untouched", () => {
		setModelState("not_cached");
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => result.current.handleEnabledToggle(true));
		expect(currentTts().enabled).toBe(false);
		const picker = useTtsModelPickerStore.getState();
		expect(picker.open).toBe(true);
		expect(picker.enableOnInstall).toBe(true);
	});

	test("no state loaded yet → treated as not cached → opens the picker", () => {
		// statesById is empty (reset in beforeEach).
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => result.current.handleEnabledToggle(true));
		expect(currentTts().enabled).toBe(false);
		expect(useTtsModelPickerStore.getState().open).toBe(true);
	});
});

describe("useTtsInstallGate — retryInstall", () => {
	test("clears the error, sets phase to 'engine', and re-dispatches init_tts", () => {
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => failedCb?.({ category: "network", reason: "Boom" }));
		expect(result.current.installError).toBe("Boom");

		act(() => result.current.retryInstall());
		expect(result.current.installError).toBeNull();
		expect(result.current.installPhase).toBe("engine");
		expect(initTtsCalls).toBe(1);
	});
});
