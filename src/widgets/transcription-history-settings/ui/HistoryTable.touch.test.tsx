import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { IPC } from "@test/mocks/legacy-ipc";
import type {
	TranscriptionHistoryEntry,
	TtsHistoryEntry,
} from "../model/history-store";
import type { HistoryTableItem } from "../model/history-table-types";
import { HistoryTable } from "./HistoryTable";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(
	globalThis.navigator,
	"clipboard",
);
const audioDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Audio");

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function transcriptionItem(entry: TranscriptionHistoryEntry): HistoryTableItem {
	return { entry, kind: "transcription" };
}

function transformItem(entry: TranscriptionHistoryEntry): HistoryTableItem {
	return { entry, kind: "transform" };
}

function ttsItem(entry: TtsHistoryEntry): HistoryTableItem {
	return {
		entry: {
			durationMs: 0,
			id: entry.id,
			text: entry.text,
			timestamp: entry.timestamp,
			wordCount: entry.wordCount,
		},
		kind: "tts",
		tts: entry,
	};
}

afterEach(() => {
	cleanup();
	if (clipboardDescriptor) {
		Object.defineProperty(
			globalThis.navigator,
			"clipboard",
			clipboardDescriptor,
		);
	} else {
		delete (globalThis.navigator as unknown as { clipboard?: Clipboard })
			.clipboard;
	}
	if (audioDescriptor) {
		Object.defineProperty(globalThis, "Audio", audioDescriptor);
	} else {
		delete (globalThis as unknown as { Audio?: typeof Audio }).Audio;
	}
});

