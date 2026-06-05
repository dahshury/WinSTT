import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import type { TranscriptionHistoryEntry } from "../model/history-store";
import { HistoryTable } from "./HistoryTable";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(
  globalThis.navigator,
  "clipboard",
);

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
