import { describe, expect, mock, test } from "bun:test";
import {
	AuthorFilterSubmenu,
	__author_filter_submenu_test_helpers__ as helpers,
} from "./AuthorFilterSubmenu";

describe("AuthorFilterSubmenu", () => {
	test("module exports the component (full render requires a parent Menu popup)", () => {
		expect(typeof AuthorFilterSubmenu).toBe("function");
	});
});

describe("AuthorFilterSubmenu helpers", () => {
	describe("filterByQuery", () => {
		test("returns the original list when the query is empty", () => {
			const all = ["openai", "anthropic", "google"];
			expect(helpers.filterByQuery(all, "")).toBe(all);
		});

		test("filters case-insensitively by substring", () => {
			expect(helpers.filterByQuery(["OpenAI", "Anthropic", "Google"], "ai")).toEqual(["OpenAI"]);
		});

		test("returns empty array when nothing matches", () => {
			expect(helpers.filterByQuery(["openai", "anthropic"], "xyz")).toEqual([]);
		});
	});

	describe("getFavoriteTooltipText", () => {
		test.each([
			[true, "Remove from favorites"],
			[false, "Add to favorites"],
		])("isFavorite=%p → %p", (isFavorite, expected) => {
			expect(helpers.getFavoriteTooltipText(isFavorite)).toBe(expected);
		});
	});

	describe("handleFavoriteButtonClick", () => {
		test("stops event propagation and toggles favorite", () => {
			const stopPropagation = mock(() => undefined);
			const onToggleFavorite = mock(() => undefined);
			const event = { stopPropagation } as unknown as React.MouseEvent;
			helpers.handleFavoriteButtonClick(event, "openai", onToggleFavorite);
			expect(stopPropagation).toHaveBeenCalledTimes(1);
			expect(onToggleFavorite).toHaveBeenCalledWith("openai");
		});

		test("forwards the provider name unchanged", () => {
			const onToggleFavorite = mock(() => undefined);
			const event = { stopPropagation: () => undefined } as unknown as React.MouseEvent;
			helpers.handleFavoriteButtonClick(event, "anthropic", onToggleFavorite);
			expect(onToggleFavorite).toHaveBeenCalledWith("anthropic");
		});
	});
});
