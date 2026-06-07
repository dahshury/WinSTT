import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { useTranscriptionStore } from "@/entities/transcription";
import { SubtitleOverlay } from "./SubtitleOverlay";

beforeEach(() => {
	useTranscriptionStore.setState({
		items: [],
		currentRealtime: "",
		ephemeral: null,
	});
});

afterEach(() => {
	useTranscriptionStore.setState({
		items: [],
		currentRealtime: "",
		ephemeral: null,
	});
});

describe("SubtitleOverlay", () => {
	test("renders nothing when there are no items, no realtime, no ephemeral", () => {
		const { container } = render(<SubtitleOverlay />);
		expect(container.firstElementChild).toBeNull();
	});

	test("renders the latest items as subtitles", () => {
		useTranscriptionStore.setState({
			items: [
				{ id: "1", type: "final", text: "Hello world.", timestamp: Date.now() },
			],
			currentRealtime: "",
			ephemeral: null,
		});
		const { container } = render(<SubtitleOverlay />);
		expect(container.textContent).toContain("Hello world.");
		const line = container.querySelector<HTMLElement>("[data-subtitle-line]");
		expect(line).not.toBeNull();
		expect(line?.style.transition).toBe("opacity 140ms ease-out");
	});

	test("removes the normal subtitle layer after the final line exits", () => {
		useTranscriptionStore.setState({
			items: [
				{
					id: "1",
					type: "final",
					text: "Old final line.",
					timestamp: Date.now() - 2000,
				},
			],
			currentRealtime: "",
			ephemeral: null,
		});
		const { container } = render(<SubtitleOverlay />);
		expect(container.firstElementChild).toBeNull();
	});

	test("renders live text without the animated text-swap hook", () => {
		useTranscriptionStore.setState({
			items: [],
			currentRealtime: "live words",
			ephemeral: null,
		});
		const { container } = render(<SubtitleOverlay />);
		expect(container.textContent).toContain("live words");
		expect(container.querySelector(".t-text-swap")).toBeNull();
	});
});
