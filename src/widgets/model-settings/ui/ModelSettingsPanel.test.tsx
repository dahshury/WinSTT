import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	type RenderResult,
} from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useConnectionStore } from "@/entities/connection";
import { useCatalogStore, useModelStateStore } from "@/entities/model-catalog";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { ModelSettingsPanel } from "./ModelSettingsPanel";

// `ModelSettingsPanel` reads `useConnectionStore(s => s.gpuInfo).length` during
// render (the GPU-availability gate for the Device control). bun:test shares one
// happy-dom + one set of Zustand stores across every test file in the process,
// and several connection-store consumers (ConnectionIndicator, useConnectionListener,
// StatusBar, useSyncActiveModel) set `gpuInfo: null` and don't restore the default
// empty array. When that null leaks in from an earlier file, this render throws
// `null is not an object (evaluating '….gpuInfo.length')`. Seed the store with the
// real connection-store default (`gpuInfo: []`) before each render so the panel
// mounts correctly regardless of file order.
let rendered: RenderResult | null = null;

function rawModel(
	id: string,
	nativeStreaming: boolean,
	overrides: Record<string, unknown> = {},
) {
	return {
		id,
		display_name: id,
		family: nativeStreaming ? "nemo" : "whisper",
		languages: ["en"],
		supports_language_detection: false,
		size_label: "1M",
		preview_capable: true,
		native_streaming: nativeStreaming,
		final_reuse_safe: nativeStreaming,
		onnx_model_name: id,
		description: id,
		...overrides,
	};
}

