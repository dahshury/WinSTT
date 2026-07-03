import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
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

function manySnippets(count: number): SnippetEntry[] {
	return Array.from({ length: count }, (_, index) => ({
		expansion: `Expansion ${index + 1}`,
		id: String(index + 1),
		trigger: `/s${index + 1}`,
	}));
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

	test("renders complete pagination with disabled boundary controls", () => {
		renderTable(manySnippets(40));

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
});
