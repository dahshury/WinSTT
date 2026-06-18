import { describe, expect, test } from "bun:test";
import { buildSwitchingClassName } from "./build-switching-class-name";

describe("buildSwitchingClassName", () => {
	test("returns the active-swap accent classes when switching", () => {
		const result = buildSwitchingClassName(true);
		// The switching branch must force full opacity (the `!` important
		// override) so the trigger is never dimmed mid-swap.
		expect(result).toContain("opacity-100!");
		// Accent tint + gradient signal "active swap".
		expect(result).toContain("ring-accent/40!");
		expect(result).toContain("from-accent-wash!");
		expect(result).toContain("to-surface-2/95!");
	});

	test("returns only the disabled-opacity default when not switching", () => {
		const result = buildSwitchingClassName(false);
		expect(result).toBe("disabled:opacity-50");
	});

	test("the two branches are mutually exclusive (never share class tokens)", () => {
		const on = buildSwitchingClassName(true).split(" ");
		const off = buildSwitchingClassName(false).split(" ");
		const shared = on.filter((token) => off.includes(token));
		expect(shared).toEqual([]);
	});

	test("the switching branch overrides disability with important opacity, the idle branch only sets the disabled default", () => {
		// Behavioural contract: when switching, opacity is forced to 100 with `!`
		// (wins over any disabled:opacity-50), so it must NOT emit the plain
		// `disabled:opacity-50` token used by the idle branch.
		const on = buildSwitchingClassName(true);
		expect(on).not.toContain("disabled:opacity-50");

		// And the idle branch must NOT leak the important opacity override.
		const off = buildSwitchingClassName(false);
		expect(off).not.toContain("opacity-100!");
	});

	test("output is always a non-empty string for both inputs", () => {
		for (const flag of [true, false]) {
			const result = buildSwitchingClassName(flag);
			expect(typeof result).toBe("string");
			expect(result.length).toBeGreaterThan(0);
		}
	});

	test("is a pure function — repeated calls yield identical output", () => {
		expect(buildSwitchingClassName(true)).toBe(buildSwitchingClassName(true));
		expect(buildSwitchingClassName(false)).toBe(buildSwitchingClassName(false));
	});
});
