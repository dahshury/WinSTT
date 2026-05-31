import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { PasswordField } from "./PasswordField";

describe("PasswordField", () => {
	test("renders masked by default", () => {
		render(<PasswordField placeholder="key" />);
		const input = screen.getByPlaceholderText("key") as HTMLInputElement;
		expect(input.type).toBe("password");
	});

	test("toggle button unmasks then re-masks the value", () => {
		render(<PasswordField placeholder="key" revealLabel="Show" />);
		const input = screen.getByPlaceholderText("key") as HTMLInputElement;
		const toggle = screen.getByRole("button", { name: "Show" });
		fireEvent.click(toggle);
		expect(input.type).toBe("text");
		fireEvent.click(screen.getByRole("button", { name: "Hide" }));
		expect(input.type).toBe("password");
	});

	test("aria-pressed reflects reveal state", () => {
		render(<PasswordField placeholder="key" />);
		const toggle = screen.getByRole("button");
		expect(toggle.getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-pressed")).toBe("true");
	});

	test("forwards value and onChange (controlled)", () => {
		const onChange = mock(() => undefined);
		render(<PasswordField onChange={onChange} placeholder="x" value="sk-or-test" />);
		const input = screen.getByPlaceholderText("x") as HTMLInputElement;
		expect(input.value).toBe("sk-or-test");
		fireEvent.change(input, { target: { value: "sk-or-other" } });
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	test("applies error styling when error prop is true", () => {
		render(<PasswordField data-testid="t" error placeholder="x" />);
		expect(screen.getByTestId("t").className).toContain("border-error");
	});
});
