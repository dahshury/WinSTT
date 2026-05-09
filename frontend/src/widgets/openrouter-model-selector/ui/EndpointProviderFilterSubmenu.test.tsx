import { describe, expect, test } from "bun:test";
import {
	EndpointProviderFilterSubmenu,
	__endpoint_provider_filter_submenu_test_helpers__ as helpers,
} from "./EndpointProviderFilterSubmenu";

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
			expect(helpers.filterEndpointProviders(providers, "deep")).toEqual([["DeepInfra", 5]]);
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
});
