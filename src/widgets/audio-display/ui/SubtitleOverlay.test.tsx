import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { groupBySpeaker, SubtitleOverlay } from "./SubtitleOverlay";

function listenSettings() {
	return {
		...DEFAULT_SETTINGS,
		general: {
			...DEFAULT_SETTINGS.general,
			recordingMode: "listen" as const,
		},
	};
}

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

	test("renders a feathered scrim layer whose opacity tracks the strongest line", () => {
		useTranscriptionStore.setState({
			items: [
				{ id: "1", type: "final", text: "Hello world.", timestamp: Date.now() },
			],
			currentRealtime: "",
			ephemeral: null,
		});
		const { container } = render(<SubtitleOverlay />);
		const scrim = container.querySelector<HTMLElement>("[data-subtitle-scrim]");
		expect(scrim).not.toBeNull();
		expect(scrim?.classList.contains("subtitle-scrim-bloom")).toBe(true);
		// Fresh line → fully visible scrim that will fade with the caption.
		expect(scrim?.style.opacity).toBe("1");
		expect(scrim?.style.transition).toBe("opacity 140ms ease-out");
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
		useSettingsStore.setState({ settings: listenSettings() });
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

	test("listen mode groups consecutive same-speaker rows under one badge", () => {
		useSettingsStore.setState({ settings: listenSettings() });
		useTranscriptionStore.setState({
			items: [
				{ id: "1", type: "final", text: "alpha", timestamp: 1, speaker: 0 },
				{ id: "2", type: "final", text: "bravo", timestamp: 2, speaker: 0 },
				{ id: "3", type: "final", text: "charlie", timestamp: 3, speaker: 1 },
				{ id: "4", type: "final", text: "delta", timestamp: 4, speaker: null },
			],
			currentRealtime: "",
			ephemeral: null,
		});
		const { container } = render(<SubtitleOverlay />);

		const blocks = Array.from(
			container.querySelectorAll<HTMLElement>("[data-speaker-block]"),
		);
		expect(blocks.map((b) => b.getAttribute("data-speaker-block"))).toEqual([
			"0",
			"1",
			"unknown",
		]);
		// One badge per ATTRIBUTED block; unknown rows carry no badge.
		const badges = Array.from(
			container.querySelectorAll<HTMLElement>("[data-speaker-badge]"),
		);
		expect(badges.map((b) => b.textContent)).toEqual(["S1", "S2"]);
		// Both same-speaker rows live inside the first block, colored by speaker.
		const first = blocks[0];
		const firstLines = Array.from(
			first?.querySelectorAll<HTMLElement>("[data-subtitle-line]") ?? [],
		);
		expect(firstLines.map((l) => l.textContent)).toEqual(["alpha", "bravo"]);
		expect(firstLines[0]?.style.color).toBe("var(--color-speaker-0)");
		// Unknown block: default foreground (no inline color).
		const unknownLine = blocks[2]?.querySelector<HTMLElement>(
			"[data-subtitle-line]",
		);
		expect(unknownLine?.style.color).toBe("");
	});

	test("groupBySpeaker merges runs and normalizes negative ids to unknown", () => {
		const items = [
			{ id: "a", type: "final" as const, text: "x", timestamp: 1, speaker: 2 },
			{ id: "b", type: "final" as const, text: "y", timestamp: 2, speaker: 2 },
			{ id: "c", type: "final" as const, text: "z", timestamp: 3, speaker: -1 },
			{ id: "d", type: "final" as const, text: "w", timestamp: 4 },
			{ id: "e", type: "final" as const, text: "v", timestamp: 5, speaker: 2 },
		];
		const blocks = groupBySpeaker(items);
		expect(blocks.map((b) => b.speaker)).toEqual([2, null, 2]);
		expect(blocks[0]?.items).toHaveLength(2);
		// -1 and undefined merge into one unknown block.
		expect(blocks[1]?.items.map((i) => i.id)).toEqual(["c", "d"]);
	});
});
