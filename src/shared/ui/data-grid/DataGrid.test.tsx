import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import {
	type ColumnDef,
	getCoreRowModel,
	getFilteredRowModel,
	getPaginationRowModel,
	getSortedRowModel,
	type PaginationState,
	type SortingState,
	type VisibilityState,
} from "@tanstack/react-table";
import { useState } from "react";
import {
	DataGrid,
	DataGridContainer,
	type DataGridLabels,
	DataGridPagination,
	DataGridTable,
	DataGridToolbar,
} from "./index";
import { useCompilerSafeReactTable } from "./use-compiler-safe-react-table";

interface Fruit {
	id: string;
	name: string;
	value: string;
}

const LABELS: DataGridLabels = {
	columns: "Columns",
	emptyState: "No data",
	nextPage: "Next page",
	noResults: "No results",
	previousPage: "Previous page",
	rowsPerPage: "Rows per page",
	search: "Search",
	formatPaginationInfo: ({ count, from, to }) => `${from}-${to} of ${count}`,
	formatSortBy: (column) => `Sort by ${column}`,
};

const COLUMNS: ColumnDef<Fruit>[] = [
	{
		accessorFn: (row) => row.name,
		cell: (ctx) => ctx.row.original.name,
		enableHiding: true,
		enableSorting: true,
		header: "Name",
		id: "Name",
		meta: { title: "Name" },
	},
	{
		accessorFn: (row) => row.value,
		cell: (ctx) => ctx.row.original.value,
		enableHiding: true,
		enableSorting: true,
		header: "Value",
		id: "Value",
		meta: { title: "Value" },
	},
];

function Harness({
	data,
	initialPageSize = 10,
	initialVisibility = {},
}: {
	data: Fruit[];
	initialPageSize?: number;
	initialVisibility?: VisibilityState;
}) {
	"use no memo";
	const [sorting, setSorting] = useState<SortingState>([]);
	const [globalFilter, setGlobalFilter] = useState("");
	const [columnVisibility, setColumnVisibility] =
		useState<VisibilityState>(initialVisibility);
	const [pagination, setPagination] = useState<PaginationState>({
		pageIndex: 0,
		pageSize: initialPageSize,
	});
	const table = useCompilerSafeReactTable<Fruit>({
		columns: COLUMNS,
		data,
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
		getRowId: (row) => row.id,
		getSortedRowModel: getSortedRowModel(),
		onColumnVisibilityChange: setColumnVisibility,
		onGlobalFilterChange: setGlobalFilter,
		onPaginationChange: setPagination,
		onSortingChange: setSorting,
		state: { columnVisibility, globalFilter, pagination, sorting },
	});
	return (
		<DataGrid labels={LABELS} table={table}>
			<DataGridToolbar columnControls searchable />
			<DataGridContainer>
				<DataGridTable />
			</DataGridContainer>
			<DataGridPagination />
		</DataGrid>
	);
}

const FRUITS: Fruit[] = [
	{ id: "1", name: "Banana", value: "yellow" },
	{ id: "2", name: "Apple", value: "red" },
	{ id: "3", name: "Cherry", value: "dark" },
];

function firstColumnCells(): string[] {
	// Two columns visible → cells[0], cells[2], cells[4] are the Name cells.
	const cells = screen.getAllByRole("cell");
	return cells
		.filter((_, index) => index % 2 === 0)
		.map((cell) => cell.textContent ?? "");
}

describe("DataGrid", () => {
	test("clicking a sortable header reorders the rows", () => {
		render(<Harness data={FRUITS} />);
		expect(firstColumnCells()).toEqual(["Banana", "Apple", "Cherry"]);

		fireEvent.click(screen.getByRole("button", { name: "Sort by Name" }));
		expect(firstColumnCells()).toEqual(["Apple", "Banana", "Cherry"]);

		fireEvent.click(screen.getByRole("button", { name: "Sort by Name" }));
		expect(firstColumnCells()).toEqual(["Cherry", "Banana", "Apple"]);
	});

	test("the search box is a searchbox (not a textbox) and filters rows", () => {
		render(<Harness data={FRUITS} />);
		// The grid's search must not register as a `textbox` (Dictionary's add
		// field relies on being the only textbox).
		expect(screen.queryAllByRole("textbox")).toHaveLength(0);
		const search = screen.getByRole("searchbox", { name: "Search" });

		fireEvent.change(search, { target: { value: "Apple" } });
		expect(screen.getByText("Apple")).toBeDefined();
		expect(screen.queryByText("Banana")).toBeNull();
		expect(screen.queryByText("Cherry")).toBeNull();
	});

	test("shows the no-results state when a filter matches nothing", () => {
		render(<Harness data={FRUITS} />);
		fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), {
			target: { value: "zzz" },
		});
		expect(screen.getByText("No results")).toBeDefined();
	});

	test("pagination splits rows across pages and disables the edges", () => {
		render(<Harness data={FRUITS} initialPageSize={2} />);
		expect(firstColumnCells()).toEqual(["Banana", "Apple"]);
		expect(screen.getByText("1-2 of 3")).toBeDefined();

		const previous = screen.getByRole("button", { name: "Previous page" });
		const next = screen.getByRole("button", { name: "Next page" });
		expect(
			screen
				.getByRole("button", { name: "Page 1" })
				.getAttribute("aria-current"),
		).toBe("page");
		expect(screen.getByRole("button", { name: "Page 2" })).toBeDefined();
		expect((previous as HTMLButtonElement).disabled).toBe(true);
		expect((next as HTMLButtonElement).disabled).toBe(false);

		fireEvent.click(next);
		expect(firstColumnCells()).toEqual(["Cherry"]);
		expect(screen.getByText("3-3 of 3")).toBeDefined();
		expect(
			(screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	test("a hidden column is not rendered", () => {
		render(<Harness data={FRUITS} initialVisibility={{ Value: false }} />);
		// Header + the "Columns" menu trigger reference the title, but the menu is
		// closed, so the only place "Value" could appear is the hidden header.
		expect(screen.queryByRole("columnheader", { name: "Value" })).toBeNull();
		expect(screen.queryByText("yellow")).toBeNull();
		expect(screen.getByText("Banana")).toBeDefined();
	});

	test("renders the empty state with no rows", () => {
		render(<Harness data={[]} />);
		expect(screen.getByText("No data")).toBeDefined();
	});
});
