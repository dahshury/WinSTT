import { describe, expect, mock, test } from "bun:test";
import { Combobox } from "@base-ui/react/combobox";
import { render } from "@testing-library/react";
import * as components from "../lib/endpoint-provider-filter-submenu-components";
import * as renderHelpers from "../lib/endpoint-provider-filter-submenu-render";
import * as utils from "../lib/endpoint-provider-filter-submenu-utils";
import { EndpointProviderFilterSubmenu } from "./EndpointProviderFilterSubmenu";

const helpers = { ...components, ...renderHelpers, ...utils };

describe("EndpointProviderFilterSubmenu", () => {
	test("module exports the component (full render requires a parent Menu popup)", () => {
		expect(typeof EndpointProviderFilterSubmenu).toBe("function");
	});
});

describe("EndpointProviderFilterSubmenu helpers", () => {
	describe("ALL_PROVIDERS_VALUE", () => {
		test("exports a sentinel string", () => {
			expect(helpers.ALL_PROVIDERS_VALUE).toBe("__all__");
		});
	});

	describe("filterEndpointProviders", () => {
		const providers: [string, number][] = [
			["DeepInfra", 5],
			["Together", 3],
			["openai", 1],
		];

		test("returns input unchanged when query is empty", () => {
			expect(helpers.filterEndpointProviders(providers, "")).toBe(providers);
		});

		test("filters case-insensitively by substring", () => {
			expect(helpers.filterEndpointProviders(providers, "deep")).toEqual([
				["DeepInfra", 5],
			]);
		});

		test("returns empty array when nothing matches", () => {
			expect(helpers.filterEndpointProviders(providers, "zzz")).toEqual([]);
		});
	});

	describe("resolveSelection", () => {
		test.each([
			[helpers.ALL_PROVIDERS_VALUE, null],
			["openai", "openai"],
			[null, "noop"],
			["", "noop"],
		])("(%p) → %p", (input, expected) => {
			expect(helpers.resolveSelection(input)).toBe(expected);
		});
	});

	describe("isTickVisible", () => {
		test("true when provider matches null (All Providers)", () => {
			expect(helpers.isTickVisible(null, null)).toBe(true);
		});

		test("true when provider matches a specific value", () => {
			expect(helpers.isTickVisible("openai", "openai")).toBe(true);
		});

		test("false when values differ", () => {
			expect(helpers.isTickVisible("openai", "deepinfra")).toBe(false);
		});

		test("false when one is null and other is string", () => {
			expect(helpers.isTickVisible(null, "openai")).toBe(false);
		});
	});

	describe("resolveComboboxValue", () => {
		test("returns provider slug when non-null", () => {
			expect(helpers.resolveComboboxValue("deepinfra")).toBe("deepinfra");
		});

		test("returns ALL_PROVIDERS_VALUE when null", () => {
			expect(helpers.resolveComboboxValue(null)).toBe(
				helpers.ALL_PROVIDERS_VALUE,
			);
		});

		test("returns ALL_PROVIDERS_VALUE when empty string", () => {
			expect(helpers.resolveComboboxValue("")).toBe(
				helpers.ALL_PROVIDERS_VALUE,
			);
		});
	});

	describe("applyProviderChange", () => {
		test("calls onEndpointProviderSelect with null for ALL_PROVIDERS_VALUE", () => {
			const onSelect = mock((_v: string | null) => undefined);
			helpers.applyProviderChange(helpers.ALL_PROVIDERS_VALUE, onSelect);
			expect(onSelect).toHaveBeenCalledWith(null);
		});

		test("calls onEndpointProviderSelect with the provider when non-empty", () => {
			const onSelect = mock((_v: string | null) => undefined);
			helpers.applyProviderChange("openai", onSelect);
			expect(onSelect).toHaveBeenCalledWith("openai");
		});

		test("does not call onEndpointProviderSelect for noop (null value)", () => {
			const onSelect = mock((_v: string | null) => undefined);
			helpers.applyProviderChange(null, onSelect);
			expect(onSelect).not.toHaveBeenCalled();
		});

		test("does not call onEndpointProviderSelect for empty string", () => {
			const onSelect = mock((_v: string | null) => undefined);
			helpers.applyProviderChange("", onSelect);
			expect(onSelect).not.toHaveBeenCalled();
		});
	});
});

describe("SelectedTick", () => {
	const { SelectedTick } = helpers;

	test("returns null when visible=false", () => {
		const { container } = render(<SelectedTick visible={false} />);
		expect(container.firstChild).toBeNull();
	});

	test("renders icon when visible=true", () => {
		const { container } = render(<SelectedTick visible={true} />);
		expect(container.firstChild).not.toBeNull();
	});
});

describe("renderProviderRow", () => {
	const ctx = {
		allLabel: "All Providers",
		counts: new Map([["openai", 3]]),
		selectedEndpointProvider: null as string | null,
	};

	test("renders AllProvidersItem for __all__ sentinel", () => {
		const { container } = render(
			<Combobox.Root items={[helpers.ALL_PROVIDERS_VALUE]} open>
				<Combobox.List>
					<Combobox.Collection>
						{(provider: string) => helpers.renderProviderRow(provider, ctx)}
					</Combobox.Collection>
				</Combobox.List>
			</Combobox.Root>,
		);
		expect(container.textContent).toContain("All Providers");
	});

	test("returns the correct component type for a regular provider (structural check)", () => {
		// ProviderItem uses Combobox.Item; verify renderProviderRow returns a non-null React element
		const element = helpers.renderProviderRow("openai", ctx);
		// The returned element is a React element (object with type, props, etc.)
		expect(element).not.toBeNull();
		expect(typeof element).toBe("object");
	});
});
