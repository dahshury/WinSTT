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

	test("renders the term add action as one joined input group without a visible label strip", () => {
		const { container } = renderWith({});
		const group = screen.getByRole("toolbar", { name: /add/i });
		expect(group).toBeDefined();
		expect(group.className).toContain("divide-x");
		const hiddenTermLabels = Array.from(
			container.querySelectorAll('[aria-hidden="true"]'),
		).filter((el) => el.textContent?.trim() === "Term");
		expect(hiddenTermLabels).toHaveLength(0);
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

	test("selecting a row and clicking delete calls onRemove with the entry id", () => {
		const { onRemove } = renderWith({ entries: [sampleEntry] });
		fireEvent.click(
			screen.getByRole("checkbox", {
				name: /select\s+"Kubernetes"/i,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: /delete \(1\)/i }));

		expect(onRemove).toHaveBeenCalledWith("1");
	});

	test("selected rows use the batch remove callback when provided", () => {
		const onRemove = mock(() => undefined);
		const onRemoveMany = mock(() => undefined);
		renderWith({
			entries: [sampleEntry, { id: "2", term: "DirectML" }],
			onRemove,
			onRemoveMany,
		});

		fireEvent.click(
			screen.getByRole("checkbox", {
				name: /select\s+"Kubernetes"/i,
			}),
		);
		fireEvent.click(
			screen.getByRole("checkbox", {
				name: /select\s+"DirectML"/i,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: /delete \(2\)/i }));

		expect(onRemoveMany).toHaveBeenCalledWith(["1", "2"]);
		expect(onRemove).not.toHaveBeenCalled();
	});

	test("editing a row calls onUpdate with the trimmed term", () => {
		const onUpdate = mock(() => undefined);
		renderWith({ entries: [sampleEntry], onUpdate });

		fireEvent.doubleClick(screen.getByText("Kubernetes"));
		const input = screen.getByDisplayValue("Kubernetes");
		fireEvent.change(input, {
			target: { value: " DirectML " },
		});
		fireEvent.keyDown(input, { key: "Enter" });

		expect(onUpdate).toHaveBeenCalledWith("1", { term: "DirectML" });
	});

	test("editing a row rejects duplicate terms case-insensitively", () => {
		const onUpdate = mock(() => undefined);
		renderWith({
			entries: [sampleEntry, { id: "2", term: "DirectML" }],
			onUpdate,
		});

		fireEvent.doubleClick(screen.getByText("Kubernetes"));
		const input = screen.getByDisplayValue("Kubernetes");
		fireEvent.change(input, {
			target: { value: " directml " },
		});
		fireEvent.keyDown(input, { key: "Enter" });

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
