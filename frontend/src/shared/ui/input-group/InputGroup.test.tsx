import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupContent,
	InputGroupText,
} from "./InputGroup";

describe("InputGroup", () => {
	test("renders children inside a flex shell", () => {
		const { container } = render(
			<InputGroup>
				<input placeholder="search" />
			</InputGroup>
		);
		const root = container.firstChild as HTMLElement;
		expect(root.className).toContain("inline-flex");
	});

	test("exposes data-size and data-tone for downstream targeting", () => {
		const { container } = render(
			<InputGroup size="sm" tone="active">
				<input />
			</InputGroup>
		);
		const root = container.firstChild as HTMLElement;
		expect(root.dataset.size).toBe("sm");
		expect(root.dataset.tone).toBe("active");
	});

	test("InputGroupAddon places content in start order by default", () => {
		render(
			<InputGroup>
				<InputGroupAddon>
					<span>start</span>
				</InputGroupAddon>
				<input />
				<InputGroupAddon align="inline-end">
					<span>end</span>
				</InputGroupAddon>
			</InputGroup>
		);
		const start = screen.getByText("start").closest("[data-align]") as HTMLElement;
		const end = screen.getByText("end").closest("[data-align]") as HTMLElement;
		expect(start.dataset.align).toBe("inline-start");
		expect(end.dataset.align).toBe("inline-end");
	});

	test("InputGroupButton wires through clicks and accepts danger tone", () => {
		let clicks = 0;
		render(
			<InputGroup>
				<InputGroupContent>combo</InputGroupContent>
				<InputGroupAddon align="inline-end">
					<InputGroupButton onClick={() => clicks++} tone="danger">
						<InputGroupText>Stop</InputGroupText>
					</InputGroupButton>
				</InputGroupAddon>
			</InputGroup>
		);
		const btn = screen.getByRole("button");
		expect(btn.className).toContain("bg-error");
		fireEvent.click(btn);
		expect(clicks).toBe(1);
	});
});
