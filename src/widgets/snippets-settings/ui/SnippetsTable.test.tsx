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
			<SnippetsTable
				entries={[]}
				onAdd={onAdd}
				onRemove={onRemove}
				{...props}
			/>
		</IntlProvider>,
	);
	return { ...utils, onAdd, onRemove };
}

describe("SnippetsTable", () => {
	test("renders existing entries as trigger/expansion rows", () => {
		renderWith({ entries: [sample] });
		expect(screen.getByText("/sig")).toBeDefined();
	});

	test("selecting a row and clicking delete fires onRemove with the entry id", () => {
		const { onRemove } = renderWith({ entries: [sample] });
		fireEvent.click(
			screen.getByRole("checkbox", { name: /select\s+"\/sig"/i }),
		);
		fireEvent.click(screen.getByRole("button", { name: /delete \(1\)/i }));

		expect(onRemove).toHaveBeenCalledWith("1");
	});

	test("selected rows use the batch remove callback when provided", () => {
		const onRemove = mock(() => undefined);
		const onRemoveMany = mock(() => undefined);
		renderWith({
			entries: [
				sample,
				{ id: "2", trigger: "/bye", expansion: "See you soon" },
			],
			onRemove,
			onRemoveMany,
		});

		fireEvent.click(
			screen.getByRole("checkbox", { name: /select\s+"\/sig"/i }),
		);
		fireEvent.click(
			screen.getByRole("checkbox", { name: /select\s+"\/bye"/i }),
		);
		fireEvent.click(screen.getByRole("button", { name: /delete \(2\)/i }));

		expect(onRemoveMany).toHaveBeenCalledWith(["1", "2"]);
		expect(onRemove).not.toHaveBeenCalled();
	});

	test("editing a row calls onUpdate with trimmed trigger and expansion", () => {
		const onUpdate = mock(() => undefined);
		renderWith({
			entries: [{ id: "2", trigger: "sig", expansion: "Best regards" }],
			onUpdate,
		});

		fireEvent.doubleClick(screen.getByText("sig"));
		const triggerInput = screen.getByDisplayValue("sig");
		const expansionInput = screen.getByDisplayValue("Best regards");
		fireEvent.change(triggerInput, {
			target: { value: " /bye " },
		});
		fireEvent.change(expansionInput, {
			target: { value: " See you soon " },
		});
		fireEvent.keyDown(expansionInput, { key: "Enter" });

		expect(onUpdate).toHaveBeenCalledWith("2", {
			expansion: "See you soon",
			trigger: "/bye",
		});
	});

	test("Add button is disabled with empty inputs", () => {
		renderWith({});
		expect(screen.getByRole("searchbox", { name: /search/i })).toBeDefined();
		// The Add action now lives in the expansion field's trailing slot as an
		// icon button, so it's found by its accessible name, not its text.
		const addBtn = screen.getByRole("button", { name: /add/i });
		expect((addBtn as HTMLButtonElement).disabled).toBe(true);
	});

	test("renders trigger, expansion, and add action as one joined input group", () => {
		renderWith({});
		const group = screen.getByRole("toolbar", { name: /add/i });
		expect(group).toBeDefined();
		expect(group.className).toContain("divide-x");
		expect(screen.getByRole("textbox", { name: /trigger/i })).toBeDefined();
		expect(screen.getByRole("textbox", { name: /expansion/i })).toBeDefined();
		expect(screen.getByRole("button", { name: /add/i })).toBeDefined();
	});

	test("renders a 'Delete All' button when onClearAll is provided", () => {
		const onClearAll = mock(() => undefined);
		renderWith({ entries: [sample], onClearAll });
		const buttons = screen.getAllByRole("button");
		const deleteAll = buttons.find((b) =>
			(b.textContent ?? "").toLowerCase().includes("all"),
		);
		expect(deleteAll).toBeDefined();
	});
});
