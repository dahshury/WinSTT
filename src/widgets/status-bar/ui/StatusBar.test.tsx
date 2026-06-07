import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useConnectionStore } from "@/entities/connection";
import {
	type ModelInfo,
	useCatalogStore,
	useModelStateStore,
	useModelSwapStore,
} from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { useListenStore } from "@/features/listen-mode";
import { useDownloadStore } from "@/features/model-download";
import { StatusBar } from "./StatusBar";

const initialSettings = useSettingsStore.getState().settings;

function model(id: string): ModelInfo {
	return {
		id,
		displayName: id,
		backend: "faster_whisper",
		family: "whisper",
		languages: ["en"],
		supportsLanguageDetection: true,
		sizeLabel: "75 MB",
		previewCapable: true,
		nativeStreaming: false,
		finalReuseSafe: false,
		supportsRealtime: true,
		onnxModelName: null,
		description: "",
		availableQuantizations: [""],
		sizeBytesByQuantization: {},
		available: true,
		errorMessage: "",
		localPath: null,
		speedScore: 0.5,
		accuracyScore: 0.5,
	};
}

const CATALOG: ModelInfo[] = [model("tiny"), model("large-v2")];

beforeEach(() => {
	useSettingsStore.setState({ settings: initialSettings });
	useConnectionStore.setState({
		connectionStatus: "disconnected",
		gpuInfo: null,
		serverStatus: "idle",
	});
	useListenStore.setState({ isListening: false, deviceName: "", devices: [] });
	useDownloadStore.setState({ isDownloading: false, modelName: null });
	// The footer model picker is now the full `SttModelSelector`. Seed the
	// catalog so the trigger can resolve the selected model to a card
	// instead of falling back to its placeholder.
	useCatalogStore.setState({ models: CATALOG, isLoaded: true });
	// Reset the swap store — leftover `activeMain` from the model-swap-store
	// tests would otherwise flip the trigger into its switching view. NOTE: this
	// reset holds until render. In the FULL suite a LEAKED, never-unmounted
	// `useSyncActiveModel` fiber (the preload's global afterEach brute-clears
	// <body> but never React-unmounts roots, so a prior file's hook stays
	// subscribed to the shared settings store) re-fires its effect when a test
	// here changes `settings.model`, calling `beginSwap("main", prev, next)` and
	// re-populating `activeMain` DURING render. The size-free test below clears
	// that phantom after render so the footer settles on the steady-state chip.
	useModelSwapStore.setState({
		activeMain: null,
		activeRealtime: null,
		fromMain: null,
		fromRealtime: null,
	});
	// Empty model-state map so the swap gate sees no cached/uncached entry
	// and hot-swaps directly instead of raising the download dialog.
	useModelStateStore.setState({ statesById: {} });
});

afterEach(() => {
	useSettingsStore.setState({ settings: initialSettings });
});

describe("StatusBar", () => {
	test("renders the connection indicator and a hotkey display in PTT mode", () => {
		render(
			<IntlProvider>
				<StatusBar />
			</IntlProvider>,
		);
		expect(screen.getByRole("status")).toBeDefined();
	});

	test("renders the loopback device name in listen mode when listening", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, recordingMode: "listen" },
			},
		});
		useListenStore.setState({
			isListening: true,
			deviceName: "LG TV (HDMI) [Loopback]",
		});
		render(
			<IntlProvider>
				<StatusBar />
			</IntlProvider>,
		);
		// shortDeviceName strips parens/brackets
		expect(document.body.textContent).toContain("LG TV");
		expect(document.body.textContent).not.toContain("Loopback");
	});

	test("dims and disables interactivity when a model is downloading", () => {
		useDownloadStore.setState({ isDownloading: true });
		const { container } = render(
			<IntlProvider>
				<StatusBar />
			</IntlProvider>,
		);
		expect((container.firstElementChild as HTMLElement).className).toContain(
			"pointer-events-none",
		);
		expect((container.firstElementChild as HTMLElement).className).toContain(
			"opacity-50",
		);
	});

	test("renders the STT model picker trigger with the selected model", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				model: { ...initialSettings.model, model: "tiny" },
			},
		});
		const { container } = render(
			<IntlProvider>
				<StatusBar />
			</IntlProvider>,
		);
		expect(
			container.querySelector('[data-slot="stt-model-selector-trigger"]'),
		).not.toBeNull();
		// The picker's trigger renders the currently-selected model's name.
		expect(screen.getByText("tiny")).toBeDefined();
	});

	test("shows the size-free variant name in the footer, not the raw id or param count", () => {
		const canary: ModelInfo = {
			...model("nemo-canary-180m-flash"),
			displayName: "NeMo Canary 180M Flash",
			family: "nemo",
		};
		useCatalogStore.setState({ models: [...CATALOG, canary], isLoaded: true });
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				model: { ...initialSettings.model, model: "nemo-canary-180m-flash" },
			},
		});
		render(
			<IntlProvider>
				<StatusBar />
			</IntlProvider>,
		);
		// A leaked `useSyncActiveModel` (see beforeEach note) may have flipped the
		// swap store to `activeMain: "nemo-canary-180m-flash"` during this render,
		// which paints the transient "Switching to Canary Flash..." swap chip
		// instead of the steady-state model chip. Clear the phantom and let
		// StatusBar re-render to the idle chip — the behaviour under test (the
		// footer resolves the SIZE-FREE variant NAME, not the raw id) is the same
		// either way; the leak just wrapped that name in spinner chrome. Alone (no
		// leak) this reset is a no-op (`activeMain` is already null).
		act(() => {
			useModelSwapStore.setState({ activeMain: null, fromMain: null });
		});
		// "NeMo Canary 180M Flash" → "Canary Flash": family prefix + "180M"
		// stripped so the always-visible footer matches the picker/settings tab.
		// The previous behaviour leaked the raw model id into the chip.
		expect(screen.getByText("Canary Flash")).toBeDefined();
		expect(screen.queryByText("nemo-canary-180m-flash")).toBeNull();
	});

	test("shows the swap transition in the picker trigger while a main-model swap is in flight", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				model: { ...initialSettings.model, model: "tiny" },
			},
		});
		useModelSwapStore.setState({
			activeMain: "large-v2",
			activeRealtime: null,
			fromMain: "tiny",
			fromRealtime: null,
		});
		render(
			<IntlProvider>
				<StatusBar />
			</IntlProvider>,
		);
		// Trigger resolves the target id against the catalog and renders the
		// `from → to` transition for the in-flight swap.
		expect(document.body.textContent).toContain("large-v2");
	});
});
