import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import type { RuntimeInfo } from "@/entities/connection";
import { useConnectionStore } from "@/entities/connection";
import { useModelSwapStore } from "@/entities/model-catalog";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { useSyncActiveModel } from "./use-sync-active-model";

const originalApi = window.electronAPI;

function withModel(model: string): RuntimeInfo {
	return {
		device: "cpu",
		is_gpu: false,
		model,
		providers: ["CPUExecutionProvider"],
		realtime_model: null,
	};
}

beforeEach(() => {
	window.electronAPI = {
		...originalApi,
		invoke: () => Promise.resolve(),
		send: () => undefined,
		on: () => () => undefined,
	};
	useConnectionStore.setState({
		connectionStatus: "connected",
		serverStatus: "running",
		gpuInfo: null,
		runtimeInfo: null,
	});
	useModelSwapStore.setState({ activeMain: null, activeRealtime: null });
	useSettingsStore.setState({
		settings: { ...DEFAULT_SETTINGS, model: { ...DEFAULT_SETTINGS.model, model: "tiny" } },
		isLoaded: true,
	});
});

afterEach(() => {
	window.electronAPI = originalApi;
});

describe("useSyncActiveModel", () => {
	test("adopts the server's loaded model when it differs from settings", async () => {
		// Renderer thinks the user picked nemo-canary; the server fell back to tiny.
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				model: { ...DEFAULT_SETTINGS.model, model: "nemo-canary-1b-v2" },
			},
			isLoaded: true,
		});
		renderHook(() => useSyncActiveModel());
		useConnectionStore.setState({ runtimeInfo: withModel("tiny") });
		await waitFor(() => {
			expect(useSettingsStore.getState().settings.model.model).toBe("tiny");
		});
	});

	test("no-op when settings already match the server's loaded model", () => {
		useConnectionStore.setState({ runtimeInfo: withModel("tiny") });
		renderHook(() => useSyncActiveModel());
		expect(useSettingsStore.getState().settings.model.model).toBe("tiny");
	});

	test("does not run while the server isn't reporting running", () => {
		useConnectionStore.setState({
			serverStatus: "idle",
			runtimeInfo: withModel("large-v3-turbo"),
		});
		renderHook(() => useSyncActiveModel());
		// Setting was tiny before mount — must stay tiny while server is idle.
		expect(useSettingsStore.getState().settings.model.model).toBe("tiny");
	});

	test("does not run while a main-model swap is in flight", () => {
		// Mid-swap: activeMain is set, runtimeInfo briefly lags. Reconciler
		// must not revert the user's in-flight selection back to the lagging
		// runtime_info.model.
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				model: { ...DEFAULT_SETTINGS.model, model: "large-v3-turbo" },
			},
			isLoaded: true,
		});
		useModelSwapStore.setState({ activeMain: "large-v3-turbo", activeRealtime: null });
		useConnectionStore.setState({ runtimeInfo: withModel("tiny") });
		renderHook(() => useSyncActiveModel());
		expect(useSettingsStore.getState().settings.model.model).toBe("large-v3-turbo");
	});

	test("user picking a new model does NOT trigger reconciliation (regression #1)", async () => {
		// Original regression: when settingsModel was in the deps array,
		// every user pick re-ran the effect, saw lagging runtime_info, and
		// reverted the user's choice back to the old model.
		useConnectionStore.setState({ runtimeInfo: withModel("tiny") });
		renderHook(() => useSyncActiveModel());
		// Simulate the user picking a new model. The model-swap-store will be
		// updated by the in-flight swap; runtime_info won't refresh until
		// after model_swap_completed fires.
		useModelSwapStore.setState({ activeMain: "large-v3-turbo", activeRealtime: null });
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				model: { ...DEFAULT_SETTINGS.model, model: "large-v3-turbo" },
			},
			isLoaded: true,
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(useSettingsStore.getState().settings.model.model).toBe("large-v3-turbo");
	});

	test("swap completion alone does NOT trigger reconciliation against stale runtime (regression #2)", async () => {
		// Second-order regression: when mainSwapping was a dep, the
		// transition from true → false (clearing on swap_completed) re-fired
		// the effect against the still-stale runtime_info (the server push
		// hadn't arrived yet through the data channel). It then reverted
		// settings to the old runtime model. Lock that in: when swap clears
		// but runtime_info hasn't refreshed, settings stays untouched.
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				model: { ...DEFAULT_SETTINGS.model, model: "lite-whisper-large-v3-turbo-fast" },
			},
			isLoaded: true,
		});
		useConnectionStore.setState({ runtimeInfo: withModel("large-v3-turbo") });
		useModelSwapStore.setState({
			activeMain: "lite-whisper-large-v3-turbo-fast",
			activeRealtime: null,
		});
		renderHook(() => useSyncActiveModel());
		// Swap completes (activeMain clears) BEFORE the server's runtime_info
		// push has updated the snapshot. With mainSwapping in deps, this
		// would re-fire and revert. With it out of deps, only a real
		// runtime_info change triggers the effect.
		useModelSwapStore.setState({ activeMain: null, activeRealtime: null });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(useSettingsStore.getState().settings.model.model).toBe(
			"lite-whisper-large-v3-turbo-fast"
		);
	});

	test("re-reconciles when async settingsLoad reverts the synced model (regression #3)", async () => {
		// Race observed in production: the server falls back from a broken
		// user pick (canary) to tiny and pushes runtime_info=tiny. The
		// reconciler writes "tiny" into settings. Then useSyncSettings's
		// async settingsLoad() resolves with electron-store's stored value
		// (still canary, since electron-store wasn't refreshed yet) and
		// setSettings(...) replaces the whole settings object — silently
		// reverting model.model back to canary. With settingsModel out of
		// deps, the reconciler doesn't re-fire and the picker stays on
		// canary while the server runs tiny. Locks in: the reconciler
		// must re-fire when settings drift away from runtime.
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				model: { ...DEFAULT_SETTINGS.model, model: "nemo-canary-1b-v2" },
			},
			isLoaded: true,
		});
		renderHook(() => useSyncActiveModel());
		useConnectionStore.setState({ runtimeInfo: withModel("tiny") });
		await waitFor(() => {
			expect(useSettingsStore.getState().settings.model.model).toBe("tiny");
		});
		// Simulate the late-resolving settingsLoad replacing the whole
		// settings object with electron-store's stale canary value.
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				model: { ...DEFAULT_SETTINGS.model, model: "nemo-canary-1b-v2" },
			},
			isLoaded: true,
		});
		await waitFor(() => {
			expect(useSettingsStore.getState().settings.model.model).toBe("tiny");
		});
	});

	test("reconciles after swap completes when runtime_info refreshes to the new model", async () => {
		// Full lifecycle: user picks new model, server swaps, runtime_info
		// refreshes, swap clears — reconciler sees match and no-ops.
		useConnectionStore.setState({ runtimeInfo: withModel("tiny") });
		renderHook(() => useSyncActiveModel());
		useModelSwapStore.setState({ activeMain: "large-v3-turbo", activeRealtime: null });
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				model: { ...DEFAULT_SETTINGS.model, model: "large-v3-turbo" },
			},
			isLoaded: true,
		});
		// Swap completes — clear in-flight state and refresh runtime_info.
		useModelSwapStore.setState({ activeMain: null, activeRealtime: null });
		useConnectionStore.setState({ runtimeInfo: withModel("large-v3-turbo") });
		await waitFor(() => {
			expect(useSettingsStore.getState().settings.model.model).toBe("large-v3-turbo");
		});
	});
});
