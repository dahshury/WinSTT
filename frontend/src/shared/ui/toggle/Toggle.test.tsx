import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { Toggle } from "./Toggle";

describe("Toggle", () => {
	test("reflects the checked prop via aria-checked", () => {
		const { rerender } = render(
			<Toggle aria-label="dark mode" checked={false} onCheckedChange={() => undefined} />
		);
		const switchEl = screen.getByRole("switch", { name: "dark mode" });
		expect(switchEl.getAttribute("aria-checked")).toBe("false");
		rerender(<Toggle aria-label="dark mode" checked={true} onCheckedChange={() => undefined} />);
		expect(switchEl.getAttribute("aria-checked")).toBe("true");
	});

	test("invokes onCheckedChange with inverted value when clicked", () => {
		const onChange = mock(() => undefined);
		render(<Toggle aria-label="dm" checked={false} onCheckedChange={onChange} />);
		fireEvent.click(screen.getByRole("switch"));
		expect(onChange).toHaveBeenCalledTimes(1);
		expect((onChange as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]).toBe(true);
	});

	test("does not invoke onCheckedChange when disabled", () => {
		const onChange = mock(() => undefined);
		render(<Toggle aria-label="dm" checked={false} disabled onCheckedChange={onChange} />);
		fireEvent.click(screen.getByRole("switch"));
		expect(onChange).not.toHaveBeenCalled();
	});
});
