import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { SnippetsTable } from "./SnippetsTable";

const sample = { id: "1", trigger: "/sig", expansion: "Best,\nSan" };

function renderWith(props: Partial<Parameters<typeof SnippetsTable>[0]>) {
	const onAdd = mock(() => undefined);
	const onRemove = mock(() => undefined);
	const utils = render(
		<IntlProvider>
			<SnippetsTable entries={[]} onAdd={onAdd} onRemove={onRemove} {...props} />
		</IntlProvider>
	);
	return { ...utils, onAdd, onRemove };
}

describe("SnippetsTable", () => {
	test("renders existing entries as trigger/expansion rows", () => {
		renderWith({ entries: [sample] });
		expect(screen.getByText("/sig")).toBeDefined();
	});

	test("clicking per-row delete fires onRemove with the entry id", () => {
		const { onRemove } = renderWith({ entries: [sample] });
		const deleteBtn = screen.getByRole("button", { name: /delete\s+"\/sig"/i });
		fireEvent.click(deleteBtn);
		expect(onRemove).toHaveBeenCalledWith("1");
	});

	test("Add button is disabled with empty inputs", () => {
		renderWith({});
		// The Add action now lives in the expansion field's trailing slot as an
		// icon button, so it's found by its accessible name, not its text.
		const addBtn = screen.getByRole("button", { name: /add/i });
		expect((addBtn as HTMLButtonElement).disabled).toBe(true);
	});

	test("renders a 'Delete All' button when onClearAll is provided", () => {
		const onClearAll = mock(() => undefined);
		renderWith({ entries: [sample], onClearAll });
		const buttons = screen.getAllByRole("button");
		const deleteAll = buttons.find((b) => (b.textContent ?? "").toLowerCase().includes("all"));
		expect(deleteAll).toBeDefined();
	});
});
