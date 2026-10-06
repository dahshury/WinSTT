import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Badge } from "./Badge";

describe("Badge", () => {
	test("renders children inside a span", () => {
		render(<Badge>New</Badge>);
		const node = screen.getByText("New");
		expect(node.tagName).toBe("SPAN");
	});

	test("applies the default variant classes", () => {
		render(<Badge data-testid="b">x</Badge>);
		const node = screen.getByTestId("b");
		expect(node.className).toContain("bg-accent");
	});

	test.each(["default", "secondary", "outline"] as const)(
		"applies variant class for %s",
		(variant) => {
			render(
				<Badge data-testid="b" variant={variant}>
					x
				</Badge>,
			);
			const node = screen.getByTestId("b");
			expect(node.className.length).toBeGreaterThan(0);
		},
	);

	test("merges user-supplied className with built-ins", () => {
		render(
			<Badge className="custom" data-testid="b">
				x
			</Badge>,
		);
		expect(screen.getByTestId("b").className).toContain("custom");
	});

	test("forwards arbitrary span props (id, role)", () => {
		render(
			<Badge id="badge-1" role="status">
				x
			</Badge>,
		);
		expect(document.getElementById("badge-1")?.getAttribute("role")).toBe(
			"status",
		);
	});
});
