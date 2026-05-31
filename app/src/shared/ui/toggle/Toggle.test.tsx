import { describe, expect, type Mock, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { Toggle } from "./Toggle";

// Contains the single boundary cast that reads bun's spy `.mock.calls` record
// off a typed callback mock — the mock object itself is returned untouched.
const recordedCalls = (m: Mock<(...args: never[]) => unknown>) =>
	(m as unknown as { mock: { calls: unknown[][] } }).mock.calls;

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
		expect(recordedCalls(onChange)[0]?.[0]).toBe(true);
	});

	test("does not invoke onCheckedChange when disabled", () => {
		const onChange = mock(() => undefined);
		render(<Toggle aria-label="dm" checked={false} disabled onCheckedChange={onChange} />);
		fireEvent.click(screen.getByRole("switch"));
		expect(onChange).not.toHaveBeenCalled();
	});

	test("renders inline label when label prop is provided", () => {
		render(<Toggle checked={true} label="Dark mode" onCheckedChange={() => undefined} />);
		expect(screen.getByText("Dark mode")).toBeDefined();
		expect(screen.getByRole("switch", { name: "Dark mode" })).toBeDefined();
	});

	test("clicking the inline label toggles the switch", () => {
		const onChange = mock(() => undefined);
		render(<Toggle checked={false} label="Notifications" onCheckedChange={onChange} />);
		fireEvent.click(screen.getByText("Notifications"));
		expect(onChange).toHaveBeenCalledTimes(1);
	});
});
