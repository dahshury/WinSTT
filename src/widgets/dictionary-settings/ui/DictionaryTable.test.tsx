import { describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import type { DictionaryEntry } from "@/shared/config/settings-schema";
import { DictionaryTable } from "./DictionaryTable";

function renderTable(
	entries: DictionaryEntry[] = [],
	onChange = mock(() => undefined),
) {
	const utils = render(
		<IntlProvider>
			<DictionaryTable entries={entries} onChange={onChange} />
		</IntlProvider>,
	);
	return { ...utils, onChange };
}

describe("DictionaryTable", () => {
	test("renders without crashing", () => {
		const { container } = renderTable();
		expect(container.firstElementChild).not.toBeNull();
	});

	test("renders the term and source column headers", () => {
		renderTable([{ id: "1", term: "Kubernetes" }]);
		expect(screen.getAllByText("Term").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Source").length).toBeGreaterThan(0);
	});

	test("renders the grid toolbar", () => {
		const { container } = renderTable();
		expect(container.querySelector('[role="toolbar"]')).not.toBeNull();
	});
});
