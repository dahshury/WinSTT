import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { HistorySearchInput } from "./HistorySearchInput";

function renderInput(onQueryChange = mock((_query: string) => undefined)) {
	return {
		onQueryChange,
		...render(
			<IntlProvider>
				<HistorySearchInput count={200} hasMore onQueryChange={onQueryChange} />
			</IntlProvider>,
		),
	};
}

describe("HistorySearchInput", () => {
	test("starts as an icon and expands when clicked", () => {
		renderInput();
		const searchButton = screen.getByRole("button", {
			name: "Search history…",
		});
		expect(searchButton.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(searchButton);
		expect(searchButton.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByPlaceholderText("Search history…")).toBeDefined();
	});

	test("Ctrl+F expands and focuses the field and reports an over-limit count", () => {
		renderInput();
		fireEvent.keyDown(window, { ctrlKey: true, key: "f" });
		const input = screen.getByPlaceholderText("Search history…");
		expect(document.activeElement).toBe(input);

		fireEvent.change(input, { target: { value: "archive" } });
		expect(screen.getByText("200+ matches")).toBeDefined();
	});

	test("clear cancels the pending value and resets immediately", async () => {
		const { onQueryChange } = renderInput();
		fireEvent.keyDown(window, { ctrlKey: true, key: "f" });
		const input = screen.getByPlaceholderText("Search history…");
		fireEvent.change(input, { target: { value: "archive" } });
		fireEvent.click(
			screen.getByRole("button", { name: "Clear history search" }),
		);
		expect(onQueryChange).toHaveBeenCalledWith("");
		await new Promise((resolve) => setTimeout(resolve, 175));
		expect(onQueryChange).not.toHaveBeenCalledWith("archive");
	});

	test("Escape clears and blurs the field", () => {
		const { onQueryChange } = renderInput();
		fireEvent.keyDown(window, { ctrlKey: true, key: "f" });
		const input = screen.getByPlaceholderText("Search history…");
		fireEvent.change(input, { target: { value: "archive" } });
		input.focus();
		fireEvent.keyDown(input, { key: "Escape" });
		expect(onQueryChange).toHaveBeenCalledWith("");
		expect(document.activeElement).not.toBe(input);
		expect(
			screen
				.getByRole("button", { name: "Search history…" })
				.getAttribute("aria-expanded"),
		).toBe("false");
	});
});
