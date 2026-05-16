import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { OverlayPage } from "./OverlayPage";

// Pristine schema defaults, NOT a live `getState()` snapshot: sibling suites
// mutate the global `useSettingsStore` and module-eval order isn't isolated,
// so an import-time snapshot can capture another suite's polluted state.
const initialSettings = structuredClone(DEFAULT_SETTINGS);

function renderOverlay() {
	return render(
		<IntlProvider>
			<OverlayPage />
		</IntlProvider>
	);
}

// OverlayPage's `useTranscriptionFeed` subscribes to STT events through the
// real ipc-client, which routes through `window.electronAPI`. A sibling suite
// that swaps in an instrumented `window.electronAPI` and forgets to restore it
// can make `onRecordingStart` fire on mount here, whose handler clears the
// ephemeral text this suite just set — wiping the pill before we assert.
// Pin an inert electronAPI (and a clean transcription store) before each test.
const originalElectronApi = window.electronAPI;
const inertElectronApi: typeof window.electronAPI = {
	getPathForFile: () => "",
	send: () => undefined,
	invoke: () => Promise.resolve(undefined),
	secureInvoke: () => Promise.resolve(undefined),
	on: () => () => undefined,
};

beforeEach(() => {
	window.electronAPI = inertElectronApi;
	useTranscriptionStore.setState({ currentRealtime: "", ephemeral: null });
	useSettingsStore.setState({ settings: structuredClone(initialSettings) });
});

afterEach(() => {
	// Unmount every tree this suite rendered. Without this, each render's
	// `useTranscriptionFeed` subscription stays live on the shared
	// window.electronAPI; a leaked STT_RECORDING_START from a polluting
	// sibling then fires `clearEphemeral()` on a stale subscription and
	// wipes the ephemeral state a later test just set.
	cleanup();
	window.electronAPI = originalElectronApi;
	useTranscriptionStore.setState({ currentRealtime: "", ephemeral: null });
	useSettingsStore.setState({ settings: structuredClone(initialSettings) });
});

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

	test("hides the pill entirely during silent recording (no text, no thinking)", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, liveTranscriptionDisplay: "both" },
			},
		});
		useTranscriptionStore.setState({ currentRealtime: "", ephemeral: null });
		const { container } = renderOverlay();
		// The rounded-2xl pill wrapper should not be present when there is
		// no transcription content to display.
		const pill = container.querySelector(".rounded-2xl");
		expect(pill).toBeNull();
		useSettingsStore.setState({ settings: initialSettings });
	});

	test("shows the pill once realtime text arrives", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, liveTranscriptionDisplay: "both" },
			},
		});
		useTranscriptionStore.setState({ currentRealtime: "spoken words", ephemeral: null });
		const { container } = renderOverlay();
		const pill = container.querySelector(".rounded-2xl");
		expect(pill).not.toBeNull();
		useSettingsStore.setState({ settings: initialSettings });
		useTranscriptionStore.setState({ currentRealtime: "", ephemeral: null });
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
		const { container } = renderOverlay();
		// Set the ephemeral state AFTER mount. On subscribe, OverlayPage's
		// `useTranscriptionFeed` registers an STT_RECORDING_START handler that
		// calls `clearEphemeral()`; in a polluted full-suite run a leaked
		// recording-start event fires it on mount and wipes any pre-set
		// ephemeral. Setting it post-mount means no further event can clear it.
		act(() => {
			useTranscriptionStore.setState({
				currentRealtime: "",
				ephemeral: { text: "ephemeral preview", timestamp: 0 },
			});
		});
		const textDiv = container.querySelector(".line-clamp-5");
		expect(textDiv?.textContent).toContain("ephemeral preview");
		useSettingsStore.setState({ settings: initialSettings });
		useTranscriptionStore.setState({ currentRealtime: "", ephemeral: null });
	});

	test("applies correct zoom factor for different size presets", () => {
		// Test that the visualizer container style has a zoom property.
		// Pill is gated on transcription content, so set realtime text to
		// force render — otherwise the silent-recording branch hides the pill.
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					visualizerSize: "xl",
					liveTranscriptionDisplay: "in-pill",
				},
			},
		});
		useTranscriptionStore.setState({ currentRealtime: "rendering", ephemeral: null });
		const { container } = renderOverlay();
		const zoomDiv = container.querySelector("[style*='zoom']");
		expect(zoomDiv).not.toBeNull();
		useSettingsStore.setState({ settings: initialSettings });
		useTranscriptionStore.setState({ currentRealtime: "", ephemeral: null });
	});
});