describe("HistoryTable touch gestures", () => {
	test("copies a transcript when the transcript text is held on touch", async () => {
		const writeText = mock<(text: string) => Promise<void>>(() =>
			Promise.resolve(),
		);
		Object.defineProperty(globalThis.navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		const entry: TranscriptionHistoryEntry = {
			durationMs: 1200,
			id: "entry-1",
			text: "touch transcript copied from history",
			timestamp: Date.UTC(2026, 0, 1),
			wordCount: 5,
		};

		render(
			<IntlProvider>
				<HistoryTable entries={[transcriptionItem(entry)]} />
			</IntlProvider>,
		);

		const transcript = screen.getByText(entry.text);
		act(() => {
			fireEvent.pointerDown(transcript, {
				button: 0,
				clientX: 0,
				clientY: 0,
				pointerId: 1,
				pointerType: "touch",
			});
		});
		await act(async () => {
			await sleep(560);
		});

		expect(writeText).toHaveBeenCalledWith(entry.text);
	});
});

describe("HistoryTable LLM variant toggle", () => {
	test("shows a branded short label for a local Hugging Face Bonsai model", async () => {
		const rawModel = "hf.co/prism-ml/Bonsai-27B-gguf:Q1_0";
		const entry: TranscriptionHistoryEntry = {
			durationMs: 1200,
			id: "entry-bonsai",
			llmModel: rawModel,
			text: "Bonsai-cleaned transcript",
			timestamp: Date.UTC(2026, 0, 1),
			wordCount: 2,
		};

		render(
			<IntlProvider>
				<HistoryTable entries={[transcriptionItem(entry)]} />
			</IntlProvider>,
		);

		await screen.findByText("Bonsai-cleaned transcript");
		expect(screen.getByText("Bonsai 27B 1-bit")).not.toBeNull();
		expect(screen.queryByText(rawModel)).toBeNull();
		expect(screen.queryByRole("img", { name: "Cloud" })).toBeNull();
		const modelChip = screen.getByLabelText(rawModel);
		expect(modelChip.querySelector('[style*="prismml.svg"]')).not.toBeNull();
	});

	test("sums STT and LLM processing durations in the transcription footer", async () => {
		const entry: TranscriptionHistoryEntry = {
			durationMs: 10_000,
			id: "entry-llm-duration",
			llmModel: "qwen2.5:7b",
			llmProcessingMs: 2000,
			sttProcessingMs: 5000,
			text: "processed transcript",
			timestamp: Date.UTC(2026, 0, 1),
			wordCount: 2,
		};

		render(
			<IntlProvider>
				<HistoryTable entries={[transcriptionItem(entry)]} />
			</IntlProvider>,
		);

		await screen.findByText("processed transcript");

		expect(screen.getByText("7.0s")).not.toBeNull();
		expect(screen.queryByText("10s")).toBeNull();
		expect(screen.queryByText("5.0s")).toBeNull();
		expect(screen.queryByText("2.0s")).toBeNull();
		expect(screen.getByLabelText("Processing time")).not.toBeNull();
	});

	test("moves the timestamp under play and folds word stats into the processing tooltip", async () => {
		const timestamp = Date.UTC(2026, 6, 15, 13, 17);
		const entry: TranscriptionHistoryEntry = {
			durationMs: 34_118,
			id: "entry-condensed-meta",
			sttProcessingMs: 1300,
			text: "condensed history metadata",
			timestamp,
			wordCount: 58,
		};

		const { container } = render(
			<IntlProvider>
				<HistoryTable entries={[transcriptionItem(entry)]} />
			</IntlProvider>,
		);

		await screen.findByText(entry.text);
		const timestampElement = container.querySelector("time");
		expect(timestampElement).not.toBeNull();
		expect(timestampElement?.className).toContain("w-7");
		expect(timestampElement?.className).not.toContain("min-w-14");
		expect(timestampElement?.textContent).toContain(
			new Date(timestamp).toLocaleTimeString(undefined, {
				hour: "numeric",
				minute: "2-digit",
			}),
		);
		expect(timestampElement?.textContent).toContain(
			new Date(timestamp).toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
			}),
		);
		expect(screen.queryByText("58")).toBeNull();
		expect(screen.queryByText("102")).toBeNull();

		const processing = screen.getByLabelText("Processing time");
		fireEvent.pointerEnter(processing);
		fireEvent.mouseEnter(processing);
		fireEvent.focus(processing);

		const words = await screen.findByText("58");
		const wpm = await screen.findByText("102");
		const recording = screen.getByText("Recording");
		const speechToText = screen.getByText("Transcription");
		const languageModel = screen.getByText("AI processing");
		expect(words.parentElement?.className).toContain("border-t");
		expect(recording.compareDocumentPosition(words)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		expect(speechToText.compareDocumentPosition(words)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		expect(languageModel.compareDocumentPosition(words)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		expect(words.compareDocumentPosition(wpm)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
	});

	test("hides the LLM text toggle when the processed text is unchanged", async () => {
		const entry: TranscriptionHistoryEntry = {
			durationMs: 1200,
			id: "entry-llm-noop",
			llmModel: "qwen2.5:7b",
			originalText: "same transcript",
			text: " same   transcript\n",
			timestamp: Date.UTC(2026, 0, 1),
			wordCount: 2,
		};

		render(
			<IntlProvider>
				<HistoryTable entries={[transcriptionItem(entry)]} />
			</IntlProvider>,
		);

		await screen.findByText("same transcript");

		expect(screen.queryByRole("button", { name: "Show original" })).toBeNull();
	});

	test("shows the LLM text toggle when the processed text changed", async () => {
		const entry: TranscriptionHistoryEntry = {
			durationMs: 1200,
			id: "entry-llm-changed",
			llmModel: "qwen2.5:7b",
			originalText: "raw transcript",
			text: "Clean transcript.",
			timestamp: Date.UTC(2026, 0, 1),
			wordCount: 2,
		};

		render(
			<IntlProvider>
				<HistoryTable entries={[transcriptionItem(entry)]} />
			</IntlProvider>,
		);

		await screen.findByText("Clean transcript.");

		expect(
			screen.queryByRole("button", { name: "Show original" }),
		).not.toBeNull();
	});

	test("switches to the original transcript before playing saved speech", async () => {
		class MockAudio {
			currentTime = 0;
			onended: (() => void) | null = null;
			pause = mock(() => undefined);
			play = mock<() => Promise<void>>(() => Promise.resolve());

			constructor(readonly src: string) {}
		}
		Object.defineProperty(globalThis, "Audio", {
			configurable: true,
			value: MockAudio,
		});
		const invoke = mock<
			(channel: string, ...args: unknown[]) => Promise<unknown>
		>((channel) => {
			if (channel === IPC.HISTORY_LOAD_AUDIO) {
				return Promise.resolve("data:audio/wav;base64,AAAA");
			}
			if (channel === IPC.HISTORY_ALIGN_AUDIO) {
				return Promise.resolve([]);
			}
			return Promise.resolve(undefined);
		});
		window.nativeBridge = {
			...window.nativeBridge,
			invoke,
		};
		const entry: TranscriptionHistoryEntry = {
			audioFilePath: "C:\\recordings\\entry.wav",
			durationMs: 1200,
			id: "entry-llm-audio",
			llmModel: "qwen2.5:7b",
			originalText: "raw transcript",
			text: "Clean transcript.",
			timestamp: Date.UTC(2026, 0, 1),
			wordCount: 2,
		};

		render(
			<IntlProvider>
				<HistoryTable entries={[transcriptionItem(entry)]} />
			</IntlProvider>,
		);

		await screen.findByText("Clean transcript.");
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Play recording" }));
			await sleep(0);
		});

		expect(await screen.findByText("raw transcript")).not.toBeNull();
		expect(screen.queryByText("Clean transcript.")).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Show AI-edited" }),
		).not.toBeNull();
	});
});

