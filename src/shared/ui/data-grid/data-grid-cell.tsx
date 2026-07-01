import * as React from "react";

import {
	CheckboxCell,
	DateCell,
	FileCell,
	LongTextCell,
	MultiSelectCell,
	NumberCell,
	SelectCell,
	ShortTextCell,
	UrlCell,
} from "@/shared/ui/data-grid/data-grid-cell-variants";
import type { DataGridCellProps } from "@/shared/ui/data-grid/types";

export function DataGridCell<TData>({
	cell,
	tableMeta,
	rowIndex,
	columnId,
	state,
	rowHeight,
}: DataGridCellProps<TData>) {
	const cellOpts = cell.column.columnDef.meta?.cell;
	const variant = cellOpts?.variant ?? "text";

	let Comp: React.ComponentType<DataGridCellProps<TData>>;

	switch (variant) {
		case "short-text":
			Comp = ShortTextCell;
			break;
		case "long-text":
			Comp = LongTextCell;
			break;
		case "number":
			Comp = NumberCell;
			break;
		case "url":
			Comp = UrlCell;
			break;
		case "checkbox":
			Comp = CheckboxCell;
			break;
		case "select":
			Comp = SelectCell;
			break;
		case "multi-select":
			Comp = MultiSelectCell;
			break;
		case "date":
			Comp = DateCell;
			break;
		case "file":
			Comp = FileCell;
			break;

		default:
			Comp = ShortTextCell;
			break;
	}

	return (
		<Comp
			cell={cell}
			tableMeta={tableMeta}
			rowIndex={rowIndex}
			columnId={columnId}
			rowHeight={rowHeight}
			state={state}
		/>
	);
}
