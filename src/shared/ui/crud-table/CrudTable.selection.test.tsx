import { Tag01Icon } from "@hugeicons/core-free-icons";
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { z } from "zod";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { CrudTable } from "./CrudTable";
import type { CrudColumn, CrudField, CrudTableLabels } from "./types";

interface Row {
	id: string;
	term: string;
}

const LABELS: CrudTableLabels = {
	add: "Add",
	cancel: "Cancel",
	clearDescription: "",
	clearTitle: "",
	delete: "Delete",
	deleteAll: "Delete all",
	edit: "Edit",
	emptyState: "empty",
	save: "Save",
	selectAll: "Select all rows",
};
const FIELDS: CrudField[] = [
	{ icon: Tag01Icon, label: "Term", name: "term", placeholder: "term" },
];
const COLUMNS: CrudColumn<Row>[] = [
	{ editFieldName: "term", header: "Term", render: (e) => e.term },
];
const schema = z.object({ term: z.string().min(1) });

const SEVEN: Row[] = [
	{ id: "1", term: "alpha" },
	{ id: "2", term: "beta" },
	{ id: "3", term: "gamma" },
	{ id: "4", term: "delta" },
	{ id: "5", term: "epsilon" },
	{ id: "6", term: "zeta" },
	{ id: "7", term: "eta" },
];

function Harness() {
	// New array reference each render (matches the settings-store -> entries flow), pageSize 5 so
	// there are multiple pages — exactly DictionaryTable's config.
	const [rows, setRows] = useState<Row[]>(() => SEVEN.map((r) => ({ ...r })));
	return (
		<IntlProvider>
			<CrudTable<Row, { term: string }>
				columnControls
				columns={COLUMNS}
				deleteLabelFor={(e) => e.term}
				entries={rows.map((r) => ({ ...r }))}
				fields={FIELDS}
				getId={(e) => e.id}
				labels={LABELS}
				onAdd={() => {}}
				onRemove={(id) => setRows((r) => r.filter((x) => x.id !== id))}
				onRemoveMany={(ids) =>
					setRows((r) => r.filter((x) => !ids.includes(x.id)))
				}
				onUpdate={() => {}}
				pageSize={5}
				paginated
				schema={schema}
				searchable
				sortable
			/>
		</IntlProvider>
	);
}

function rowCheckbox(name: string): HTMLInputElement {
	return screen.getByRole("checkbox", { name }) as HTMLInputElement;
}

describe("CrudTable row selection", () => {
	test("a row toggles selected then UNselected", () => {
		render(<Harness />);
		const alpha = rowCheckbox('Select "alpha"');
		expect(alpha.checked).toBe(false);
		fireEvent.click(alpha);
		expect(rowCheckbox('Select "alpha"').checked).toBe(true);
		fireEvent.click(rowCheckbox('Select "alpha"'));
		expect(rowCheckbox('Select "alpha"').checked).toBe(false);
	});

	test("select-all selects every row, then clears", () => {
		render(<Harness />);
		const selectAll = rowCheckbox("Select all rows");
		fireEvent.click(selectAll);
		// all rows now checked
		for (const term of ["alpha", "beta", "gamma"]) {
			expect(rowCheckbox(`Select "${term}"`).checked).toBe(true);
		}
		expect(rowCheckbox("Select all rows").checked).toBe(true);
		// click again -> everything clears
		fireEvent.click(rowCheckbox("Select all rows"));
		for (const term of ["alpha", "beta", "gamma"]) {
			expect(rowCheckbox(`Select "${term}"`).checked).toBe(false);
		}
		expect(rowCheckbox("Select all rows").checked).toBe(false);
	});
});
