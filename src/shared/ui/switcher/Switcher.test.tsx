import { describe, expect, type Mock, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { Switcher, type SwitcherOption } from "./Switcher";

// Contains the single boundary cast that reads bun's spy `.mock.calls` record
// off a typed callback mock — the mock object itself is returned untouched.
const recordedCalls = (m: Mock<(...args: never[]) => unknown>) =>
	(m as unknown as { mock: { calls: unknown[][] } }).mock.calls;

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
		const firstCall = recordedCalls(onChange)[0];
		expect(firstCall?.[0]).toBe("b");
	});

	test("columns lays options out in a grid with cell-filling toggles", () => {
		render(
			<Switcher
				columns={2}
				fullWidth
				onChange={() => undefined}
				options={options}
				value="a"
			/>,
		);
		const alpha = buttonFor("Alpha");
		// The group container carries the N-column grid layout...
		expect(alpha?.closest('[class*="grid-cols-2"]')).not.toBeNull();
		// ...and each toggle fills its cell instead of flexing.
		expect(alpha?.className).toContain("w-full");
		expect(alpha?.className).not.toContain("flex-1");
	});

	test("without columns the group stays a single flex row", () => {
		render(
			<Switcher
				fullWidth
				onChange={() => undefined}
				options={options}
				value="a"
			/>,
		);
		const alpha = buttonFor("Alpha");
		expect(alpha?.closest('[class*="grid-cols"]')).toBeNull();
		expect(alpha?.className).toContain("flex-1");
	});
});
