import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useFileTranscriptionStore } from "@/features/file-transcription";
import type { FileQueueItem } from "@/shared/api/ipc-client";
import { FileOverlay } from "./FileOverlay";

function makeItem(over: Partial<FileQueueItem> = {}): FileQueueItem {
	return {
		id: "1",
		fileName: "a.wav",
		status: "queued",
		progress: 0,
		stage: "queued",
		message: "",
		...over,
	};
}

function renderOverlay() {
	return render(
		<IntlProvider>
			<FileOverlay />
		</IntlProvider>,
	);
}

beforeEach(() => {
	useFileTranscriptionStore.getState().reset();
});

afterEach(() => {
	useFileTranscriptionStore.getState().reset();
});

describe("FileOverlay", () => {
	test("renders nothing when the queue is empty", () => {
		const { container } = renderOverlay();
		expect(container.textContent ?? "").toBe("");
	});

	test("renders a row per queued file", () => {
		useFileTranscriptionStore
			.getState()
			.setItems([
				makeItem({ id: "a", fileName: "one.mp3" }),
				makeItem({ id: "b", fileName: "two.wav" }),
			]);
		const { container } = renderOverlay();
		expect(container.textContent).toContain("one.mp3");
		expect(container.textContent).toContain("two.wav");
		expect(container.querySelectorAll("li")).toHaveLength(2);
	});

	test("shows the active percentage for a transcribing row", () => {
		useFileTranscriptionStore
			.getState()
			.setItems([
				makeItem({ id: "a", status: "transcribing", progress: 0.42 }),
			]);
		const { container } = renderOverlay();
		expect(container.textContent).toContain("42");
	});

	test("marks the transcribing row as the current step", () => {
		useFileTranscriptionStore
			.getState()
			.setItems([makeItem({ id: "a", status: "transcribing", progress: 0.5 })]);
		const { container } = renderOverlay();
		expect(container.querySelector('[aria-current="step"]')).not.toBeNull();
	});

	test("exposes the queue region with a count", () => {
		useFileTranscriptionStore
			.getState()
			.setItems([
				makeItem({ id: "a", status: "complete", progress: 1 }),
				makeItem({ id: "b" }),
			]);
		const { container } = renderOverlay();
		// 1 of 2 done
		expect(container.querySelector("[aria-label]")).not.toBeNull();
		expect(container.textContent).toContain("1");
		expect(container.textContent).toContain("2");
	});
});
