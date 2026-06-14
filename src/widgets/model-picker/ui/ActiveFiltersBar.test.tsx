import { describe, expect, mock, test } from "bun:test";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { render, screen } from "@testing-library/react";
import { ActiveFiltersBar } from "./ActiveFiltersBar";
import {
	getVariantLabel,
	hasActiveFilters,
} from "./active-filters-bar-helpers";

function renderBar(props: Partial<Parameters<typeof ActiveFiltersBar>[0]>) {
	const onMakerToggle = mock(() => undefined);
	const onVariantSelect = mock(() => undefined);
	const onEndpointProviderSelect = mock(() => undefined);
	const onRemoveParameter = mock(() => undefined);
	return render(
		<TooltipProvider.Provider>
			<ActiveFiltersBar
				onEndpointProviderSelect={onEndpointProviderSelect}
				onMakerToggle={onMakerToggle}
				onRemoveParameter={onRemoveParameter}
				onVariantSelect={onVariantSelect}
				selectedEndpointProvider={null}
				selectedMakers={[]}
				selectedParameters={[]}
				selectedVariant={null}
				{...props}
			/>
		</TooltipProvider.Provider>,
	);
}

describe("hasActiveFilters", () => {
	test("returns false when all empty/null", () => {
		expect(hasActiveFilters([], null, null, [])).toBe(false);
	});

	test("returns true when makers non-empty", () => {
		expect(hasActiveFilters(["openai"], null, null, [])).toBe(true);
	});

	test("returns true when variant non-null", () => {
		expect(hasActiveFilters([], "free", null, [])).toBe(true);
	});

	test("returns true when endpoint provider non-null", () => {
		expect(hasActiveFilters([], null, "deepinfra", [])).toBe(true);
	});

	test("returns true when parameters non-empty", () => {
		expect(hasActiveFilters([], null, null, ["tools"])).toBe(true);
	});
});

describe("getVariantLabel", () => {
	test("returns 'Standard' for 'none'", () => {
		expect(getVariantLabel("none")).toBe("Standard");
	});

	test("returns the label for a known variant", () => {
		expect(getVariantLabel("nitro")).toBe("Nitro");
	});

	test("returns the label for free variant", () => {
		expect(getVariantLabel("free")).toBe("Free");
	});
});

describe("ActiveFiltersBar", () => {
	test("renders nothing when no filters are active", () => {
		const { container } = renderBar({});
		expect(container.firstChild).toBeNull();
	});

	test("renders maker badges when selectedMakers is non-empty", () => {
		renderBar({ selectedMakers: ["openai", "anthropic"] });
		expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
	});

	test("renders a variant badge", () => {
		renderBar({ selectedVariant: "nitro" });
		expect(document.body.textContent).toContain("Nitro");
	});

	test("renders 'Standard' label for the 'none' variant", () => {
		renderBar({ selectedVariant: "none" });
		expect(document.body.textContent).toContain("Standard");
	});

	test("renders endpoint provider badge", () => {
		renderBar({ selectedEndpointProvider: "deepinfra" });
		expect(document.body.textContent?.toLowerCase()).toContain("deepinfra");
	});

	test("renders parameter badges", () => {
		renderBar({ selectedParameters: ["tools"] });
		expect(document.body.textContent).toContain("Tools");
	});
});
