import { describe, expect, test } from "bun:test";
import {
	fireEvent,
	render,
	screen,
} from "@/shared/ui/model-picker/test/render-with-intl";
import type { ColumnDef } from "@tanstack/react-table";
import { useDataGrid } from "./model/use-data-grid";
import { DataGridTableControls } from "./data-grid-table-controls";

interface Row {
	id: string;
	name: string;
}

const columns: ColumnDef<Row>[] = [
	{
		accessorKey: "name",
		enableHiding: true,
		id: "name",
		meta: { label: "Name" },
	},
];

function Harness({ showSortControl = true }: { showSortControl?: boolean }) {
	const { table } = useDataGrid({
		columns,
		data: [{ id: "1", name: "Alpha" }],
		getRowId: (row) => row.id,
		onDataChange: () => undefined,
	});
	return (
		<DataGridTableControls showSortControl={showSortControl} table={table} />
	);
}

const open = () =>
	fireEvent.click(screen.getByRole("button", { name: /Table controls/ }));

describe("DataGridTableControls", () => {
	test("lists every table dimension on one root view", () => {
		render(<Harness />);
		open();

		for (const row of [/^Filter/, /^Sort/, /^Row height/, /^View/]) {
			expect(screen.getByRole("button", { name: row })).not.toBeNull();
		}
	});

	test("row-height and columns rows summarise their current value", () => {
		render(<Harness />);
		open();

		expect(
			screen.getByRole("button", { name: /^Row height/ }).textContent,
		).toContain("Short");
		// One hideable column, currently visible.
		expect(screen.getByRole("button", { name: /^View/ }).textContent).toContain(
			"1/1",
		);
	});

	test("omits the sort row when the host disables sorting", () => {
		render(<Harness showSortControl={false} />);
		open();

		expect(screen.queryByRole("button", { name: /^Sort/ })).toBeNull();
		expect(screen.getByRole("button", { name: /^Filter/ })).not.toBeNull();
	});

	test("drilling into row height picks a height and back returns", () => {
		render(<Harness />);
		open();
		fireEvent.click(screen.getByRole("button", { name: /^Row height/ }));

		const tall = screen.getByRole("button", { name: "Tall" });
		expect(tall).not.toBeNull();
		expect(screen.queryByRole("button", { name: /^View/ })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /^Back to/ }));
		expect(screen.getByRole("button", { name: /^View/ })).not.toBeNull();
	});

	test("Ctrl+Shift+F opens the popover at the filter view", () => {
		render(<Harness />);

		fireEvent.keyDown(window, { ctrlKey: true, key: "f", shiftKey: true });

		// Straight into the builder, not the root list.
		expect(screen.getByRole("button", { name: /^Add filter/ })).not.toBeNull();
		expect(screen.queryByRole("button", { name: /^Row height/ })).toBeNull();
	});
});
