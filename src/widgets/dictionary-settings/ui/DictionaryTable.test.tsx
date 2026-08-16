import { describe, expect, mock, test } from "bun:test";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
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

function manyTerms(count: number): DictionaryEntry[] {
	return Array.from({ length: count }, (_, index) => ({
		id: String(index + 1),
		term: `Term ${index + 1}`,
	}));
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

	test("renders the grid's table-controls trigger", () => {
		// Filters / Sort / Row height / Columns are one drill-down popover now,
		// so the toolbar of four buttons is a single count-badged trigger.
		renderTable();
		expect(
			screen.getByRole("button", { name: /Table controls/ }),
		).not.toBeNull();
	});

	test("renders complete pagination with disabled boundary controls", () => {
		renderTable(manyTerms(40));

		const pagination = screen.getByRole("navigation", {
			name: "Page 1 of 8",
		});
		const previous = within(pagination).getByRole("button", {
			name: "Previous page",
		});
		const current = within(pagination).getByRole("button", {
			name: "Page 1 of 8",
		});
		const next = within(pagination).getByRole("button", {
			name: "Next page",
		});

		expect(previous.hasAttribute("disabled")).toBe(true);
		expect(current.getAttribute("aria-current")).toBe("page");
		expect(
			within(pagination).getByRole("button", { name: "Page 2 of 8" }),
		).toBeDefined();
		expect(within(pagination).getByText("...")).toBeDefined();
		expect(
			within(pagination).getByRole("button", { name: "Page 8 of 8" }),
		).toBeDefined();
		expect(next.hasAttribute("disabled")).toBe(false);

		fireEvent.click(
			within(pagination).getByRole("button", { name: "Page 8 of 8" }),
		);
		const lastPagePagination = screen.getByRole("navigation", {
			name: "Page 8 of 8",
		});
		expect(
			within(lastPagePagination)
				.getByRole("button", { name: "Next page" })
				.hasAttribute("disabled"),
		).toBe(true);
	});

	test("scopes Ctrl+F to the focused grid and searches every page", async () => {
		render(
			<IntlProvider>
				<DictionaryTable entries={manyTerms(40)} onChange={() => undefined} />
				<DictionaryTable
					entries={[{ id: "other", term: "Other table" }]}
					onChange={() => undefined}
				/>
			</IntlProvider>,
		);
		const grids = screen.getAllByRole("grid");
		expect(grids[0]).toBeDefined();
		fireEvent.keyDown(grids[0] as HTMLElement, { ctrlKey: true, key: "f" });
		const search = await screen.findByPlaceholderText("Find in table...");
		expect(screen.getAllByPlaceholderText("Find in table...")).toHaveLength(1);

		fireEvent.change(search, {
			target: { value: "Term 40" },
		});
		await waitFor(() =>
			expect(
				screen.getByRole("navigation", { name: "Page 8 of 8" }),
			).toBeDefined(),
		);
	});

	test("keeps row selection active while the delete control is pressed", () => {
		const entries = [
			{ id: "1", term: "visualizer" },
			{ id: "2", term: "race" },
		] satisfies DictionaryEntry[];
		const { container, onChange } = renderTable(entries);

		const selectAll = container.querySelector<HTMLElement>(
			'[aria-label="Select all"]',
		);
		expect(selectAll).not.toBeNull();
		fireEvent.click(selectAll as HTMLElement);

		const deleteButton = screen.getByRole("button", { name: "Delete rows" });
		const elementsFromPointDescriptor = Object.getOwnPropertyDescriptor(
			document,
			"elementsFromPoint",
		);
		Object.defineProperty(document, "elementsFromPoint", {
			configurable: true,
			value: () => [],
		});
		try {
			fireEvent.mouseDown(deleteButton);
			expect(screen.getByRole("button", { name: "Delete rows" })).toBe(
				deleteButton,
			);
		} finally {
			if (elementsFromPointDescriptor) {
				Object.defineProperty(
					document,
					"elementsFromPoint",
					elementsFromPointDescriptor,
				);
			} else {
				Reflect.deleteProperty(document, "elementsFromPoint");
			}
		}

		fireEvent.click(deleteButton);
		expect(onChange).toHaveBeenCalledWith([]);
	});
});
