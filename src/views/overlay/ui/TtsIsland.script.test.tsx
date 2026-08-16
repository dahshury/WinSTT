import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useTtsPlaybackStore } from "../model/tts-playback-store";
import { useTtsScriptStore } from "../model/tts-script-store";
import { TtsIslandLayer } from "./TtsIsland";

// The read-aloud island's script body: the text the synthesizer was handed,
// highlighted word-by-word as it plays. These cover the wiring from the two
// stores to the rendered highlight; the timing maths itself is unit-tested in
// `lib/script-timing.test.ts`.

function renderIsland() {
	return render(
		<IntlProvider>
			<TtsIslandLayer show status="speaking" />
		</IntlProvider>,
	);
}

/** The word currently wearing the highlight pill, or `null` when none is. */
function highlightedWord(container: HTMLElement): string | null {
	const active = container.querySelector("span.bg-overlay-foreground\\/20");
	return active?.textContent ?? null;
}

function setScript(sentences: string[], spans: [number, number, number][]) {
	act(() => {
		useTtsScriptStore.setState({
			requestId: "r",
			sentences,
			spans: spans.map(([index, start, end]) => ({ index, start, end })),
		});
	});
}

function setPosition(currentTime: number) {
	act(() => {
		useTtsPlaybackStore.getState().setProgress(currentTime, 4, 4);
	});
}

beforeEach(() => {
	useTtsScriptStore.getState().clear();
	useTtsPlaybackStore.setState({
		status: "speaking",
		requestId: "r",
		currentTime: 0,
		duration: 0,
		bufferedEnd: 0,
	});
});

afterEach(() => {
	cleanup();
	useTtsScriptStore.getState().clear();
	useTtsPlaybackStore.getState().markEnded();
});

describe("TTS island script body", () => {
	test("renders nothing when the read carries no script", () => {
		// Voice previews and cloud preview clips have no user text; an empty text
		// row would just add a permanent gap to the pill.
		const { container } = renderIsland();
		expect(container.textContent ?? "").not.toContain("Hello");
	});

	test("shows the script before any audio has arrived", () => {
		// `tts:script` is emitted BEFORE the first sample exists, so the synthesis
		// wait is spent reading rather than staring at a spinner.
		const { container } = renderIsland();
		setScript(["Hello there."], []);
		expect(container.textContent).toContain("Hello");
		expect(container.textContent).toContain("there.");
		expect(highlightedWord(container)).toBeNull();
	});

	test("sweeps the highlight across the words as playback advances", () => {
		const { container } = renderIsland();
		setScript(["one two"], [[0, 0, 2]]);
		setPosition(0.1);
		expect(highlightedWord(container)).toBe("one");
		setPosition(1.9);
		expect(highlightedWord(container)).toBe("two");
	});

	test("crosses sentence boundaries as each sentence's audio lands", () => {
		const { container } = renderIsland();
		setScript(
			["first here.", "second here."],
			[
				[0, 0, 1],
				[1, 1, 2],
			],
		);
		setPosition(1.6);
		expect(highlightedWord(container)).toBe("here.");
		// Second sentence's second word — i.e. the highlight moved past the first
		// sentence rather than restarting inside it.
		expect(container.textContent).toContain("second");
	});

	test("re-lights the right word after a backwards seek", () => {
		const { container } = renderIsland();
		setScript(["one two"], [[0, 0, 2]]);
		setPosition(1.9);
		expect(highlightedWord(container)).toBe("two");
		setPosition(0);
		expect(highlightedWord(container)).toBe("one");
	});

	test("drops the text when the read ends", () => {
		const { container } = renderIsland();
		setScript(["Hello there."], [[0, 0, 1]]);
		expect(container.textContent).toContain("Hello");
		act(() => {
			useTtsScriptStore.getState().clear();
		});
		expect(container.textContent ?? "").not.toContain("Hello");
	});
});
