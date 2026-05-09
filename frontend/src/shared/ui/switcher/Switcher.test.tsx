import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { Switcher, type SwitcherOption } from "./Switcher";

const options: SwitcherOption<"a" | "b" | "c">[] = [
	{ label: "Alpha", value: "a" },
	{ label: "Beta", value: "b" },
	{ label: "Gamma", value: "c" },
];

describe("Switcher", () => {
	test("renders one toggle per option", () => {
		render(<Switcher onChange={() => undefined} options={options} value="a" />);
		expect(screen.getByText("Alpha")).toBeDefined();
		expect(screen.getByText("Beta")).toBeDefined();
		expect(screen.getByText("Gamma")).toBeDefined();
	});

	test("the currently selected option has a pressed-state attribute", () => {
		render(<Switcher onChange={() => undefined} options={options} value="b" />);
		const beta = screen.getByText("Beta").closest("button");
		// Base UI Toggle adds data-pressed when active
		expect(beta?.getAttribute("data-pressed")).not.toBeNull();
	});

	test("clicking a different option fires onChange with the new value", () => {
		const onChange = mock(() => undefined);
		render(<Switcher onChange={onChange} options={options} value="a" />);
		const beta = screen.getByText("Beta").closest("button");
		fireEvent.click(beta!);
		expect(onChange).toHaveBeenCalled();
		// First call argument should be the new value
		const firstCall = (onChange as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
		expect(firstCall?.[0]).toBe("b");
	});
});
