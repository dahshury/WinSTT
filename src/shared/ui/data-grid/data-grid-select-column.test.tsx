import { expect, test } from "bun:test";
import { getDataGridSelectColumn } from "./data-grid-select-column";

test("keeps the shared selection column at its compact requested width", () => {
	const defaultColumn = getDataGridSelectColumn<unknown>();
	const customColumn = getDataGridSelectColumn<unknown>({ size: 36 });

	expect(defaultColumn.size).toBe(40);
	expect(defaultColumn.minSize).toBe(40);
	expect(customColumn.size).toBe(36);
	expect(customColumn.minSize).toBe(36);
});
