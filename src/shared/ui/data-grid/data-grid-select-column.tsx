import type { ColumnDef } from "@tanstack/react-table";
import {
	DataGridSelectCell,
	DataGridSelectHeader,
	type HitboxSize,
} from "@/shared/ui/data-grid/data-grid-select-column-cells";

interface GetDataGridSelectColumnOptions<TData> extends Omit<
	Partial<ColumnDef<TData>>,
	"id" | "header" | "cell"
> {
	enableRowMarkers?: boolean;
	readOnly?: boolean;
	hitboxSize?: HitboxSize;
	debug?: boolean;
}

export function getDataGridSelectColumn<TData>({
	size = 40,
	hitboxSize = "default",
	enableHiding = false,
	enableResizing = false,
	enableSorting = false,
	enableRowMarkers = false,
	readOnly = false,
	debug = false,
	...props
}: GetDataGridSelectColumnOptions<TData> = {}): ColumnDef<TData> {
	return {
		id: "select",
		header: ({ table }) => (
			<DataGridSelectHeader
				table={table}
				hitboxSize={hitboxSize}
				readOnly={readOnly}
				debug={debug}
			/>
		),
		cell: ({ row, table }) => (
			<DataGridSelectCell
				row={row}
				table={table}
				enableRowMarkers={enableRowMarkers}
				readOnly={readOnly}
				hitboxSize={hitboxSize}
				debug={debug}
			/>
		),
		size,
		enableHiding,
		enableResizing,
		enableSorting,
		...props,
	};
}