describe("HistoryTable transform mode", () => {
	test("uses the provided delete handler, transform icon, and hides audio-only stats", async () => {
		const onDeleteEntry = mock<
			(id: string, kind: "transcription" | "transform" | "tts") => void
		>(() => undefined);
		const entry: TranscriptionHistoryEntry = {
			durationMs: 0,
			id: "transform-row",
			originalText: "before transform",
			text: "after transform",
			timestamp: Date.UTC(2026, 0, 1),
			wordCount: 2,
		};

		render(
			<IntlProvider>
				<HistoryTable
					entries={[transformItem(entry)]}
					onDeleteEntry={onDeleteEntry}
				/>
			</IntlProvider>,
		);

		await screen.findByText("after transform");
		expect(screen.getByRole("img", { name: "Transformations" })).not.toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Delete entry" }));

		expect(onDeleteEntry).toHaveBeenCalledWith("transform-row", "transform");
		expect(screen.queryByTitle("Duration")).toBeNull();
	});
});

describe("HistoryTable cloud costs", () => {
	test("sums STT and LLM costs into one cost chip on transcription rows", async () => {
		const entry: TranscriptionHistoryEntry = {
			durationMs: 4000,
			id: "entry-cost",
			llmCostUsd: 0.0001,
			llmModel: "openai/gpt-4o-mini",
			sttCostUsd: 0.0002,
			sttCostIsEstimate: false,
			text: "cloud transcript",
			timestamp: Date.UTC(2026, 0, 2),
			wordCount: 2,
		};

		render(
			<IntlProvider>
				<HistoryTable entries={[transcriptionItem(entry)]} />
			</IntlProvider>,
		);

		await screen.findByText("cloud transcript");
		// The chip shows a trimmed approximation (sub-$0.001 floors to "<$0.001");
		// the exact per-stage figures live in its hover tooltip.
		expect(screen.getByText("<$0.001")).not.toBeNull();
		expect(screen.getByLabelText("Cloud cost")).not.toBeNull();
		// STT rows are typed by the card-level kind rail (sr-only label), not a
		// footer chip.
		expect(screen.getByText("Speech-to-text")).not.toBeNull();
		// The OpenRouter LLM model is flagged as a cloud model.
		expect(screen.getByRole("img", { name: "Cloud" })).not.toBeNull();
	});

	test("marks estimated provider costs with a tilde", async () => {
		const entry: TranscriptionHistoryEntry = {
			durationMs: 4000,
			id: "entry-estimate",
			sttCostUsd: 0.0008,
			sttCostIsEstimate: true,
			text: "estimated transcript",
			timestamp: Date.UTC(2026, 0, 2),
			wordCount: 2,
		};

		render(
			<IntlProvider>
				<HistoryTable entries={[transcriptionItem(entry)]} />
			</IntlProvider>,
		);

		await screen.findByText("estimated transcript");
		expect(screen.getByText("~<$0.001")).not.toBeNull();
	});

	test("renders TTS rows with kind marker, voice model, voice, and cost", async () => {
		const tts: TtsHistoryEntry = {
			characters: 55,
			costUsd: 0.000_034_1,
			id: "tts-1",
			model: "openrouter:hexgrad/kokoro-82m",
			processingMs: 1800,
			text: "read this aloud",
			timestamp: Date.UTC(2026, 0, 3),
			voice: "af_alloy",
			wordCount: 3,
		};

		render(
			<IntlProvider>
				<HistoryTable entries={[ttsItem(tts)]} />
			</IntlProvider>,
		);

		await screen.findByText("read this aloud");
		expect(screen.getByText("Text-to-speech")).not.toBeNull();
		// No saved synthesis audio → the transport slot keeps an inert play
		// button (nothing replaces the play icon).
		expect(screen.getByRole("button", { name: "Not recorded" })).not.toBeNull();
		// The `openrouter:` prefix is stripped from the displayed model id — the
		// cloud sign, not the prefix, marks it as a cloud model.
		expect(screen.getByText("hexgrad/kokoro-82m")).not.toBeNull();
		expect(screen.queryByText("openrouter:hexgrad/kokoro-82m")).toBeNull();
		expect(screen.getByRole("img", { name: "Cloud" })).not.toBeNull();
		expect(screen.getByText("af_alloy")).not.toBeNull();
		expect(screen.getByText("<$0.001")).not.toBeNull();
	});

	test("TTS rows with saved audio play through tts-history:load-audio", async () => {
		class MockAudio {
			currentTime = 0;
			onended: (() => void) | null = null;
			pause = mock(() => undefined);
			play = mock<() => Promise<void>>(() => Promise.resolve());

			constructor(readonly src: string) {}
		}
		Object.defineProperty(globalThis, "Audio", {
			configurable: true,
			value: MockAudio,
		});
		// The playback loaders route through the typed `commands.*` bindings →
		// `__TAURI_INTERNALS__.invoke` (not nativeBridge), so instrument that.
		const invoke = mock<(cmd: string, args?: unknown) => Promise<unknown>>(
			(cmd) => {
				if (cmd === "tts_history_load_audio") {
					return Promise.resolve("data:audio/wav;base64,AAAA");
				}
				return Promise.resolve(undefined);
			},
		);
		(
			window as unknown as {
				__TAURI_INTERNALS__: { invoke: typeof invoke };
			}
		).__TAURI_INTERNALS__.invoke = invoke;
		const tts: TtsHistoryEntry = {
			audioFilePath: "C:\\recordings\\tts-1.wav",
			characters: 24,
			id: "tts-audio",
			model: "kokoro",
			text: "played back aloud",
			timestamp: Date.UTC(2026, 0, 3),
			voice: "af_alloy",
			wordCount: 3,
		};

		render(
			<IntlProvider>
				<HistoryTable entries={[ttsItem(tts)]} />
			</IntlProvider>,
		);

		await screen.findByText("played back aloud");
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Play recording" }));
			await sleep(0);
		});

		// The clip loads through the TTS loader — never the STT one, and no
		// word-alignment call is made for synthesis audio.
		const cmds = invoke.mock.calls.map((call) => call[0]);
		expect(cmds).toContain("tts_history_load_audio");
		expect(cmds).not.toContain("history_load_audio");
		expect(cmds).not.toContain("align_words");
		expect(
			screen.getByRole("button", { name: "Pause recording" }),
		).not.toBeNull();
	});

	test("local runs (no cost data) render no cost chip", async () => {
		const entry: TranscriptionHistoryEntry = {
			durationMs: 4000,
			id: "entry-local",
			text: "local transcript",
			timestamp: Date.UTC(2026, 0, 2),
			wordCount: 2,
		};

		render(
			<IntlProvider>
				<HistoryTable entries={[transcriptionItem(entry)]} />
			</IntlProvider>,
		);

		await screen.findByText("local transcript");
		expect(screen.queryByLabelText("Cloud cost")).toBeNull();
	});
});
