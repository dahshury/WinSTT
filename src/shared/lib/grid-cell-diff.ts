import type { UndoRedoCellUpdate } from "@/shared/ui/data-grid/model/use-data-grid-undo-redo";

/**
 * Diff two same-identity row arrays into the cell-level updates the data grid's
 * undo/redo history expects. Rows are matched by `id`; only the supplied
 * `columnIds` (the editable accessors) are compared. Used by the Dictionary and
 * Snippets grids to feed `trackCellsUpdate` from their `onDataChange`.
 */
export function cellUpdatesBetween<TData extends { id: string }>(
	previous: readonly TData[],
	next: readonly TData[],
	columnIds: readonly string[],
): UndoRedoCellUpdate[] {
	const previousById = new Map(previous.map((row) => [row.id, row]));
	const updates: UndoRedoCellUpdate[] = [];

	for (const nextRow of next) {
		const previousRow = previousById.get(nextRow.id);
		if (!previousRow) continue;
		for (const columnId of columnIds) {
			const previousValue = (previousRow as Record<string, unknown>)[columnId];
			const newValue = (nextRow as Record<string, unknown>)[columnId];
			if (!Object.is(previousValue, newValue)) {
				updates.push({
					columnId,
					newValue,
					previousValue,
					rowId: nextRow.id,
				});
			}
		}
	}

	return updates;
}
