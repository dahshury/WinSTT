import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { Switcher, type SwitcherOption } from "./Switcher";

const options: SwitcherOption<"a" | "b" | "c">[] = [
	{ label: "Alpha", value: "a" },
	{ label: "Beta", value: "b" },
	{ label: "Gamma", value: "c" },
];

// Each label is rendered twice per Toggle: an aria-hidden ghost reserves the
// semibold width so the active-weight swap doesn't reflow, plus the visible
// label. Tests look up segments by their underlying button rather than text.
function buttonFor(label: string): HTMLButtonElement | null {
	return screen.getAllByText(label)[0]?.closest("button") ?? null;
}

describe("Switcher", () => {
	test("renders one toggle per option", () => {
		render(<Switcher onChange={() => undefined} options={options} value="a" />);
		expect(buttonFor("Alpha")).not.toBeNull();
		expect(buttonFor("Beta")).not.toBeNull();
		expect(buttonFor("Gamma")).not.toBeNull();
	});

	test("the currently selected option has a pressed-state attribute", () => {
		render(<Switcher onChange={() => undefined} options={options} value="b" />);
		// Base UI Toggle adds data-pressed when active
		expect(buttonFor("Beta")?.getAttribute("data-pressed")).not.toBeNull();
	});

	test("clicking a different option fires onChange with the new value", () => {
		const onChange = mock(() => undefined);
		render(<Switcher onChange={onChange} options={options} value="a" />);
		const beta = buttonFor("Beta");
		fireEvent.click(beta!);
		expect(onChange).toHaveBeenCalled();
		// First call argument should be the new value
		const firstCall = (onChange as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
		expect(firstCall?.[0]).toBe("b");
	});
});
