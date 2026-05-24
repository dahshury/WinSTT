import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { useVisualizerStore } from "@/features/audio-visualizer";
import { useLlmProcessingStore } from "@/features/llm-processing";
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
	useTranscriptionStore.setState({
		currentRealtime: "",
		ephemeral: null,
		isRecordingActive: false,
	});
	useVisualizerStore.setState({ isSpeaking: false });
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
	useTranscriptionStore.setState({
		currentRealtime: "",
		ephemeral: null,
		isRecordingActive: false,
	});
	useVisualizerStore.setState({ isSpeaking: false });
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
		// The bubble (.rounded-2xl) wraps a <p> for transcription text via
		// ScrollingText. Querying ".rounded-2xl p" matches that text node
		// when the bubble is mounted, and stays null whenever the bubble
		// itself is hidden — both the presence-test and absence-test paths
		// the old `.line-clamp-5` selector covered.
		const textDiv = container.querySelector(".rounded-2xl p");
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

	test("does NOT pre-mount the pill on VAD-only — waits for the first transcription chunk", () => {
		// VAD pre-mount was deliberately removed (see `showPill` comment in
		// OverlayPage). Even with the recording armed AND VAD reporting
		// speech, the pill stays hidden until the realtime model emits its
		// first token — so the pill lands on the same paint as the first
		// word rather than flashing the visualizer hundreds of ms early.
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, liveTranscriptionDisplay: "both" },
			},
		});
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: true,
		});
		useVisualizerStore.setState({ isSpeaking: true });
		const { container } = renderOverlay();
		// Bubble (.rounded-2xl) and chip (.rounded-full) both stay hidden
		// — the pill mounts only on transcribed text or LLM thinking.
		expect(container.querySelector(".rounded-2xl")).toBeNull();
		expect(container.querySelector(".rounded-full")).toBeNull();
	});

	test("VAD-driven show still respects the isRecordingActive gate (stale isSpeaking can't flash an unarmed pill)", () => {
		// If a previous session left `isSpeaking=true` behind (e.g. an
		// abnormal stop that skipped `recordingStopped`), the pill must
		// still stay hidden until the next `recording_start` arms us.
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, liveTranscriptionDisplay: "both" },
			},
		});
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: false,
		});
		useVisualizerStore.setState({ isSpeaking: true });
		const { container } = renderOverlay();
		expect(container.querySelector(".rounded-2xl")).toBeNull();
	});

	test("shows the pill once realtime text arrives", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, liveTranscriptionDisplay: "both" },
			},
		});
		useTranscriptionStore.setState({
			currentRealtime: "spoken words",
			ephemeral: null,
			isRecordingActive: true,
		});
		const { container } = renderOverlay();
		const pill = container.querySelector(".rounded-2xl");
		expect(pill).not.toBeNull();
		useSettingsStore.setState({ settings: initialSettings });
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: false,
		});
	});

	test("hides the pill when realtime text is set but isRecordingActive is false (stale from prior session)", () => {
		// Repro of the bug: between sessions, the renderer may still hold
		// realtime/ephemeral text from the previous press. When the overlay
		// BrowserWindow becomes visible for the next PTT press, the first
		// paint runs before STT_RECORDING_START arrives — so the gate must
		// hide the pill until that event re-arms it.
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, liveTranscriptionDisplay: "both" },
			},
		});
		useTranscriptionStore.setState({
			currentRealtime: "previous session text",
			ephemeral: { text: "no audio detected", timestamp: 0 },
			isRecordingActive: false,
		});
		const { container } = renderOverlay();
		expect(container.querySelector(".rounded-2xl")).toBeNull();
	});

	test("shows transcription text when realtime is set and liveTranscriptionDisplay includes the pill", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, liveTranscriptionDisplay: "in-pill" },
			},
		});
		useTranscriptionStore.setState({
			currentRealtime: "hello world",
			ephemeral: null,
			isRecordingActive: true,
		});
		const { container } = renderOverlay();
		// The bubble (.rounded-2xl) wraps a <p> for transcription text via
		// ScrollingText. Querying ".rounded-2xl p" matches that text node
		// when the bubble is mounted, and stays null whenever the bubble
		// itself is hidden — both the presence-test and absence-test paths
		// the old `.line-clamp-5` selector covered.
		const textDiv = container.querySelector(".rounded-2xl p");
		expect(textDiv?.textContent).toContain("hello world");
		useSettingsStore.setState({ settings: initialSettings });
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: false,
		});
	});

	test("does not show text when liveTranscriptionDisplay is 'in-app' only", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, liveTranscriptionDisplay: "in-app" },
			},
		});
		useTranscriptionStore.setState({
			currentRealtime: "should be hidden",
			ephemeral: null,
			isRecordingActive: true,
		});
		const { container } = renderOverlay();
		// The bubble (.rounded-2xl) wraps a <p> for transcription text via
		// ScrollingText. Querying ".rounded-2xl p" matches that text node
		// when the bubble is mounted, and stays null whenever the bubble
		// itself is hidden — both the presence-test and absence-test paths
		// the old `.line-clamp-5` selector covered.
		const textDiv = container.querySelector(".rounded-2xl p");
		expect(textDiv).toBeNull();
		useSettingsStore.setState({ settings: initialSettings });
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: false,
		});
	});

	test("does not show text when liveTranscriptionDisplay is 'none'", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, liveTranscriptionDisplay: "none" },
			},
		});
		useTranscriptionStore.setState({
			currentRealtime: "should be hidden",
			ephemeral: null,
			isRecordingActive: true,
		});
		const { container } = renderOverlay();
		// The bubble (.rounded-2xl) wraps a <p> for transcription text via
		// ScrollingText. Querying ".rounded-2xl p" matches that text node
		// when the bubble is mounted, and stays null whenever the bubble
		// itself is hidden — both the presence-test and absence-test paths
		// the old `.line-clamp-5` selector covered.
		const textDiv = container.querySelector(".rounded-2xl p");
		expect(textDiv).toBeNull();
		useSettingsStore.setState({ settings: initialSettings });
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: false,
		});
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
				isRecordingActive: true,
			});
		});
		// The bubble (.rounded-2xl) wraps a <p> for transcription text via
		// ScrollingText. Querying ".rounded-2xl p" matches that text node
		// when the bubble is mounted, and stays null whenever the bubble
		// itself is hidden — both the presence-test and absence-test paths
		// the old `.line-clamp-5` selector covered.
		const textDiv = container.querySelector(".rounded-2xl p");
		expect(textDiv?.textContent).toContain("ephemeral preview");
		useSettingsStore.setState({ settings: initialSettings });
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: false,
		});
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
		useTranscriptionStore.setState({
			currentRealtime: "rendering",
			ephemeral: null,
			isRecordingActive: true,
		});
		const { container } = renderOverlay();
		const zoomDiv = container.querySelector("[style*='zoom']");
		expect(zoomDiv).not.toBeNull();
		useSettingsStore.setState({ settings: initialSettings });
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: false,
		});
	});

	test("visibilitychange to 'visible' synchronously clears stale transcription + LLM + speaking state", () => {
		renderOverlay();
		// Simulate stale state left over from a prior session (the exact
		// scenario the user reported: previous transcription still in
		// currentRealtime / ephemeral when the overlay BrowserWindow re-shows).
		// `isSpeaking` joins the reset because the pill now keys off VAD
		// detection — a stale `true` would flash the visualizer on re-show.
		act(() => {
			useTranscriptionStore.setState({
				currentRealtime: "previous session text",
				ephemeral: { text: "no audio detected", timestamp: 0 },
				isRecordingActive: false,
			});
			useLlmProcessingStore.setState({ isThinking: true });
			useVisualizerStore.setState({ isSpeaking: true });
		});
		// Happy-dom defaults visibilityState to "visible"; the handler reads
		// `document.visibilityState`, so dispatching the event after stale
		// state is in place exercises the reset path.
		act(() => {
			document.dispatchEvent(new Event("visibilitychange"));
		});
		const t = useTranscriptionStore.getState();
		expect(t.currentRealtime).toBe("");
		expect(t.ephemeral).toBeNull();
		expect(t.isRecordingActive).toBe(false);
		expect(useLlmProcessingStore.getState().isThinking).toBe(false);
		expect(useVisualizerStore.getState().isSpeaking).toBe(false);
	});

	test("visibilitychange to 'hidden' does NOT clear state (only the visible transition resets)", () => {
		renderOverlay();
		act(() => {
			useTranscriptionStore.setState({
				currentRealtime: "still in flight",
				ephemeral: null,
				isRecordingActive: true,
			});
		});
		// Flip happy-dom's visibilityState to hidden so the handler's guard
		// short-circuits — state must be left untouched.
		const originalDescriptor = Object.getOwnPropertyDescriptor(
			Document.prototype,
			"visibilityState"
		);
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => "hidden",
		});
		try {
			act(() => {
				document.dispatchEvent(new Event("visibilitychange"));
			});
			const t = useTranscriptionStore.getState();
			expect(t.currentRealtime).toBe("still in flight");
			expect(t.isRecordingActive).toBe(true);
		} finally {
			if (originalDescriptor) {
				Object.defineProperty(document, "visibilityState", originalDescriptor);
			} else {
				// happy-dom's default is on the instance, not the prototype —
				// delete the temporary override so subsequent tests get the
				// default "visible" value back.
				Reflect.deleteProperty(document, "visibilityState");
			}
		}
	});
});
