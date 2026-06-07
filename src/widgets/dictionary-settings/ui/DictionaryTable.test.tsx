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
			<DictionaryTable
				entries={[]}
				onAdd={onAdd}
				onRemove={onRemove}
				{...props}
			/>
		</IntlProvider>,
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
		expect(screen.getByText("Manual")).toBeDefined();
	});

	test("marks auto-added entries", () => {
		renderWith({ entries: [{ ...sampleEntry, autoAdded: true }] });
		expect(screen.getByText("Kubernetes")).toBeDefined();
		expect(screen.getByText("Auto")).toBeDefined();
	});

	test("clicking the per-row delete button calls onRemove with the entry id", () => {
		const { onRemove } = renderWith({ entries: [sampleEntry] });
		const deleteBtn = screen.getByRole("button", {
			name: /delete\s+"Kubernetes"/i,
		});
		fireEvent.click(deleteBtn);
		expect(onRemove).toHaveBeenCalledWith("1");
	});

	test("editing a row calls onUpdate with the trimmed term", () => {
		const onUpdate = mock(() => undefined);
		renderWith({ entries: [sampleEntry], onUpdate });

		fireEvent.click(
			screen.getByRole("button", { name: /edit\s+"Kubernetes"/i }),
		);
		fireEvent.change(screen.getByDisplayValue("Kubernetes"), {
			target: { value: " DirectML " },
		});
		fireEvent.click(
			screen.getByRole("button", { name: /save\s+"Kubernetes"/i }),
		);

		expect(onUpdate).toHaveBeenCalledWith("1", { term: "DirectML" });
	});

	test("editing a row rejects duplicate terms case-insensitively", () => {
		const onUpdate = mock(() => undefined);
		renderWith({
			entries: [sampleEntry, { id: "2", term: "DirectML" }],
			onUpdate,
		});

		fireEvent.click(
			screen.getByRole("button", { name: /edit\s+"Kubernetes"/i }),
		);
		fireEvent.change(screen.getByDisplayValue("Kubernetes"), {
			target: { value: " directml " },
		});
		fireEvent.click(
			screen.getByRole("button", { name: /save\s+"Kubernetes"/i }),
		);

		expect(onUpdate).not.toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).toContain("Already added");
	});

	test("the Add button is disabled when term is empty", () => {
		renderWith({});
		// The Add action now lives in the input-group's trailing slot as an
		// icon button, so it's found by its accessible name, not its text.
		const addBtn = screen.getByRole("button", { name: /add/i });
		expect((addBtn as HTMLButtonElement).disabled).toBe(true);
	});

	test("rejects duplicate terms case-insensitively", () => {
		const { onAdd } = renderWith({ entries: [sampleEntry] });
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: " kubernetes " } });
		fireEvent.click(screen.getByRole("button", { name: /add/i }));

		expect(onAdd).not.toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).toContain("Already added");
	});

	test("renders a 'Delete All' control when onClearAll is provided", () => {
		const onClearAll = mock(() => undefined);
		renderWith({ entries: [sampleEntry], onClearAll });
		const buttons = screen.getAllByRole("button");
		const deleteAll = buttons.find((b) =>
			(b.textContent ?? "").toLowerCase().includes("all"),
		);
		expect(deleteAll).toBeDefined();
	});
});
