import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupContent,
	InputGroupInput,
	InputGroupText,
} from "./InputGroup";

describe("InputGroup", () => {
	test("renders children inside a flex shell", () => {
		const { container } = render(
			<InputGroup>
				<input placeholder="search" />
			</InputGroup>,
		);
		const root = container.firstChild as HTMLElement;
		expect(root.className).toContain("inline-flex");
	});

	test("exposes data-size and data-tone for downstream targeting", () => {
		const { container } = render(
			<InputGroup size="sm" tone="active">
				<input />
			</InputGroup>,
		);
		const root = container.firstChild as HTMLElement;
		expect(root.dataset["size"]).toBe("sm");
		expect(root.dataset["tone"]).toBe("active");
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
			</InputGroup>,
		);
		const start = screen
			.getByText("start")
			.closest("[data-align]") as HTMLElement;
		const end = screen.getByText("end").closest("[data-align]") as HTMLElement;
		expect(start.dataset["align"]).toBe("inline-start");
		expect(end.dataset["align"]).toBe("inline-end");
	});

	test("InputGroupInput renders an editable input that flexes to fill", () => {
		const changes: string[] = [];
		render(
			<InputGroup>
				<InputGroupAddon>
					<span>icon</span>
				</InputGroupAddon>
				<InputGroupInput
					onChange={(e) => changes.push(e.target.value)}
					placeholder="Search…"
					value=""
				/>
			</InputGroup>,
		);
		const input = screen.getByPlaceholderText("Search…") as HTMLInputElement;
		expect(input.className).toContain("flex-1");
		expect(input.className).toContain("bg-transparent");
		fireEvent.change(input, { target: { value: "abc" } });
		expect(changes).toEqual(["abc"]);
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
			</InputGroup>,
		);
		const btn = screen.getByRole("button");
		expect(btn.className).toContain("bg-error");
		fireEvent.click(btn);
		expect(clicks).toBe(1);
	});

	test("elevated appearance (default) keeps the raised drop shadow", () => {
		const { container } = render(
			<InputGroup>
				<input />
			</InputGroup>,
		);
		const root = container.firstChild as HTMLElement;
		expect(root.dataset["appearance"]).toBe("elevated");
		expect(root.className).toContain("shadow-elevated");
	});

	test("minimal appearance is flat: no shadow, transparent at rest", () => {
		const { container } = render(
			<InputGroup appearance="minimal">
				<input />
			</InputGroup>,
		);
		const root = container.firstChild as HTMLElement;
		expect(root.dataset["appearance"]).toBe("minimal");
		expect(root.className).not.toContain("shadow-elevated");
		expect(root.className).toContain("bg-transparent");
	});

	test("InputGroupButton ghost tone is flat (transparent, no accent fill)", () => {
		render(
			<InputGroup appearance="minimal">
				<InputGroupAddon align="inline-end">
					<InputGroupButton tone="ghost">
						<span>+</span>
					</InputGroupButton>
				</InputGroupAddon>
			</InputGroup>,
		);
		const btn = screen.getByRole("button");
		expect(btn.className).toContain("bg-transparent");
		expect(btn.className).not.toContain("bg-accent");
	});
});
