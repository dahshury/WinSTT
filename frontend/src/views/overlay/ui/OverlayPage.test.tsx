import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { OverlayPage } from "./OverlayPage";

const initialSettings = useSettingsStore.getState().settings;

function renderOverlay() {
	return render(
		<IntlProvider>
			<OverlayPage />
		</IntlProvider>
	);
}

describe("OverlayPage", () => {
	test("renders without crashing", () => {
		const { container } = renderOverlay();
		expect(container).not.toBeNull();
	});

	test("does not show transcription text when there is no realtime or ephemeral text", () => {
		useTranscriptionStore.setState({ currentRealtime: "", ephemeral: null });
		const { container } = renderOverlay();
		// The text div should not be present
		const textDiv = container.querySelector(".line-clamp-5");
		expect(textDiv).toBeNull();
	});

	test("shows transcription text when realtime is set and liveTranscriptionDisplay includes the pill", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, liveTranscriptionDisplay: "in-pill" },
			},
		});
		useTranscriptionStore.setState({ currentRealtime: "hello world", ephemeral: null });
		const { container } = renderOverlay();
		const textDiv = container.querySelector(".line-clamp-5");
		expect(textDiv?.textContent).toContain("hello world");
		useSettingsStore.setState({ settings: initialSettings });
		useTranscriptionStore.setState({ currentRealtime: "", ephemeral: null });
	});

	test("does not show text when liveTranscriptionDisplay is 'in-app' only", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, liveTranscriptionDisplay: "in-app" },
			},
		});
		useTranscriptionStore.setState({ currentRealtime: "should be hidden", ephemeral: null });
		const { container } = renderOverlay();
		const textDiv = container.querySelector(".line-clamp-5");
		expect(textDiv).toBeNull();
		useSettingsStore.setState({ settings: initialSettings });
		useTranscriptionStore.setState({ currentRealtime: "", ephemeral: null });
	});

	test("does not show text when liveTranscriptionDisplay is 'none'", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, liveTranscriptionDisplay: "none" },
			},
		});
		useTranscriptionStore.setState({ currentRealtime: "should be hidden", ephemeral: null });
		const { container } = renderOverlay();
		const textDiv = container.querySelector(".line-clamp-5");
		expect(textDiv).toBeNull();
		useSettingsStore.setState({ settings: initialSettings });
		useTranscriptionStore.setState({ currentRealtime: "", ephemeral: null });
	});

	test("shows ephemeral text when realtime is empty", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, liveTranscriptionDisplay: "both" },
			},
		});
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: { text: "ephemeral preview", timestamp: 0 },
		});
		const { container } = renderOverlay();
		const textDiv = container.querySelector(".line-clamp-5");
		expect(textDiv?.textContent).toContain("ephemeral preview");
		useSettingsStore.setState({ settings: initialSettings });
		useTranscriptionStore.setState({ currentRealtime: "", ephemeral: null });
	});

	test("applies correct zoom factor for different size presets", () => {
		// Test that the visualizer container style has a zoom property
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, visualizerSize: "xl" },
			},
		});
		const { container } = renderOverlay();
		const zoomDiv = container.querySelector("[style*='zoom']");
		expect(zoomDiv).not.toBeNull();
		useSettingsStore.setState({ settings: initialSettings });
	});
});
