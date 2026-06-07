import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { Button } from "./Button";

describe("Button", () => {
	test("renders children", () => {
		render(<Button>Click me</Button>);
		expect(screen.getByRole("button", { name: "Click me" })).toBeDefined();
	});

	test('defaults type="button" (avoiding accidental form submission)', () => {
		render(<Button>X</Button>);
		expect(screen.getByRole("button").getAttribute("type")).toBe("button");
	});

	test('honors an explicit type="submit"', () => {
		render(<Button type="submit">Send</Button>);
		expect(screen.getByRole("button").getAttribute("type")).toBe("submit");
	});

	test("invokes onClick when clicked", () => {
		const onClick = mock(() => undefined);
		render(<Button onClick={onClick}>Tap</Button>);
		fireEvent.click(screen.getByRole("button"));
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	test("does not invoke onClick when disabled", () => {
		const onClick = mock(() => undefined);
		render(
			<Button disabled onClick={onClick}>
				Tap
			</Button>,
		);
		fireEvent.click(screen.getByRole("button"));
		expect(onClick).not.toHaveBeenCalled();
	});

	test("merges user className with built-ins", () => {
		render(<Button className="custom-extra">X</Button>);
		expect(screen.getByRole("button").className).toContain("custom-extra");
	});

	test("forwards data attributes", () => {
		render(<Button data-testid="btn">X</Button>);
		expect(screen.getByTestId("btn")).toBeDefined();
	});
});
