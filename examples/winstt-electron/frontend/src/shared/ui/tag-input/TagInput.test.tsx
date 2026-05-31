import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { TagInput } from "./TagInput";

/**
 * Controlled host mirroring real usage: `onChange` actually applies the next
 * value. `TagInput` is a controlled combobox, so an interactive test that left
 * `value` frozen would spin Base UI's reconciliation — feed the change back.
 */
function Host({ initial }: { initial: string[] }) {
	const [value, setValue] = useState<string[]>(initial);
	return (
		<TagInput
			createLabel={(entry) => `Add "${entry}"`}
			normalize={(raw) => raw.trim().toLowerCase()}
			onChange={setValue}
			placeholder="e.g. chrome.exe"
			removeAriaLabel={(tag) => `Remove "${tag}"`}
			value={value}
		/>
	);
}

describe("TagInput", () => {
	test("renders one removable chip per value", () => {
		render(<TagInput onChange={() => undefined} value={["chrome.exe", "chase.com"]} />);
		expect(screen.getByText("chrome.exe")).toBeDefined();
		expect(screen.getByText("chase.com")).toBeDefined();
	});

	test("shows the placeholder only while the list is empty", () => {
		render(<TagInput onChange={() => undefined} placeholder="e.g. chrome.exe" value={[]} />);
		expect(screen.getByPlaceholderText("e.g. chrome.exe")).toBeDefined();
	});

	test("removing a chip drops that entry from the list", () => {
		render(<Host initial={["chrome.exe", "chase.com"]} />);
		fireEvent.click(screen.getByRole("button", { name: 'Remove "chrome.exe"' }));
		expect(screen.queryByText("chrome.exe")).toBeNull();
		expect(screen.getByText("chase.com")).toBeDefined();
	});

	test("typing a new value surfaces a normalized create row and commits it", async () => {
		render(<Host initial={[]} />);
		const input = screen.getByRole("combobox");
		fireEvent.focus(input);
		// Mixed case + surrounding space — the create row reflects the
		// normalized form, and that normalized value is what gets stored.
		fireEvent.change(input, { target: { value: " Outlook.EXE " } });
		fireEvent.keyDown(input, { key: "ArrowDown" });
		fireEvent.click(await screen.findByText('Add "outlook.exe"'));
		expect(await screen.findByText("outlook.exe")).toBeDefined();
	});

	test("does not offer to create a value already in the list", () => {
		render(<TagInput onChange={() => undefined} value={["chrome.exe"]} />);
		const input = screen.getByRole("combobox");
		fireEvent.click(input);
		fireEvent.change(input, { target: { value: "chrome.exe" } });
		expect(screen.queryByText('Add "chrome.exe"')).toBeNull();
	});
});
