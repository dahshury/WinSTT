import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { useFileTranscriptionStore } from "@/features/file-transcription";
import { FileOverlay } from "./FileOverlay";

beforeEach(() => {
	useFileTranscriptionStore.getState().reset();
});

afterEach(() => {
	useFileTranscriptionStore.getState().reset();
});

describe("FileOverlay", () => {
	test("renders nothing when status is 'idle'", () => {
		const { container } = render(<FileOverlay />);
		expect(container.textContent ?? "").toBe("");
	});

	test("renders processing UI with the file name", () => {
		useFileTranscriptionStore.getState().setProcessing("a.wav");
		const { container } = render(<FileOverlay />);
		expect(container.textContent).toContain("a.wav");
	});

	test("renders complete UI when status='complete'", () => {
		useFileTranscriptionStore.getState().setComplete("a.wav");
		const { container } = render(<FileOverlay />);
		// status banner present
		expect(container.firstElementChild).not.toBeNull();
	});

	test("renders error UI when status='error' (shows the error message)", () => {
		useFileTranscriptionStore.getState().setError("a.wav", "boom");
		const { container } = render(<FileOverlay />);
		expect(container.textContent).toContain("boom");
	});
});
