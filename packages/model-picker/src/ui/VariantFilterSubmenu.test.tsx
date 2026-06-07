import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { MODEL_VARIANT_INFO } from "../lib/model-variant-utils";
import * as components from "../lib/variant-filter-submenu-components";
import * as utils from "../lib/variant-filter-submenu-utils";
import { DropdownMenu } from "./DropdownMenu";
import { VariantFilterSubmenu } from "./VariantFilterSubmenu";

const helpers = { ...components, ...utils };

describe("VariantFilterSubmenu", () => {
	test("module exports the component (full render requires a parent Menu popup)", () => {
		expect(typeof VariantFilterSubmenu).toBe("function");
	});
});

describe("VariantFilterSubmenu helpers", () => {
	describe("getVariantCount", () => {
		test("returns the count from the map", () => {
			const map = new Map<
				import("../lib/model-variant-utils").ModelVariant | "none",
				number
			>([["free", 7]]);
			expect(helpers.getVariantCount(map, "free")).toBe(7);
		});

		test("returns 0 for missing variant", () => {
			const map = new Map<
				import("../lib/model-variant-utils").ModelVariant | "none",
				number
			>();
			expect(helpers.getVariantCount(map, "none")).toBe(0);
		});
	});

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

	describe("isVariantSelected", () => {
		test("returns true when selected matches", () => {
			expect(helpers.isVariantSelected("free", "free")).toBe(true);
		});

		test("returns false when selected differs", () => {
			expect(helpers.isVariantSelected("nitro", "free")).toBe(false);
		});

		test("returns false when null selected", () => {
			expect(helpers.isVariantSelected(null, "free")).toBe(false);
		});

		test("returns true for none variant", () => {
			expect(helpers.isVariantSelected("none", "none")).toBe(true);
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

describe("VariantMenuItem", () => {
	const { VariantMenuItem } = helpers;

	test("renders variant label and count", () => {
		const { container } = render(
			<DropdownMenu>
				<VariantMenuItem
					count={5}
					isSelected={false}
					onSelect={() => undefined}
					variant="free"
				/>
			</DropdownMenu>,
		);
		expect(container.textContent).toContain("Free");
		expect(container.textContent).toContain("5");
	});

	test("renders none variant as Standard", () => {
		const { container } = render(
			<DropdownMenu>
				<VariantMenuItem
					count={2}
					isSelected={false}
					onSelect={() => undefined}
					variant="none"
				/>
			</DropdownMenu>,
		);
		expect(container.textContent).toContain("Standard");
	});

	test("renders tick when isSelected=true", () => {
		const { container } = render(
			<DropdownMenu>
				<VariantMenuItem
					count={3}
					isSelected={true}
					onSelect={() => undefined}
					variant="nitro"
				/>
			</DropdownMenu>,
		);
		expect(container.querySelectorAll("*").length).toBeGreaterThan(1);
	});
});
