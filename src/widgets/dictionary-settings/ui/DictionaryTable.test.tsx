import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
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

	test("renders the grid toolbar", () => {
		const { container } = renderTable();
		expect(container.querySelector('[role="toolbar"]')).not.toBeNull();
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
