import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { useLlmProcessingStore } from "@/features/llm-processing";
import { TranscriptionThinking } from "./TranscriptionThinking";

const initialSettings = structuredClone(DEFAULT_SETTINGS);

beforeEach(() => {
	useSettingsStore.setState({ settings: structuredClone(initialSettings) });
	useTranscriptionStore.setState({
		currentRealtime: "",
		ephemeral: null,
		isRecordingActive: false,
		isTranscribing: false,
		items: [],
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
});

afterEach(() => {
	cleanup();
});

describe("TranscriptionThinking", () => {
	test("stays hidden for local STT when dictation cleanup is off", () => {
		useTranscriptionStore.setState({
			isTranscribing: true,
			transcribingStartedAt: 100,
		});
		const { container } = render(<TranscriptionThinking />);
		expect(container.querySelector("output")).toBeNull();
	});

	test("shows Uploading for cloud STT before transcription starts", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
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
			isTranscribing: true,
			processingPhase: "uploading",
			transcribingStartedAt: 100,
		});
		const { container } = render(<TranscriptionThinking />);
		expect(
			container.querySelector("output")?.getAttribute("data-thinking-word"),
		).toBe("Uploading");
	});

	test("shows Transcribing for cloud STT after upload handoff", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
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
			isTranscribing: true,
			processingPhase: "transcribing",
			transcribingStartedAt: 100,
		});
		useLlmProcessingStore.setState({
			isThinking: true,
			thinkingStartedAt: 200,
			thinkingText: "",
		});
		const { container } = render(<TranscriptionThinking />);
		expect(
			container.querySelector("output")?.getAttribute("data-thinking-word"),
		).toBe("Transcribing");
	});

	test("shows Thinking while configured dictation cleanup is active", () => {
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
		const { container } = render(<TranscriptionThinking />);
		expect(
			container.querySelector("output")?.getAttribute("data-thinking-word"),
		).toBe("Thinking");
	});
});
