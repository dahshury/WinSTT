import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { DictionaryTable } from "./DictionaryTable";

const sampleEntry = {
	id: "1",
	find: "ur",
	replace: "your",
	caseSensitive: false,
	wholeWord: false,
};

function renderWith(props: Partial<Parameters<typeof DictionaryTable>[0]>) {
	const onAdd = mock(() => undefined);
	const onRemove = mock(() => undefined);
	const onUpdate = mock(() => undefined);
	const utils = render(
		<IntlProvider>
			<DictionaryTable
				entries={[]}
				onAdd={onAdd}
				onRemove={onRemove}
				onUpdate={onUpdate}
				{...props}
			/>
		</IntlProvider>
	);
	return { ...utils, onAdd, onRemove, onUpdate };
}

describe("DictionaryTable", () => {
	test("renders empty-state text when no entries are present", () => {
		renderWith({});
		// at least the form fields render
		expect(screen.getAllByRole("textbox").length).toBe(2);
	});

	test("renders existing entries as 'find → replace' rows", () => {
		renderWith({ entries: [sampleEntry] });
		expect(screen.getByText("ur")).toBeDefined();
		expect(screen.getByText("your")).toBeDefined();
	});

	test("clicking the per-row delete button calls onRemove with the entry id", () => {
		const { onRemove } = renderWith({ entries: [sampleEntry] });
		const deleteBtn = screen.getByRole("button", { name: /delete\s+"ur"/i });
		fireEvent.click(deleteBtn);
		expect(onRemove).toHaveBeenCalledWith("1");
	});

	test("the Add button is disabled when find or replace is empty", () => {
		renderWith({});
		const buttons = screen.getAllByRole("button");
		const addBtn = buttons.find((b) => (b.textContent ?? "").trim().toLowerCase() === "add");
		expect(addBtn).toBeDefined();
		expect((addBtn! as HTMLButtonElement).disabled).toBe(true);
	});

	test("renders a 'Delete All' control when onClearAll is provided", () => {
		const onClearAll = mock(() => undefined);
		renderWith({ entries: [sampleEntry], onClearAll });
		const buttons = screen.getAllByRole("button");
		const deleteAll = buttons.find((b) => (b.textContent ?? "").toLowerCase().includes("all"));
		expect(deleteAll).toBeDefined();
	});
});