beforeEach(() => {
	useConnectionStore.setState({ gpuInfo: [] });
	useCatalogStore
		.getState()
		.setModels([rawModel("tiny", false), rawModel("streaming-en", true)]);
	useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

afterEach(() => {
	// The preload's global afterEach brute-clears <body> but never React-unmounts
	// roots, so this panel's fiber would otherwise stay subscribed to
	// `useConnectionStore` and re-render (throwing on `gpuInfo.length`) when a
	// LATER file's test sets `gpuInfo: null` (e.g. StatusBar's beforeEach) —
	// surfacing as an "unhandled error between tests". Explicitly unmount this
	// file's own render so its subscription is torn down, then restore the default.
	if (rendered) {
		act(() => rendered?.unmount());
		rendered = null;
	}
	useConnectionStore.setState({ gpuInfo: [] });
	useCatalogStore.setState({ models: [], isLoaded: false });
	useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

describe("ModelSettingsPanel", () => {
	test("renders without crashing", () => {
		rendered = render(
			<IntlProvider>
				<ModelSettingsPanel />
			</IntlProvider>,
		);
		expect(rendered.container.firstElementChild).not.toBeNull();
	});

	test("does NOT switch the selected model on a warm mount before the fresh state refresh resolves", () => {
		// Regression: `useModelStateStore.isLoaded` latches globally, so a warm mount can hand the
		// stale-model fallback a snapshot that momentarily reports the (actually-fine) selected model
		// as not-cached. Before the fix that stale read silently switched the persisted selection to
		// the smallest cached model (the first list item, vosk russian). The panel now gates the
		// fallback on THIS mount's refresh resolving; here that refresh never resolves, so the
		// selection must stay put.
		const state = () => useModelStateStore.getState();
		const originalRefresh = state().refresh;
		const entry = (cached: boolean, bytes: number) =>
			({
				cache: {
					state: cached ? "cached" : "not_cached",
					progress: cached ? 1 : 0,
				},
				estimated_bytes: bytes,
				comfortable_on_cpu: true,
				comfortable_on_gpu: true,
			}) as never;
		try {
			useCatalogStore
				.getState()
				.setModels([rawModel("tiny", false), rawModel("base", false)]);
			useModelStateStore.setState({
				isLoaded: true, // warm: a prior surface already latched loaded
				statesById: { tiny: entry(false, 100), base: entry(true, 50) },
				// Never resolves → `statesFreshSinceMount` stays false → fallback stays gated.
				refresh: () => new Promise<void>(() => undefined),
			});
			useSettingsStore.setState({
				settings: {
					...DEFAULT_SETTINGS,
					model: { ...DEFAULT_SETTINGS.model, model: "tiny" },
				} as typeof DEFAULT_SETTINGS,
			});
			rendered = render(
				<IntlProvider>
					<ModelSettingsPanel />
				</IntlProvider>,
			);
			// Selection unchanged — the fallback did NOT fire on the stale snapshot (without the gate
			// it would have switched "tiny" → the cached "base").
			expect(useSettingsStore.getState().settings.model.model).toBe("tiny");
		} finally {
			useModelStateStore.setState({
				isLoaded: false,
				statesById: {},
				refresh: originalRefresh,
			});
		}
	});

	test("hides the initial prompt setting", () => {
		rendered = render(
			<IntlProvider>
				<ModelSettingsPanel />
			</IntlProvider>,
		);
		expect(screen.queryByText("Initial Prompt")).toBeNull();
		expect(screen.queryByLabelText("Initial Prompt")).toBeNull();
	});

	test("hides the unload timeout when the active STT model is cloud", () => {
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				global: { modelUnloadTimeout: "min10" },
				model: {
					...DEFAULT_SETTINGS.model,
					model: "openrouter:openai/whisper-1",
				},
				tts: { ...DEFAULT_SETTINGS.tts, source: "cloud" },
			} as typeof DEFAULT_SETTINGS,
		});
		rendered = render(
			<IntlProvider>
				<ModelSettingsPanel />
			</IntlProvider>,
		);
		expect(screen.queryByText("Model Unload Timeout")).toBeNull();
	});

	test("forces unload timeout display to Never in listen mode without saving over previous value", () => {
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				global: { modelUnloadTimeout: "min10" },
				general: {
					...DEFAULT_SETTINGS.general,
					recordingMode: "listen",
				},
				model: {
					...DEFAULT_SETTINGS.model,
					model: "tiny",
					realtimeModel: "streaming-en",
				},
			} as typeof DEFAULT_SETTINGS,
		});
		rendered = render(
			<IntlProvider>
				<ModelSettingsPanel />
			</IntlProvider>,
		);
		const input = screen.getByRole("combobox", {
			name: "Model Unload Timeout",
		}) as HTMLInputElement;
		expect(input.value).toBe("Never");
		expect(input.disabled).toBe(true);
		expect(useSettingsStore.getState().settings.global.modelUnloadTimeout).toBe(
			"min10",
		);
	});

	test("keeps the main model picker visible but disabled in listen mode", () => {
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				general: {
					...DEFAULT_SETTINGS.general,
					recordingMode: "listen",
				},
				model: {
					...DEFAULT_SETTINGS.model,
					model: "tiny",
					realtimeModel: "streaming-en",
				},
			} as typeof DEFAULT_SETTINGS,
		});
		rendered = render(
			<IntlProvider>
				<ModelSettingsPanel />
			</IntlProvider>,
		);

		expect(screen.getByText("Main Model")).toBeTruthy();
		const mainModelButton = screen.getByRole("button", {
			name: /tiny/i,
		}) as HTMLButtonElement;
		expect(mainModelButton.disabled).toBe(true);
		expect(useSettingsStore.getState().settings.model.model).toBe("tiny");
	});

	test("hides update interval for a native-streaming realtime model in dictation modes", () => {
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				model: {
					...DEFAULT_SETTINGS.model,
					model: "tiny",
					realtimeModel: "streaming-en",
				},
			} as typeof DEFAULT_SETTINGS,
		});
		rendered = render(
			<IntlProvider>
				<ModelSettingsPanel />
			</IntlProvider>,
		);
		expect(screen.queryByText("Update Interval")).toBeNull();
	});

	test("keeps update interval visible for non-streaming realtime fallback", () => {
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				model: {
					...DEFAULT_SETTINGS.model,
					model: "tiny",
					realtimeModel: "tiny",
				},
			} as typeof DEFAULT_SETTINGS,
		});
		rendered = render(
			<IntlProvider>
				<ModelSettingsPanel />
			</IntlProvider>,
		);
		expect(screen.getByText("Update Interval")).toBeTruthy();
	});

	test("keeps update interval visible in listen mode", () => {
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				general: {
					...DEFAULT_SETTINGS.general,
					recordingMode: "listen",
				},
				model: {
					...DEFAULT_SETTINGS.model,
					model: "tiny",
					realtimeModel: "streaming-en",
				},
			} as typeof DEFAULT_SETTINGS,
		});
		rendered = render(
			<IntlProvider>
				<ModelSettingsPanel />
			</IntlProvider>,
		);
		expect(screen.getByText("Update Interval")).toBeTruthy();
	});

	test("shows Canary as a single source-language selector and clears stale auto settings", async () => {
		useCatalogStore.getState().setModels([
			rawModel("nemo-canary-180m-flash", true, {
				family: "nemo",
				languages: ["de", "en", "es", "fr"],
				supports_language_detection: false,
			}),
		]);
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				model: {
					...DEFAULT_SETTINGS.model,
					model: "nemo-canary-180m-flash",
					autoDetectLanguage: true,
					language: "",
					languageCandidates: ["de", "en"],
				},
			} as typeof DEFAULT_SETTINGS,
		});

		rendered = render(
			<IntlProvider>
				<ModelSettingsPanel />
			</IntlProvider>,
		);

		expect(screen.queryByText("Auto-detect")).toBeNull();
		const languageInputs = screen.getAllByLabelText("Language");
		expect(
			languageInputs.some((input) => !(input as HTMLInputElement).disabled),
		).toBe(true);
		await waitFor(() => {
			const modelSettings = useSettingsStore.getState().settings.model;
			expect(modelSettings.autoDetectLanguage).toBe(false);
			expect(modelSettings.language).toBe("de");
			expect(modelSettings.languageCandidates).toEqual([]);
		});
	});

	test("hides language controls for multilingual models that cannot use a runtime language option", () => {
		useCatalogStore.getState().setModels([
			rawModel("nemo-parakeet-tdt-0.6b-v3", true, {
				family: "nemo",
				languages: ["de", "en", "es", "fr"],
				supports_language_detection: false,
			}),
		]);
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				model: {
					...DEFAULT_SETTINGS.model,
					model: "nemo-parakeet-tdt-0.6b-v3",
				},
			} as typeof DEFAULT_SETTINGS,
		});

		rendered = render(
			<IntlProvider>
				<ModelSettingsPanel />
			</IntlProvider>,
		);

		expect(screen.queryByText("Auto-detect")).toBeNull();
		expect(screen.queryByLabelText("Language")).toBeNull();
	});

	test("shows auto-detect for multilingual models that support language detection", () => {
		useCatalogStore.getState().setModels([
			rawModel("whisper-auto", false, {
				languages: ["de", "en"],
				supports_language_detection: true,
			}),
		]);
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				model: {
					...DEFAULT_SETTINGS.model,
					model: "whisper-auto",
				},
			} as typeof DEFAULT_SETTINGS,
		});

		rendered = render(
			<IntlProvider>
				<ModelSettingsPanel />
			</IntlProvider>,
		);

		expect(screen.getByText("Auto-detect")).toBeTruthy();
	});

	test("hides the language picker while auto-detect is enabled", () => {
		useCatalogStore.getState().setModels([
			rawModel("whisper-auto", false, {
				languages: ["de", "en"],
				supports_language_detection: true,
			}),
		]);
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				model: {
					...DEFAULT_SETTINGS.model,
					model: "whisper-auto",
					autoDetectLanguage: true,
					language: "",
					languageCandidates: ["en", "de"],
				},
			} as typeof DEFAULT_SETTINGS,
		});

		rendered = render(
			<IntlProvider>
				<ModelSettingsPanel />
			</IntlProvider>,
		);

		expect(screen.getByText("Auto-detect")).toBeTruthy();
		expect(screen.queryByRole("combobox", { name: "Language" })).toBeNull();
	});

	test("lets Whisper users select multiple candidate languages without enabling auto-detect", async () => {
		useCatalogStore.getState().setModels([
			rawModel("whisper-auto", false, {
				languages: ["de", "en"],
				supports_language_detection: true,
			}),
		]);
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				model: {
					...DEFAULT_SETTINGS.model,
					model: "whisper-auto",
					autoDetectLanguage: false,
					language: "en",
					languageCandidates: [],
				},
			} as typeof DEFAULT_SETTINGS,
		});

		rendered = render(
			<IntlProvider>
				<ModelSettingsPanel />
			</IntlProvider>,
		);

		expect(screen.getByText("Auto-detect")).toBeTruthy();
		expect(
			(screen.getByRole("combobox", { name: "Language" }) as HTMLInputElement)
				.disabled,
		).toBe(false);

		fireEvent.click(screen.getByRole("button", { name: "Language" }));
		await act(async () => {
			await new Promise((resolve) => requestAnimationFrame(resolve));
		});
		const germanCheckbox = screen
			.getAllByRole("checkbox")
			.find((checkbox) => checkbox.getAttribute("aria-label") === "German");
		expect(germanCheckbox).toBeTruthy();
		fireEvent.click(germanCheckbox!);

		await waitFor(() => {
			const modelSettings = useSettingsStore.getState().settings.model;
			expect(modelSettings.autoDetectLanguage).toBe(false);
			expect(modelSettings.language).toBe("en");
			expect(modelSettings.languageCandidates).toEqual(["en", "de"]);
		});
	});
});
