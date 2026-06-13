import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { SubtitleOverlay } from "./SubtitleOverlay";

beforeEach(() => {
	useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
	useTranscriptionStore.setState({
		items: [],
		currentRealtime: "",
		ephemeral: null,
	});
});

afterEach(() => {
	useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
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

	test("forces in-app live text in listen mode even when saved preference is pill-only", () => {
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				general: {
					...DEFAULT_SETTINGS.general,
					recordingMode: "listen",
					liveTranscriptionDisplay: "in-pill",
				},
			},
		});
		useTranscriptionStore.setState({
			items: [],
			currentRealtime: "listen mode words",
			ephemeral: null,
		});
		const { container } = render(<SubtitleOverlay />);
		expect(container.textContent).toContain("listen mode words");
	});

	test("listen mode renders a capped rolling transcript window", () => {
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				general: {
					...DEFAULT_SETTINGS.general,
					recordingMode: "listen",
				},
			},
		});
		useTranscriptionStore.setState({
			items: Array.from({ length: 165 }, (_, i) => ({
				id: String(i),
				type: "final" as const,
				text: `listen row ${i}`,
				timestamp: i,
			})),
			currentRealtime: "",
			ephemeral: null,
		});
		const { container } = render(<SubtitleOverlay />);
		const lines = Array.from(
			container.querySelectorAll<HTMLElement>("[data-subtitle-line]"),
		).map((line) => line.textContent);
		expect(lines).toHaveLength(160);
		expect(lines[0]).toBe("listen row 5");
		expect(lines.at(-1)).toBe("listen row 164");
		expect(lines).not.toContain("listen row 0");
	});
});
