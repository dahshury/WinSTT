import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { DictionaryTable } from "./DictionaryTable";

const sampleEntry = { id: "1", term: "Kubernetes" };

function renderWith(props: Partial<Parameters<typeof DictionaryTable>[0]>) {
	const onAdd = mock(() => undefined);
	const onRemove = mock(() => undefined);
	const utils = render(
		<IntlProvider>
			<DictionaryTable entries={[]} onAdd={onAdd} onRemove={onRemove} {...props} />
		</IntlProvider>
	);
	return { ...utils, onAdd, onRemove };
}

describe("DictionaryTable", () => {
	test("renders a single term input when no entries are present", () => {
		renderWith({});
		// One field — the term — instead of the legacy find/replace pair.
		expect(screen.getAllByRole("textbox").length).toBe(1);
	});

	test("renders existing entries as single-column term rows", () => {
		renderWith({ entries: [sampleEntry] });
		expect(screen.getByText("Kubernetes")).toBeDefined();
	});

	test("clicking the per-row delete button calls onRemove with the entry id", () => {
		const { onRemove } = renderWith({ entries: [sampleEntry] });
		const deleteBtn = screen.getByRole("button", { name: /delete\s+"Kubernetes"/i });
		fireEvent.click(deleteBtn);
		expect(onRemove).toHaveBeenCalledWith("1");
	});

	test("the Add button is disabled when term is empty", () => {
		renderWith({});
		const buttons = screen.getAllByRole("button");
		const addBtn = buttons.find((b) => (b.textContent ?? "").trim().toLowerCase() === "add");
		expect(addBtn).toBeDefined();
		expect((addBtn as HTMLButtonElement).disabled).toBe(true);
	});

	test("renders a 'Delete All' control when onClearAll is provided", () => {
		const onClearAll = mock(() => undefined);
		renderWith({ entries: [sampleEntry], onClearAll });
		const buttons = screen.getAllByRole("button");
		const deleteAll = buttons.find((b) => (b.textContent ?? "").toLowerCase().includes("all"));
		expect(deleteAll).toBeDefined();
	});
});
