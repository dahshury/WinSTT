import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { IPC } from "@/shared/api/ipc-channels";
import type { TranscriptionHistoryEntry } from "../model/history-store";
import { HistoryTable } from "./HistoryTable";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(
	globalThis.navigator,
	"clipboard",
);
const audioDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Audio");

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
				<HistoryTable entries={[entry]} />
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
				<HistoryTable entries={[entry]} />
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
				<HistoryTable entries={[entry]} />
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
				<HistoryTable entries={[entry]} />
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
	test("uses the provided delete handler and hides audio-only stats", async () => {
		const onDeleteEntry = mock<(id: string) => void>(() => undefined);
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
					entries={[entry]}
					onDeleteEntry={onDeleteEntry}
					showAudioStats={false}
				/>
			</IntlProvider>,
		);

		await screen.findByText("after transform");
		fireEvent.click(screen.getByRole("button", { name: "Delete entry" }));

		expect(onDeleteEntry).toHaveBeenCalledWith("transform-row");
		expect(screen.queryByTitle("Duration")).toBeNull();
	});
});
