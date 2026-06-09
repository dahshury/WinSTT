import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { useVisualizerStore } from "@/features/audio-visualizer";
import { useLlmProcessingStore } from "@/features/llm-processing";
import { useTranscriptPreviewStore } from "@/features/transcript-preview";
import { useTtsPlaybackStore } from "../model/tts-playback-store";
import { OverlayPage } from "./OverlayPage";

// Pristine schema defaults, NOT a live `getState()` snapshot: sibling suites
// mutate the global `useSettingsStore` and module-eval order isn't isolated,
// so an import-time snapshot can capture another suite's polluted state.
const initialSettings = structuredClone(DEFAULT_SETTINGS);

function renderOverlay() {
	return render(
		<IntlProvider>
			<OverlayPage />
		</IntlProvider>,
	);
}

// OverlayPage's `useTranscriptionFeed` subscribes to STT events through the
// real ipc-client, which routes through `window.nativeBridge`. A sibling suite
// that swaps in an instrumented `window.nativeBridge` and forgets to restore it
// can make `onRecordingStart` fire on mount here, whose handler clears the
// ephemeral text this suite just set — wiping the pill before we assert.
// Pin an inert nativeBridge (and a clean transcription store) before each test.
const originalNativeBridge = window.nativeBridge;
const inertNativeBridge: typeof window.nativeBridge = {
	getPathForFile: () => "",
	send: () => undefined,
	invoke: () => Promise.resolve(undefined),
	secureInvoke: () => Promise.resolve(undefined),
	on: () => () => undefined,
};

beforeEach(() => {
	window.nativeBridge = inertNativeBridge;
	useTranscriptionStore.setState({
		currentRealtime: "",
		ephemeral: null,
		isRecordingActive: false,
		isTranscribing: false,
		processingPhase: null,
		recordingSessionId: 0,
		transcribingStartedAt: null,
	});
	useLlmProcessingStore.setState({
		isThinking: false,
		isTransforming: false,
		thinkingStartedAt: null,
		thinkingText: "",
		transformStartedAt: null,
	});
	useVisualizerStore.setState({ isSpeaking: false });
	useTtsPlaybackStore.setState({
		status: "idle",
		requestId: null,
		error: null,
	});
	useTranscriptPreviewStore.getState().reset();
	useSettingsStore.setState({ settings: structuredClone(initialSettings) });
});

afterEach(() => {
	// Unmount every tree this suite rendered. Without this, each render's
	// `useTranscriptionFeed` subscription stays live on the shared
	// window.nativeBridge; a leaked STT_RECORDING_START from a polluting
	// sibling then fires `clearEphemeral()` on a stale subscription and
	// wipes the ephemeral state a later test just set.
	cleanup();
	window.nativeBridge = originalNativeBridge;
	useTranscriptionStore.setState({
		currentRealtime: "",
		ephemeral: null,
		isRecordingActive: false,
		isTranscribing: false,
		processingPhase: null,
		recordingSessionId: 0,
		transcribingStartedAt: null,
	});
	useLlmProcessingStore.setState({
		isThinking: false,
		isTransforming: false,
		thinkingStartedAt: null,
		thinkingText: "",
		transformStartedAt: null,
	});
	useVisualizerStore.setState({ isSpeaking: false });
	useTtsPlaybackStore.setState({
		status: "idle",
		requestId: null,
		error: null,
	});
	useTranscriptPreviewStore.getState().reset();
	useSettingsStore.setState({ settings: structuredClone(initialSettings) });
});

