import { describe, expect, test } from "bun:test";
import type { FilterableParameter } from "../lib/openrouter-provider-utils";
import {
	__parameters_filter_submenu_test_helpers__ as helpers,
	ParametersFilterSubmenu,
} from "./ParametersFilterSubmenu";

describe("ParametersFilterSubmenu", () => {
	test("module exports the component (full render requires a parent Menu popup)", () => {
		expect(typeof ParametersFilterSubmenu).toBe("function");
	});
});

describe("ParametersFilterSubmenu helpers", () => {
	describe("toggleParameterValue", () => {
		test("removes a parameter that is already selected", () => {
			const current: FilterableParameter[] = ["tools", "reasoning"];
			const result = helpers.toggleParameterValue(current, "tools", new Set(current));
			expect(result).toEqual(["reasoning"]);
		});

		test("adds a parameter that is not yet selected", () => {
			const current: FilterableParameter[] = ["tools"];
			const result = helpers.toggleParameterValue(current, "reasoning", new Set(current));
			expect(result).toEqual(["tools", "reasoning"]);
		});

		test("does not mutate the input array", () => {
			const current: FilterableParameter[] = ["tools"];
			const result = helpers.toggleParameterValue(current, "reasoning", new Set(current));
			expect(current).toEqual(["tools"]);
			expect(result).not.toBe(current);
		});
	});
});
