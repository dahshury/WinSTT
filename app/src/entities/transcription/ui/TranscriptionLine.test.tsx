import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { TranscriptionItem } from "../model/transcription";
import { TranscriptionLine } from "./TranscriptionLine";

const final: TranscriptionItem = {
	id: "1",
	type: "final",
	text: "Hello world.",
	timestamp: 0,
};

const realtime: TranscriptionItem = {
	id: "2",
	type: "realtime",
	text: "Live preview…",
	timestamp: 0,
};

describe("TranscriptionLine", () => {
	test("renders the text", () => {
		render(<TranscriptionLine index={0} item={final} />);
		expect(screen.getByText("Hello world.")).toBeDefined();
	});

	test("realtime items use italic muted text styling", () => {
		render(<TranscriptionLine index={0} item={realtime} />);
		const span = screen.getByText("Live preview…");
		expect(span.className).toContain("italic");
		expect(span.className).toContain("text-foreground-muted");
	});

	test("final items use the normal foreground styling", () => {
		render(<TranscriptionLine index={0} item={final} />);
		const span = screen.getByText("Hello world.");
		expect(span.className).toContain("text-foreground");
		expect(span.className).not.toContain("italic");
	});

	test("animationDelay is clamped to 200ms regardless of index", () => {
		const { container } = render(<TranscriptionLine index={50} item={final} />);
		const wrapper = container.firstElementChild as HTMLElement;
		expect(wrapper.style.animationDelay).toBe("200ms");
	});

	test("low indexes scale linearly (20ms per index)", () => {
		const { container } = render(<TranscriptionLine index={3} item={final} />);
		const wrapper = container.firstElementChild as HTMLElement;
		expect(wrapper.style.animationDelay).toBe("60ms");
	});
});
