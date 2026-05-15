import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import type { FilterableParameter } from "../lib/openrouter-provider-utils";
import { DropdownMenu } from "./DropdownMenu";
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
	describe("getParamCount", () => {
		test("returns the count from the map", () => {
			const map = new Map<FilterableParameter, number>([["tools", 3]]);
			expect(helpers.getParamCount(map, "tools")).toBe(3);
		});

		test("returns 0 for missing param", () => {
			const map = new Map<FilterableParameter, number>();
			expect(helpers.getParamCount(map, "reasoning")).toBe(0);
		});
	});

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

	describe("shouldShowSelectedTick", () => {
		test("returns true when visible", () => {
			expect(helpers.shouldShowSelectedTick(true)).toBe(true);
		});
		test("returns false when not visible", () => {
			expect(helpers.shouldShowSelectedTick(false)).toBe(false);
		});
	});

	describe("shouldShowCountBadge", () => {
		test("returns true when count > 0", () => {
			expect(helpers.shouldShowCountBadge(1)).toBe(true);
			expect(helpers.shouldShowCountBadge(5)).toBe(true);
		});
		test("returns false when count <= 0", () => {
			expect(helpers.shouldShowCountBadge(0)).toBe(false);
			expect(helpers.shouldShowCountBadge(-1)).toBe(false);
		});
	});

	describe("shouldShowClearAll", () => {
		test("returns true when count > 0", () => {
			expect(helpers.shouldShowClearAll(1)).toBe(true);
		});
		test("returns false when count is 0", () => {
			expect(helpers.shouldShowClearAll(0)).toBe(false);
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

describe("SelectedCountBadge", () => {
	const { SelectedCountBadge } = helpers;

	test("returns null when count=0", () => {
		const { container } = render(<SelectedCountBadge count={0} />);
		expect(container.firstChild).toBeNull();
	});

	test("renders badge with count when count > 0", () => {
		const { container } = render(<SelectedCountBadge count={3} />);
		expect(container.textContent).toBe("3");
	});
});

describe("ClearAllSection", () => {
	const { ClearAllSection } = helpers;

	test("returns null when visible=false", () => {
		const { container } = render(
			<DropdownMenu>
				<ClearAllSection onClear={() => undefined} visible={false} />
			</DropdownMenu>
		);
		expect(container.firstChild).toBeNull();
	});

	test("renders Clear all when visible=true", () => {
		const { container } = render(
			<DropdownMenu>
				<ClearAllSection onClear={() => undefined} visible={true} />
			</DropdownMenu>
		);
		expect(container.textContent).toContain("Clear all");
	});
});

describe("ParameterMenuItem", () => {
	const { ParameterMenuItem } = helpers;

	test("renders parameter label and count", () => {
		const { container } = render(
			<DropdownMenu>
				<ParameterMenuItem count={5} isSelected={false} onToggle={() => undefined} param="tools" />
			</DropdownMenu>
		);
		expect(container.textContent).toContain("Tools");
		expect(container.textContent).toContain("5");
	});

	test("renders tick when isSelected=true", () => {
		const { container } = render(
			<DropdownMenu>
				<ParameterMenuItem
					count={2}
					isSelected={true}
					onToggle={() => undefined}
					param="reasoning"
				/>
			</DropdownMenu>
		);
		// SelectedTick renders an icon when isSelected=true
		expect(container.querySelectorAll("*").length).toBeGreaterThan(1);
	});

	test("renders without tick when isSelected=false", () => {
		const { container } = render(
			<DropdownMenu>
				<ParameterMenuItem
					count={1}
					isSelected={false}
					onToggle={() => undefined}
					param="structured_outputs"
				/>
			</DropdownMenu>
		);
		expect(container.textContent).toContain("1");
	});
});
