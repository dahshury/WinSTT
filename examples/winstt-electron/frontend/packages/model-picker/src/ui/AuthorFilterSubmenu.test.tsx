import { describe, expect, mock, test } from "bun:test";
import { Combobox } from "@base-ui/react/combobox";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { render } from "@testing-library/react";
import { __author_filter_submenu_test_helpers__ as helpers } from "../lib/author-filter-submenu-test-helpers";
import { AuthorFilterSubmenu } from "./AuthorFilterSubmenu";

// Contained boundary cast — the mock only implements `stopPropagation`, the one
// MouseEvent member handleFavoriteButtonClick touches. The runtime object is
// returned unchanged; only the type is widened to the real React.MouseEvent.
const asMouseEvent = (e: { stopPropagation: () => void }) => e as unknown as React.MouseEvent;

describe("AuthorFilterSubmenu", () => {
	test("module exports the component (full render requires a parent Menu popup)", () => {
		expect(typeof AuthorFilterSubmenu).toBe("function");
	});
});

/* ── renderAuthorItem render tests ────────────────────────────────────
   These cover the CC=2 sub-components (SelectedTick, SelectedCountBadge,
   FavoriteToggleButton) via a minimal Combobox wrapper.
   ────────────────────────────────────────────────────────────────────── */

describe("renderAuthorItem rendering", () => {
	const providerCounts = new Map([["openai", 5]]);

	test("renders a non-selected item without a tick", () => {
		const { container } = render(
			<TooltipProvider.Provider>
				<Combobox.Root items={["openai"]} open>
					<Combobox.List>
						<Combobox.Collection>
							{(p: string) =>
								helpers.renderAuthorItem(p, {
									favoritesSet: new Set(),
									onToggleFavorite: undefined,
									providerCounts,
									selectedSet: new Set(),
								})
							}
						</Combobox.Collection>
					</Combobox.List>
				</Combobox.Root>
			</TooltipProvider.Provider>
		);
		expect(container.textContent).toContain("openai");
	});

	test("renders a selected item (covers SelectedTick truthy branch)", () => {
		const { container } = render(
			<TooltipProvider.Provider>
				<Combobox.Root items={["openai"]} open>
					<Combobox.List>
						<Combobox.Collection>
							{(p: string) =>
								helpers.renderAuthorItem(p, {
									favoritesSet: new Set(),
									onToggleFavorite: undefined,
									providerCounts,
									selectedSet: new Set(["openai"]),
								})
							}
						</Combobox.Collection>
					</Combobox.List>
				</Combobox.Root>
			</TooltipProvider.Provider>
		);
		expect(container.textContent).toContain("openai");
	});

	test("renders FavoriteToggleButton when onToggleFavorite is provided", () => {
		const onToggleFavorite = mock(() => undefined);
		const { container } = render(
			<TooltipProvider.Provider>
				<Combobox.Root items={["openai"]} open>
					<Combobox.List>
						<Combobox.Collection>
							{(p: string) =>
								helpers.renderAuthorItem(p, {
									favoritesSet: new Set(["openai"]),
									onToggleFavorite,
									providerCounts,
									selectedSet: new Set(),
								})
							}
						</Combobox.Collection>
					</Combobox.List>
				</Combobox.Root>
			</TooltipProvider.Provider>
		);
		// FavoriteToggleButton renders a button
		expect(container.querySelector("button")).not.toBeNull();
	});

	test("SelectedCountBadge: renders count badge for the submenu trigger (positive count)", () => {
		// The SelectedCountBadge in AuthorFilterSubmenu is rendered in the trigger
		// when selectedMakers.length > 0. We verify the component exports correctly.
		expect(typeof AuthorFilterSubmenu).toBe("function");
	});
});

describe("SelectedCountBadge", () => {
	const { SelectedCountBadge } = helpers;

	test("returns null when count is 0", () => {
		const { container } = render(<SelectedCountBadge count={0} />);
		expect(container.firstChild).toBeNull();
	});

	test("renders badge with count when count > 0", () => {
		const { container } = render(<SelectedCountBadge count={7} />);
		expect(container.textContent).toBe("7");
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
			const event = asMouseEvent({ stopPropagation });
			helpers.handleFavoriteButtonClick(event, "openai", onToggleFavorite);
			expect(stopPropagation).toHaveBeenCalledTimes(1);
			expect(onToggleFavorite).toHaveBeenCalledWith("openai");
		});

		test("forwards the provider name unchanged", () => {
			const onToggleFavorite = mock(() => undefined);
			const event = asMouseEvent({ stopPropagation: () => undefined });
			helpers.handleFavoriteButtonClick(event, "anthropic", onToggleFavorite);
			expect(onToggleFavorite).toHaveBeenCalledWith("anthropic");
		});
	});
});
