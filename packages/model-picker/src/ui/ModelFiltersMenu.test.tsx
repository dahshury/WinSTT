import { describe, expect, test } from "bun:test";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { fireEvent, render, screen } from "@testing-library/react";
import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import * as utils from "../lib/model-filters-menu-utils";
import { ModelFiltersMenu } from "./ModelFiltersMenu";

const helpers = { ...utils };

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
			</TooltipProvider.Provider>,
		);
		expect(container.firstElementChild).not.toBeNull();
	});

	test("renders the shared trigger count for filters and sort", () => {
		render(
			<TooltipProvider.Provider>
				<ModelFiltersMenu
					models={[]}
					onEndpointProviderSelect={() => undefined}
					onParametersChange={() => undefined}
					onSortChange={() => undefined}
					onVariantSelect={() => undefined}
					selectedEndpointProvider="deepinfra"
					selectedMakers={["openai", "anthropic"]}
					selectedParameters={["tools"]}
					selectedVariant="free"
					sortKey="price"
				/>
			</TooltipProvider.Provider>,
		);

		expect(
			screen.getByRole("button", { name: "Sort & filter (6 active)" }),
		).not.toBeNull();
		expect(screen.getByText("6")).not.toBeNull();
	});

	test("opens a flat accordion filter surface", async () => {
		render(
			<TooltipProvider.Provider>
				<ModelFiltersMenu
					allProviders={["openai"]}
					favoriteProviders={[]}
					models={[makeModel()]}
					onEndpointProviderSelect={() => undefined}
					onMakersChange={() => undefined}
					onParametersChange={() => undefined}
					onSortChange={() => undefined}
					onVariantSelect={() => undefined}
					selectedEndpointProvider={null}
					selectedMakers={[]}
					selectedParameters={[]}
					selectedVariant={null}
					sortKey={null}
				/>
			</TooltipProvider.Provider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Sort & filter" }));

		expect(await screen.findByText("Sort by")).not.toBeNull();
		expect(screen.getByText("Variant")).not.toBeNull();
		expect(screen.getByText("Author")).not.toBeNull();
		expect(screen.getByText("Capabilities")).not.toBeNull();
		expect(screen.getByText("Endpoint provider")).not.toBeNull();
		expect(screen.queryByText("Model Author")).toBeNull();
	});
});

function makeModel(overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
	return {
		id: "openai/gpt-4o:free",
		maker: "openai",
		name: "GPT-4o Free",
		supported_parameters: ["tools"],
		variant: "free",
		endpoints: [
			{
				context_length: 128_000,
				model_name: "GPT-4o",
				name: "DeepInfra",
				pricing: {} as OpenRouterEndpoint["pricing"],
				provider_name: "deepinfra",
				tag: "deepinfra",
			} as OpenRouterEndpoint,
		],
		...overrides,
	} as OpenRouterModel;
}

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
				}),
			).toBe(0);
		});

		test("counts variant + endpointProvider + each item in parameters/makers", () => {
			expect(
				helpers.computeActiveFilterCount({
					selectedVariant: "free",
					selectedEndpointProvider: "openai",
					selectedParameters: ["tools", "reasoning"],
					selectedMakers: ["openai", "anthropic", "google"],
				}),
			).toBe(1 + 1 + 2 + 3);
		});

		test("only adds non-null variant/provider", () => {
			expect(
				helpers.computeActiveFilterCount({
					selectedVariant: "free",
					selectedEndpointProvider: null,
					selectedParameters: [],
					selectedMakers: [],
				}),
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

	describe("shouldRenderAuthorSubmenu", () => {
		test("returns true when providers non-empty and handler provided", () => {
			expect(
				helpers.shouldRenderAuthorSubmenu(["openai"], () => undefined),
			).toBe(true);
		});

		test("returns false when providers empty", () => {
			expect(helpers.shouldRenderAuthorSubmenu([], () => undefined)).toBe(
				false,
			);
		});

		test("returns false when onMakersChange is undefined", () => {
			expect(helpers.shouldRenderAuthorSubmenu(["openai"], undefined)).toBe(
				false,
			);
		});
	});

	describe("shouldRenderEndpointSubmenu", () => {
		test("returns true when endpointProviders non-empty", () => {
			expect(helpers.shouldRenderEndpointSubmenu([["openai", 5]])).toBe(true);
		});

		test("returns false when empty", () => {
			expect(helpers.shouldRenderEndpointSubmenu([])).toBe(false);
		});
	});
});
