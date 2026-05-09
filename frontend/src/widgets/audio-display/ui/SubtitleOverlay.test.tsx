import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { useTranscriptionStore } from "@/features/live-transcription";
import { SubtitleOverlay } from "./SubtitleOverlay";

beforeEach(() => {
	useTranscriptionStore.setState({ items: [], currentRealtime: "", ephemeral: null });
});

afterEach(() => {
	useTranscriptionStore.setState({ items: [], currentRealtime: "", ephemeral: null });
});

describe("SubtitleOverlay", () => {
	test("renders nothing when there are no items, no realtime, no ephemeral", () => {
		const { container } = render(<SubtitleOverlay />);
		expect(container.firstElementChild).toBeNull();
	});

	test("renders the latest items as subtitles", () => {
		useTranscriptionStore.setState({
			items: [{ id: "1", type: "final", text: "Hello world.", timestamp: Date.now() }],
			currentRealtime: "",
			ephemeral: null,
		});
		const { container } = render(<SubtitleOverlay />);
		expect(container.textContent).toContain("Hello world.");
	});
});
