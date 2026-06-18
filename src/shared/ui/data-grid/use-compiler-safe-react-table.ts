import {
	createTable,
	type RowData,
	type Table,
	type TableOptions,
	type TableOptionsResolved,
} from "@tanstack/react-table";
import { useState } from "react";

export function useCompilerSafeReactTable<TData extends RowData>(
	options: TableOptions<TData>,
): Table<TData> {
	const resolvedOptions: TableOptionsResolved<TData> = {
		state: {},
		onStateChange: () => undefined,
		renderFallbackValue: null,
		...options,
	};

	const [table] = useState(() => createTable<TData>(resolvedOptions));
	const [state, setState] = useState(() => table.initialState);

	table.setOptions((prev) => ({
		...prev,
		...options,
		state: {
			...state,
			...options.state,
		},
		onStateChange: (updater) => {
			setState(updater);
			options.onStateChange?.(updater);
		},
	}));

	return table;
}
