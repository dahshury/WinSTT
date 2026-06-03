import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { PulseDot } from "./PulseDot";

describe("PulseDot", () => {
	test("renders a decorative dot with the loading-ui pulse animation", () => {
		const { container } = render(<PulseDot />);

		const dot = container.querySelector('[data-slot="pulse-dot"]');
		expect(dot).not.toBeNull();
		if (!dot) {
			throw new Error("PulseDot did not render");
		}

		expect(screen.queryByRole("status")).toBeNull();
		expect(dot.getAttribute("data-slot")).toBe("pulse-dot");
		expect(dot.getAttribute("aria-hidden")).toBe("true");
		expect(dot.className).toContain("rounded-full");
		expect(dot.getAttribute("style")).toContain("loading-ui-pulse-dot");
		expect(dot.textContent).toBe("");
	});

	test("uses a caller-provided accessible label as a status name", () => {
		render(<PulseDot aria-label="Loading voice" />);

		const dot = screen.getByRole("status", { name: "Loading voice" });
		expect(dot.getAttribute("aria-hidden")).toBeNull();
	});

	test("merges custom className and forwards props", () => {
		render(<PulseDot className="size-2 text-accent" data-testid="dot" id="model-loading" />);

		const dot = screen.getByTestId("dot");
		expect(dot.id).toBe("model-loading");
		expect(dot.className).toContain("size-2");
		expect(dot.className).toContain("text-accent");
	});
});
