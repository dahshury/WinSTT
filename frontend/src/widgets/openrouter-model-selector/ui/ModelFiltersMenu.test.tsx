import { describe, expect, test } from "bun:test";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { render } from "@testing-library/react";
import {
	__model_filters_menu_test_helpers__ as helpers,
	ModelFiltersMenu,
} from "./ModelFiltersMenu";

describe("ModelFiltersMenu", () => {
	test("renders without crashing", () => {
		const { container } = render(
			<TooltipProvider.Provider>
				<ModelFiltersMenu
					models={[]}
					onEndpointProviderSelect={() => undefined}
					onParametersChange={() => undefined}
					onVariantSelect={() => undefined}
					selectedEndpointProvider={null}
					selectedParameters={[]}
					selectedVariant={null}
				/>
			</TooltipProvider.Provider>
		);
		expect(container.firstElementChild).not.toBeNull();
	});
});

describe("ModelFiltersMenu helpers", () => {
	describe("countNonNull", () => {
		test.each([
			[null, 0],
			["foo", 1],
			[0, 1],
			[false, 1],
			[undefined, 1],
		])("countNonNull(%p) → %p", (value, expected) => {
			expect(helpers.countNonNull(value)).toBe(expected);
		});
	});

	describe("computeActiveFilterCount", () => {
		test("returns 0 when nothing is selected", () => {
			expect(
				helpers.computeActiveFilterCount({
					selectedVariant: null,
					selectedEndpointProvider: null,
					selectedParameters: [],
					selectedMakers: [],
				})
			).toBe(0);
		});

		test("counts variant + endpointProvider + each item in parameters/makers", () => {
			expect(
				helpers.computeActiveFilterCount({
					selectedVariant: "free",
					selectedEndpointProvider: "openai",
					selectedParameters: ["tools", "reasoning"],
					selectedMakers: ["openai", "anthropic", "google"],
				})
			).toBe(1 + 1 + 2 + 3);
		});

		test("only adds non-null variant/provider", () => {
			expect(
				helpers.computeActiveFilterCount({
					selectedVariant: "free",
					selectedEndpointProvider: null,
					selectedParameters: [],
					selectedMakers: [],
				})
			).toBe(1);
		});
	});

	describe("getActiveFiltersAttr", () => {
		test.each([
			[0, undefined],
			[1, 1],
			[5, 5],
		])("count=%p → %p", (count, expected) => {
			expect(helpers.getActiveFiltersAttr(count)).toBe(expected);
		});
	});

	describe("getOpenStateAttr", () => {
		test.each<[boolean, "closed" | "open"]>([
			[true, "open"],
			[false, "closed"],
		])("isOpen=%p → %p", (isOpen, expected) => {
			expect(helpers.getOpenStateAttr(isOpen)).toBe(expected);
		});
	});
});
