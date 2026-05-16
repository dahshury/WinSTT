import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useConnectionStore } from "@/entities/connection";
import { useCatalogStore } from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { useListenStore } from "@/features/listen-mode";
import { useDownloadStore } from "@/features/model-download";
import { StatusBar } from "./StatusBar";

const initialSettings = useSettingsStore.getState().settings;

beforeEach(() => {
	useSettingsStore.setState({ settings: initialSettings });
	useConnectionStore.setState({
		connectionStatus: "disconnected",
		gpuInfo: null,
		serverStatus: "idle",
	});
	useListenStore.setState({ isListening: false, deviceName: "", devices: [] });
	useDownloadStore.setState({ isDownloading: false, modelName: null });
	// Sibling suites (catalog-store / model-state-store) populate this global
	// Zustand store and never reset it. Force the empty initial state so the
	// model menu deterministically falls back to WHISPER_MODELS here.
	useCatalogStore.setState({ models: [], isLoaded: false });
});

afterEach(() => {
	useSettingsStore.setState({ settings: initialSettings });
});

describe("StatusBar", () => {
	test("renders the connection indicator and a hotkey display in PTT mode", () => {
		render(
			<IntlProvider>
				<StatusBar />
			</IntlProvider>
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
		useListenStore.setState({ isListening: true, deviceName: "LG TV (HDMI) [Loopback]" });
		render(
			<IntlProvider>
				<StatusBar />
			</IntlProvider>
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
			</IntlProvider>
		);
		expect((container.firstElementChild as HTMLElement).className).toContain("pointer-events-none");
		expect((container.firstElementChild as HTMLElement).className).toContain("opacity-50");
	});

	test("renders the current model name when set in settings", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				model: { ...initialSettings.model, model: "tiny" },
			},
		});
		render(
			<IntlProvider>
				<StatusBar />
			</IntlProvider>
		);
		expect(screen.getByText("tiny")).toBeDefined();
	});

	test("clicking the model chip opens a menu with selectable model options", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				model: { ...initialSettings.model, model: "tiny" },
			},
		});
		render(
			<IntlProvider>
				<StatusBar />
			</IntlProvider>
		);
		const trigger = screen.getByRole("button", { name: /model/i });
		act(() => {
			fireEvent.click(trigger);
		});
		// Falls back to WHISPER_MODELS when the catalog is empty in tests.
		// "large-v2" is one of the fallback options and is not the current selection.
		expect(screen.getByRole("menuitemradio", { name: "large-v2" })).toBeDefined();
	});

	test("clicking a model option in the menu updates the settings store", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				model: { ...initialSettings.model, model: "tiny" },
			},
		});
		render(
			<IntlProvider>
				<StatusBar />
			</IntlProvider>
		);
		const trigger = screen.getByRole("button", { name: /model/i });
		act(() => {
			fireEvent.click(trigger);
		});
		const option = screen.getByRole("menuitemradio", { name: "large-v2" });
		act(() => {
			fireEvent.click(option);
		});
		expect(useSettingsStore.getState().settings.model.model).toBe("large-v2");
	});
});
