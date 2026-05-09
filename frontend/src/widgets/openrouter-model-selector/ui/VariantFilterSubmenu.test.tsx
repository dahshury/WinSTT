import { describe, expect, test } from "bun:test";
import { MODEL_VARIANT_INFO } from "../lib/model-variant-utils";
import {
	__variant_filter_submenu_test_helpers__ as helpers,
	VariantFilterSubmenu,
} from "./VariantFilterSubmenu";

describe("VariantFilterSubmenu", () => {
	test("module exports the component (full render requires a parent Menu popup)", () => {
		expect(typeof VariantFilterSubmenu).toBe("function");
	});
});

describe("VariantFilterSubmenu helpers", () => {
	describe("STANDARD_INFO", () => {
		test("exports the Standard label", () => {
			expect(helpers.STANDARD_INFO).toEqual({ label: "Standard" });
		});
	});

	describe("getVariantInfo", () => {
		test("returns the Standard label for 'none'", () => {
			expect(helpers.getVariantInfo("none")).toEqual({ label: "Standard" });
		});

		test.each([
			"free",
			"extended",
			"exacto",
			"nitro",
			"thinking",
			"online",
		] as const)("returns MODEL_VARIANT_INFO entry for %p", (variant) => {
			expect(helpers.getVariantInfo(variant)).toBe(MODEL_VARIANT_INFO[variant]);
		});
	});
});
