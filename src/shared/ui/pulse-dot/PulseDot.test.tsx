import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { PulseDot } from "./PulseDot";

describe("PulseDot", () => {
	test("renders a decorative thinking orb by default", () => {
		const { container } = render(<PulseDot />);

		const dot = container.querySelector('[data-slot="pulse-dot"]');
		expect(dot).not.toBeNull();
		if (!dot) {
			throw new Error("PulseDot did not render");
		}

		expect(screen.queryByRole("status")).toBeNull();
		expect(dot.getAttribute("aria-hidden")).toBe("true");
		// The orb canvas fills the caller-sized box.
		expect(dot.querySelector("canvas")).not.toBeNull();
	});

	test("uses a caller-provided accessible label as a status name", () => {
		render(<PulseDot aria-label="Loading voice" />);

		const dot = screen.getByRole("status", { name: "Loading voice" });
		expect(dot.getAttribute("aria-hidden")).toBeNull();
	});

	test("merges custom className and forwards props", () => {
		render(
			<PulseDot
				className="size-2 text-accent"
				data-testid="dot"
				id="model-loading"
			/>,
		);

		const dot = screen.getByTestId("dot");
		expect(dot.id).toBe("model-loading");
		expect(dot.className).toContain("size-2");
		expect(dot.className).toContain("text-accent");
	});
});