describe("OverlayPage", () => {
	test("renders without crashing", () => {
		const { container } = renderOverlay();
		expect(container).not.toBeNull();
	});

	test("shows the editable preview pill in floating-bottom mode", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					overlayMode: "floating-bottom",
				},
			},
		});
		// original === text → the entry "edit" view with the editable transcript
		// (an auto-enhanced transcript would open straight into the diff instead).
		useTranscriptPreviewStore
			.getState()
			.open({ original: "preview draft", text: "preview draft" });
		const { container } = renderOverlay();
		const textarea = container.querySelector(
			"textarea",
		) as HTMLTextAreaElement | null;
		expect(textarea?.value).toBe("preview draft");
		expect(textarea?.readOnly).toBe(false);
		expect(textarea?.closest(".t-resize")).not.toBeNull();
	});

	test("disables AI enhance while post-processing is off", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				llm: {
					...initialSettings.llm,
					dictation: {
						...initialSettings.llm.dictation,
						enabled: false,
						model: "llama3.2",
						provider: "ollama",
					},
				},
			},
		});
		useTranscriptPreviewStore
			.getState()
			.open({ original: "preview draft", text: "preview draft" });
		const { getByRole } = renderOverlay();
		const enhanceButton = getByRole("button", {
			name: /enhance with ai/i,
		}) as HTMLButtonElement;
		expect(enhanceButton.disabled).toBe(true);
	});

	test("enables AI enhance when post-processing is on and a model is configured", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				llm: {
					...initialSettings.llm,
					dictation: {
						...initialSettings.llm.dictation,
						enabled: true,
						model: "llama3.2",
						provider: "ollama",
					},
				},
			},
		});
		useTranscriptPreviewStore
			.getState()
			.open({ original: "preview draft", text: "preview draft" });
		const { getByRole } = renderOverlay();
		const enhanceButton = getByRole("button", {
			name: /enhance with ai/i,
		}) as HTMLButtonElement;
		expect(enhanceButton.disabled).toBe(false);
	});

	test("shows the editable preview pill in dynamic-island mode", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					overlayMode: "dynamic-island",
				},
			},
		});
		useTranscriptPreviewStore
			.getState()
			.open({ original: "preview draft", text: "preview draft" });
		const { container } = renderOverlay();
		const textarea = container.querySelector(
			"textarea",
		) as HTMLTextAreaElement | null;
		expect(textarea?.value).toBe("preview draft");
		expect(container.querySelector("#winstt-overlay-island")).not.toBeNull();
	});

	test("opens straight into the AI-edit diff when auto-enhanced", () => {
		// original !== text → the transcript was auto-enhanced before the preview
		// opened, so it lands in the enhance view with the diff shown immediately.
		// The ORIGINAL must stay visible (the user must not lose what they said).
		useTranscriptPreviewStore
			.getState()
			.open({ original: "raw transcript", text: "polished transcript" });
		const { container } = renderOverlay();
		expect(useTranscriptPreviewStore.getState().view).toBe("enhance");
		expect(container.textContent).toContain("raw");
	});

	test("edits the preview draft before confirm", () => {
		useTranscriptPreviewStore
			.getState()
			.open({ original: "preview draft", text: "preview draft" });
		const { container } = renderOverlay();
		const textarea = container.querySelector(
			"textarea",
		) as HTMLTextAreaElement | null;
		expect(textarea).not.toBeNull();
		fireEvent.change(textarea as HTMLTextAreaElement, {
			target: { value: "edited draft" },
		});
		expect(useTranscriptPreviewStore.getState().text).toBe("edited draft");
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
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "both",
					overlayMode: "floating-bottom",
				},
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

	test("VAD speech onset reveals the chip but NOT the caption bubble (bubble needs transcribed words)", () => {
		// Real VAD now reveals the recording CHIP on speech onset (snappy — see
		// `computePillReveal`, covered exhaustively in compute-pill-reveal.test).
		// The caption BUBBLE, however, still requires transcribed TEXT — VAD alone
		// (no words yet) must not flash an empty caption surface. That bubble-stays-
		// hidden invariant is what we assert here (the reliably-observable one;
		// motion's chip render is async in happy-dom).
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "both",
					overlayMode: "floating-bottom",
				},
			},
		});
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: true,
		});
		useVisualizerStore.setState({ isSpeaking: true });
		const { container } = renderOverlay();
		// Bubble (.rounded-2xl) wraps the caption <p>; with no transcribed text it
		// stays hidden even though VAD reveals the chip.
		expect(container.querySelector(".rounded-2xl p")).toBeNull();
	});

	test("VAD-driven show still respects the isRecordingActive gate (stale isSpeaking can't flash an unarmed pill)", () => {
		// If a previous session left `isSpeaking=true` behind (e.g. an
		// abnormal stop that skipped `recordingStopped`), the pill must
		// still stay hidden until the next `recording_start` arms us.
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "both",
				},
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
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "both",
					overlayMode: "floating-bottom",
				},
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

	test("shows a transcribing indicator during final decode with no realtime text", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "both",
					overlayMode: "floating-bottom",
				},
				llm: {
					...initialSettings.llm,
					dictation: {
						...initialSettings.llm.dictation,
						enabled: true,
						model: "llama3",
					},
				},
			},
		});
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: true,
			isTranscribing: true,
			processingPhase: "uploading",
			transcribingStartedAt: 100,
		});
		const { container } = renderOverlay();
		expect(container.textContent).toContain("Transcribing");
		expect(container.textContent).not.toContain("Uploading");
		expect(container.querySelector(".rounded-2xl")).not.toBeNull();
	});

	test("does not show a transcribing indicator for normal final decode without LLM cleanup", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "both",
				},
			},
		});
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: true,
			isTranscribing: true,
			transcribingStartedAt: 100,
		});
		const { container } = renderOverlay();
		expect(container.textContent).not.toContain("Transcribing");
		expect(
			container.querySelector(
				'[data-overlay-floating-surface="true"][data-processing="true"]',
			),
		).toBeNull();
	});

	test("shows an uploading indicator for cloud STT before transcription starts", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "both",
					overlayMode: "floating-bottom",
				},
				llm: {
					...initialSettings.llm,
					dictation: {
						...initialSettings.llm.dictation,
						enabled: false,
					},
				},
				model: {
					...initialSettings.model,
					model: "openrouter:openai/gpt-4o-transcribe",
				},
			},
		});
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: true,
			isTranscribing: true,
			processingPhase: "uploading",
			transcribingStartedAt: 100,
		});
		const { container } = renderOverlay();
		const surface = container.querySelector(
			'[data-overlay-floating-surface="true"][data-processing="true"]',
		);
		const output = surface?.querySelector("output");
		expect(surface).not.toBeNull();
		expect(output?.getAttribute("data-thinking-word")).toBe("Uploading");
		expect(output?.getAttribute("data-thinking-word")).not.toBe("Thinking");
	});

	test("keeps a transcribing indicator for cloud STT after upload handoff", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "both",
					overlayMode: "floating-bottom",
				},
				llm: {
					...initialSettings.llm,
					dictation: {
						...initialSettings.llm.dictation,
						enabled: false,
					},
				},
				model: {
					...initialSettings.model,
					model: "openrouter:openai/gpt-4o-transcribe",
				},
			},
		});
		useLlmProcessingStore.setState({
			isThinking: true,
			thinkingStartedAt: 200,
			thinkingText: "",
		});
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: true,
			isTranscribing: true,
			processingPhase: "transcribing",
			transcribingStartedAt: 100,
		});
		const { container } = renderOverlay();
		const output = container.querySelector(
			'[data-overlay-floating-surface="true"][data-processing="true"] output',
		);
		expect(output?.getAttribute("data-thinking-word")).toBe("Transcribing");
		expect(output?.getAttribute("data-thinking-word")).not.toBe("Thinking");
	});

	test("keeps the dynamic island on transcribing when dictation cleanup is off", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "both",
					overlayMode: "dynamic-island",
				},
				llm: {
					...initialSettings.llm,
					dictation: {
						...initialSettings.llm.dictation,
						enabled: false,
					},
				},
				model: {
					...initialSettings.model,
					model: "openrouter:openai/gpt-4o-transcribe",
				},
			},
		});
		useLlmProcessingStore.setState({
			isThinking: true,
			thinkingStartedAt: 200,
			thinkingText: "",
		});
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: true,
			isTranscribing: true,
			processingPhase: "transcribing",
			transcribingStartedAt: 100,
		});
		const { container } = renderOverlay();
		const output = container.querySelector(
			'[data-overlay-processing-content="true"] output',
		);
		expect(output?.getAttribute("data-thinking-word")).toBe("Transcribing");
		expect(output?.getAttribute("data-thinking-word")).not.toBe("Thinking");
	});

	test("renders processing inside the floating visualizer surface instead of a separate bubble", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "both",
					overlayMode: "floating-bottom",
				},
				llm: {
					...initialSettings.llm,
					dictation: {
						...initialSettings.llm.dictation,
						enabled: true,
						model: "llama3",
					},
				},
			},
		});
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: true,
			isTranscribing: true,
			transcribingStartedAt: 100,
		});
		const { container } = renderOverlay();
		const surface = container.querySelector(
			'[data-overlay-floating-surface="true"][data-processing="true"]',
		);
		expect(surface).not.toBeNull();
		expect(surface?.textContent).toContain("Transcribing");
		expect(
			container.querySelector('[data-overlay-floating-bubble="true"]'),
		).toBeNull();
	});

	test("dynamic island processing replaces the visualizer row", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "both",
					overlayMode: "dynamic-island",
				},
				llm: {
					...initialSettings.llm,
					dictation: {
						...initialSettings.llm.dictation,
						enabled: true,
						model: "llama3",
					},
				},
			},
		});
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: true,
			isTranscribing: true,
			transcribingStartedAt: 100,
		});
		const { container } = renderOverlay();
		const processing = container.querySelector(
			'[data-overlay-processing-content="true"]',
		);
		expect(processing).not.toBeNull();
		expect(processing?.textContent).toContain("Transcribing");
		expect(
			container.querySelector('[data-overlay-visualizer-row="true"]'),
		).toBeNull();
	});

	test("shows selected-text transform processing in the floating pill without the STT cancel button", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					overlayMode: "floating-bottom",
				},
			},
		});
		useLlmProcessingStore.setState({
			isTransforming: true,
			transformStartedAt: 100,
			thinkingText: "",
		});
		const { container, queryByRole } = renderOverlay();
		const surface = container.querySelector(
			'[data-overlay-floating-surface="true"][data-processing="true"][data-overlay-processing-kind="transform"]',
		);
		const output = surface?.querySelector("output");
		expect(surface).not.toBeNull();
		expect(output?.getAttribute("data-thinking-word")).toBe(
			"Transforming text",
		);
		expect(queryByRole("button", { name: /cancel transcription/i })).toBeNull();
	});

	test("shows selected-text transform processing in the dynamic island without the STT cancel button", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					overlayMode: "dynamic-island",
				},
			},
		});
		useLlmProcessingStore.setState({
			isTransforming: true,
			transformStartedAt: 100,
			thinkingText: "",
		});
		const { container, queryByRole } = renderOverlay();
		const island = container.querySelector("#winstt-overlay-island");
		const processing = container.querySelector(
			'[data-overlay-processing-content="true"][data-overlay-processing-kind="transform"]',
		);
		const output = processing?.querySelector("output");
		expect(island).not.toBeNull();
		expect(output?.getAttribute("data-thinking-word")).toBe(
			"Transforming text",
		);
		expect(queryByRole("button", { name: /cancel transcription/i })).toBeNull();
	});

	test("keeps the transform floating surface mounted while reasoning streams", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					overlayMode: "floating-bottom",
				},
			},
		});
		useLlmProcessingStore.setState({
			isTransforming: true,
			transformStartedAt: 100,
			thinkingText: "",
		});
		const { container } = renderOverlay();
		const surface = container.querySelector(
			'[data-overlay-floating-surface="true"][data-overlay-processing-kind="transform"]',
		);
		expect(surface).not.toBeNull();

		act(() => {
			useLlmProcessingStore.setState({
				thinkingText: "transform streamed reasoning",
			});
		});

		const surfaceAfter = container.querySelector(
			'[data-overlay-floating-surface="true"][data-overlay-processing-kind="transform"]',
		);
		expect(surfaceAfter).toBe(surface);
		expect(surfaceAfter?.textContent).toContain("transform streamed reasoning");
	});

	test("keeps the transform dynamic island mounted while reasoning streams", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					overlayMode: "dynamic-island",
				},
			},
		});
		useLlmProcessingStore.setState({
			isTransforming: true,
			transformStartedAt: 100,
			thinkingText: "",
		});
		const { container } = renderOverlay();
		const island = container.querySelector("#winstt-overlay-island");
		const panel = island?.parentElement;
		expect(island).not.toBeNull();

		act(() => {
			useLlmProcessingStore.setState({
				thinkingText: "dynamic transform streamed reasoning",
			});
		});

		const islandAfter = container.querySelector("#winstt-overlay-island");
		expect(islandAfter).toBe(island);
		expect(islandAfter?.parentElement).toBe(panel);
		expect(islandAfter?.textContent).toContain(
			"dynamic transform streamed reasoning",
		);
	});

	test("keeps the floating processing shell mounted from transcribing to thinking", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "both",
					overlayMode: "floating-bottom",
				},
				llm: {
					...initialSettings.llm,
					dictation: {
						...initialSettings.llm.dictation,
						enabled: true,
						model: "llama3",
					},
				},
			},
		});
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: true,
			isTranscribing: true,
			transcribingStartedAt: 100,
		});
		const { container } = renderOverlay();
		const surface = container.querySelector(
			'[data-overlay-floating-surface="true"][data-processing="true"]',
		);
		const output = surface?.querySelector("output");
		expect(output?.getAttribute("data-thinking-word")).toBe("Transcribing");

		act(() => {
			useTranscriptionStore.setState({
				isTranscribing: false,
			});
			useLlmProcessingStore.setState({
				isThinking: true,
				thinkingStartedAt: 200,
				thinkingText: "",
			});
		});

		const surfaceAfter = container.querySelector(
			'[data-overlay-floating-surface="true"][data-processing="true"]',
		);
		const outputAfter = surfaceAfter?.querySelector("output");
		expect(surfaceAfter).toBe(surface);
		expect(outputAfter).toBe(output);
		expect(outputAfter?.getAttribute("data-thinking-word")).toBe("Thinking");
	});

	test("keeps the dynamic island processing shell mounted from transcribing to thinking", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "both",
					overlayMode: "dynamic-island",
				},
				llm: {
					...initialSettings.llm,
					dictation: {
						...initialSettings.llm.dictation,
						enabled: true,
						model: "llama3",
					},
				},
			},
		});
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: true,
			isTranscribing: true,
			transcribingStartedAt: 100,
		});
		const { container } = renderOverlay();
		const island = container.querySelector("#winstt-overlay-island");
		const processing = container.querySelector(
			'[data-overlay-processing-content="true"]',
		);
		const output = processing?.querySelector("output");
		expect(output?.getAttribute("data-thinking-word")).toBe("Transcribing");

		act(() => {
			useTranscriptionStore.setState({
				isTranscribing: false,
			});
			useLlmProcessingStore.setState({
				isThinking: true,
				thinkingStartedAt: 200,
				thinkingText: "",
			});
		});

		const islandAfter = container.querySelector("#winstt-overlay-island");
		const processingAfter = container.querySelector(
			'[data-overlay-processing-content="true"]',
		);
		const outputAfter = processingAfter?.querySelector("output");
		expect(islandAfter).toBe(island);
		expect(processingAfter).toBe(processing);
		expect(outputAfter).toBe(output);
		expect(outputAfter?.getAttribute("data-thinking-word")).toBe("Thinking");
	});

	test("keeps the floating processing surface mounted while thinking text streams", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					overlayMode: "floating-bottom",
				},
				llm: {
					...initialSettings.llm,
					dictation: {
						...initialSettings.llm.dictation,
						enabled: true,
						model: "llama3",
					},
				},
			},
		});
		useLlmProcessingStore.setState({
			isThinking: true,
			thinkingStartedAt: 100,
			thinkingText: "",
		});
		const { container } = renderOverlay();
		const surface = container.querySelector(
			'[data-overlay-floating-surface="true"][data-processing="true"]',
		);
		expect(surface).not.toBeNull();

		act(() => {
			useLlmProcessingStore.setState({
				thinkingText: "first streamed reasoning chunk",
			});
		});

		const surfaceAfter = container.querySelector(
			'[data-overlay-floating-surface="true"][data-processing="true"]',
		);
		expect(surfaceAfter).toBe(surface);
		expect(surfaceAfter?.textContent).toContain(
			"first streamed reasoning chunk",
		);
		expect((surfaceAfter as HTMLElement).style.transition).not.toContain(
			"opacity",
		);
	});

	test("keeps the dynamic island shell mounted while thinking text streams", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					overlayMode: "dynamic-island",
				},
				llm: {
					...initialSettings.llm,
					dictation: {
						...initialSettings.llm.dictation,
						enabled: true,
						model: "llama3",
					},
				},
			},
		});
		useLlmProcessingStore.setState({
			isThinking: true,
			thinkingStartedAt: 100,
			thinkingText: "",
		});
		const { container } = renderOverlay();
		const island = container.querySelector("#winstt-overlay-island");
		const panel = island?.parentElement;
		expect(island).not.toBeNull();
		expect(panel?.classList.contains("t-panel-slide-top")).toBe(true);

		act(() => {
			useLlmProcessingStore.setState({
				thinkingText: "dynamic island streamed reasoning",
			});
		});

		const islandAfter = container.querySelector("#winstt-overlay-island");
		expect(islandAfter).toBe(island);
		expect(islandAfter?.parentElement).toBe(panel);
		expect(islandAfter?.textContent).toContain(
			"dynamic island streamed reasoning",
		);
	});

	test("keeps rotating vocabulary enabled in the overlay thinking state", () => {
		const originalSetInterval = globalThis.setInterval;
		const intervalDelays: number[] = [];
		const passthroughSetInterval = originalSetInterval as unknown as (
			...args: unknown[]
		) => ReturnType<typeof setInterval>;
		globalThis.setInterval = ((...args: unknown[]) => {
			const delay = args[1];
			if (typeof delay === "number") {
				intervalDelays.push(delay);
			}
			return passthroughSetInterval(...args);
		}) as typeof globalThis.setInterval;
		try {
			useSettingsStore.setState({
				settings: {
					...initialSettings,
					llm: {
						...initialSettings.llm,
						dictation: {
							...initialSettings.llm.dictation,
							enabled: true,
							model: "llama3",
						},
					},
				},
			});
			useLlmProcessingStore.setState({
				isThinking: true,
				thinkingStartedAt: 100,
				thinkingText: "",
			});
			const { container } = renderOverlay();
			expect(container.textContent).toContain("Thinking");
			expect(intervalDelays).toContain(4000);
		} finally {
			globalThis.setInterval = originalSetInterval;
		}
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
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "both",
				},
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
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "in-pill",
					overlayMode: "floating-bottom",
				},
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

	test("shows pill text during word-by-word paste when using a separate realtime model", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "in-pill",
					overlayMode: "floating-bottom",
					wordByWordPasting: true,
				},
				model: {
					...initialSettings.model,
					model: "offline-main",
					realtimeModel: "native-stream",
				},
				quality: {
					...initialSettings.quality,
					useMainModelForRealtime: false,
				},
			},
		});
		useTranscriptionStore.setState({
			currentRealtime: "streamed separately",
			ephemeral: null,
			isRecordingActive: true,
		});
		const { container } = renderOverlay();
		expect(container.querySelector(".rounded-2xl p")?.textContent).toContain(
			"streamed separately",
		);
		useSettingsStore.setState({ settings: initialSettings });
		useTranscriptionStore.setState({
			currentRealtime: "",
			ephemeral: null,
			isRecordingActive: false,
		});
	});

	test("does not show pill text while word-by-word paste reuses the main realtime model", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "in-pill",
					wordByWordPasting: true,
				},
				model: {
					...initialSettings.model,
					model: "native-stream",
					realtimeModel: "native-stream",
				},
				quality: {
					...initialSettings.quality,
					useMainModelForRealtime: true,
				},
			},
		});
		useTranscriptionStore.setState({
			currentRealtime: "streamed but hidden",
			ephemeral: null,
			isRecordingActive: true,
		});
		const { container } = renderOverlay();
		expect(container.querySelector(".rounded-2xl p")).toBeNull();
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
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "in-app",
				},
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
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "none",
				},
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
				general: {
					...initialSettings.general,
					liveTranscriptionDisplay: "both",
					overlayMode: "floating-bottom",
				},
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

	test("visibilitychange to 'visible' clears stale content but does NOT clobber a freshly-armed isRecordingActive", () => {
		renderOverlay();
		// Regression guard: the main process sends STT_RECORDING_START *before*
		// it shows the overlay window (see runAdmittedRecordingStart in
		// the reference ipc/relay.ts), so the renderer usually arms
		// `isRecordingActive = true` BEFORE `visibilitychange` fires. The reset
		// must wipe the previous session's text / thinking / speaking state
		// WITHOUT disarming the flag — otherwise the pill never appears for the
		// session (realtime-text events only update text, never re-arm).
		// `isSpeaking` joins the reset because the pill keys off VAD detection —
		// a stale `true` would flash the visualizer on re-show.
		act(() => {
			useTranscriptionStore.setState({
				currentRealtime: "previous session text",
				ephemeral: { text: "no audio detected", timestamp: 0 },
				isRecordingActive: true,
				isTranscribing: true,
				processingPhase: "uploading",
				transcribingStartedAt: 100,
			});
			useLlmProcessingStore.setState({
				isThinking: true,
				isTransforming: true,
				transformStartedAt: 100,
			});
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
		// NOT clobbered — the arming IPC's value survives the content reset.
		expect(t.isRecordingActive).toBe(true);
		expect(t.isTranscribing).toBe(false);
		expect(t.processingPhase).toBeNull();
		expect(t.transcribingStartedAt).toBeNull();
		expect(useLlmProcessingStore.getState().isThinking).toBe(false);
		expect(useLlmProcessingStore.getState().isTransforming).toBe(false);
		expect(useLlmProcessingStore.getState().transformStartedAt).toBeNull();
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
			"visibilityState",
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

	test("dynamic island exposes the cancel transcription button while STT is visible", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					overlayMode: "dynamic-island",
					liveTranscriptionDisplay: "both",
				},
			},
		});
		useTranscriptionStore.setState({
			currentRealtime: "dictating",
			ephemeral: null,
			isRecordingActive: true,
		});
		const { getByRole } = renderOverlay();
		expect(
			getByRole("button", { name: /cancel transcription/i }),
		).not.toBeNull();
	});

	test("keeps TTS in the island and forces STT to the floating pill during overlap", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					overlayMode: "dynamic-island",
					liveTranscriptionDisplay: "both",
				},
			},
		});
		useTtsPlaybackStore.setState({
			status: "speaking",
			requestId: "tts-1",
			error: null,
		});
		useTranscriptionStore.setState({
			currentRealtime: "dictating over paused read aloud",
			ephemeral: null,
			isRecordingActive: true,
		});

		const { container, getByRole } = renderOverlay();

		expect(useTtsPlaybackStore.getState().status).toBe("paused");
		expect(container.querySelector("#winstt-tts-island")).not.toBeNull();
		expect(container.querySelector("#winstt-overlay-island")).toBeNull();
		expect(
			getByRole("button", { name: /cancel transcription/i }),
		).not.toBeNull();
	});

	test("TTS island speed control renders a readable ASCII rate label", () => {
		act(() => {
			useTtsPlaybackStore.setState({
				status: "speaking",
				requestId: "tts-1",
				error: null,
			});
		});
		const { getByRole } = renderOverlay();
		const speed = getByRole("button", { name: /reading speed 1x/i });
		expect(speed.textContent).toBe("1x");
		expect(speed.textContent).not.toContain("Ã");
	});
});
