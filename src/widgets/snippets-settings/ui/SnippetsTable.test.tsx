import { describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { SnippetEntry } from "@/bindings";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { SnippetsTable } from "./SnippetsTable";

function renderTable(
	entries: SnippetEntry[] = [],
	onChange = mock(() => undefined),
) {
	const utils = render(
		<IntlProvider>
			<SnippetsTable entries={entries} onChange={onChange} />
		</IntlProvider>,
	);
	return { ...utils, onChange };
}

describe("SnippetsTable", () => {
	test("renders without crashing", () => {
		const { container } = renderTable();
		expect(container.firstElementChild).not.toBeNull();
	});

	test("renders the trigger and expansion column headers", () => {
		renderTable([{ expansion: "on my way", id: "1", trigger: "omw" }]);
		expect(screen.getAllByText("Trigger").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Expansion").length).toBeGreaterThan(0);
	});

	test("renders the grid toolbar", () => {
		const { container } = renderTable();
		expect(container.querySelector('[role="toolbar"]')).not.toBeNull();
	});
});
