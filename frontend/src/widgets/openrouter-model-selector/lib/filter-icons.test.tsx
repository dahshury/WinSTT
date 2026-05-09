import { describe, expect, test } from "bun:test";
import { isValidElement } from "react";
import { __filter_icons_test_helpers__, getParameterIcon, getVariantIcon } from "./filter-icons";

describe("getVariantIcon", () => {
	test("returns a node for every known variant", () => {
		for (const variant of [
			"none",
			"free",
			"nitro",
			"extended",
			"exacto",
			"thinking",
			"online",
			"floor",
		] as const) {
			expect(getVariantIcon(variant)).not.toBeNull();
		}
	});
});

describe("getParameterIcon", () => {
	test("returns a node for every filterable parameter", () => {
		for (const param of [
			"tools",
			"reasoning",
			"include_reasoning",
			"parallel_tool_calls",
			"max_tokens",
			"response_format",
			"structured_outputs",
			"web_search_options",
			"verbosity",
		] as const) {
			expect(getParameterIcon(param)).not.toBeNull();
		}
	});
});

const { VARIANT_ICON_MAP, PARAMETER_ICON_MAP, renderIcon } = __filter_icons_test_helpers__;

describe("VARIANT_ICON_MAP", () => {
	test("contains an entry for every known variant + 'none'", () => {
		for (const v of [
			"free",
			"floor",
			"nitro",
			"extended",
			"exacto",
			"thinking",
			"online",
			"none",
		] as const) {
			expect(VARIANT_ICON_MAP[v]).toBeDefined();
		}
	});

	test("free and floor share the Tag01Icon entry", () => {
		expect(VARIANT_ICON_MAP.free).toBe(VARIANT_ICON_MAP.floor);
	});
});

describe("PARAMETER_ICON_MAP", () => {
	test.each([
		"tools",
		"reasoning",
		"include_reasoning",
		"parallel_tool_calls",
		"max_tokens",
		"verbosity",
		"response_format",
		"structured_outputs",
		"web_search_options",
	])("has an entry for %s", (key) => {
		expect(PARAMETER_ICON_MAP[key]).toBeDefined();
	});

	test("returns undefined for unknown parameter key", () => {
		expect(PARAMETER_ICON_MAP.totally_unknown).toBeUndefined();
	});
});

describe("renderIcon", () => {
	test("returns a valid React element using HugeiconsIcon", () => {
		const node = renderIcon(VARIANT_ICON_MAP.nitro);
		expect(isValidElement(node)).toBe(true);
	});

	test("renders any IconDef passed in (parameter map entry)", () => {
		const node = renderIcon(PARAMETER_ICON_MAP.tools as never);
		expect(isValidElement(node)).toBe(true);
	});
});

describe("getVariantIcon falls back to FilterIcon for unknown variant", () => {
	test("unknown variant still produces a valid React element", () => {
		// Cast to bypass the strict union type; helper has a runtime fallback.
		const node = getVariantIcon("totally_unknown" as never);
		expect(isValidElement(node)).toBe(true);
	});
});

describe("getParameterIcon falls back to Settings01Icon for unknown param", () => {
	test("unknown parameter still produces a valid React element", () => {
		const node = getParameterIcon("totally_unknown" as never);
		expect(isValidElement(node)).toBe(true);
	});
});
