import { describe, expect, test } from "bun:test";
import {
	buildAppMenuTemplate,
	__app_menu_template_test_helpers__ as helpers,
	type NormalizedAppMenuItem,
	normalizeAppMenuTemplate,
} from "./app-menu-template";

describe("normalizeAppMenuTemplate", () => {
	test("returns empty array for non-array input", () => {
		expect(normalizeAppMenuTemplate(null)).toEqual([]);
		expect(normalizeAppMenuTemplate({})).toEqual([]);
		expect(normalizeAppMenuTemplate("invalid")).toEqual([]);
	});

	test("normalizes labels, booleans, separators, and nested submenu entries", () => {
		expect(
			normalizeAppMenuTemplate([
				{ label: "  Open  ", enabled: false, actionId: "  open-main  " },
				{ type: "separator" },
				{
					label: "Tools",
					submenu: [{ label: "  Settings  " }, { label: "" }, { type: "separator" }],
				},
				{ label: "" },
				{ unknown: true },
			])
		).toEqual<NormalizedAppMenuItem[]>([
			{ type: "normal", label: "Open", enabled: false, actionId: "open-main" },
			{ type: "separator" },
			{
				type: "normal",
				label: "Tools",
				enabled: true,
				submenu: [{ type: "normal", label: "Settings", enabled: true }, { type: "separator" }],
			},
		]);
	});
});

describe("normalizeAppMenuTemplate filter pipeline", () => {
	test("filters null items returned by normalizeOne from the mapped array", () => {
		// Mixes non-record (null/string/number), empty-label items (returns null),
		// separators, and valid normal items to exercise both branches of the
		// .filter(isNotNull) predicate added when normalizeItems was simplified.
		const result = normalizeAppMenuTemplate([
			null,
			"not-a-record",
			42,
			{ label: "" },
			{ label: "   " },
			{ type: "separator" },
			{ label: "Keep" },
		]);
		expect(result).toEqual<NormalizedAppMenuItem[]>([
			{ type: "separator" },
			{ type: "normal", label: "Keep", enabled: true },
		]);
	});
});

describe("buildAppMenuTemplate", () => {
	test("maps action ids to click handlers and keeps nested structure", () => {
		const openCalls: string[] = [];
		const settingsCalls: string[] = [];

		const template = buildAppMenuTemplate(
			[
				{ type: "normal", label: "Open", enabled: true, actionId: "open-main" },
				{
					type: "normal",
					label: "Tools",
					enabled: true,
					submenu: [
						{ type: "normal", label: "Settings", enabled: true, actionId: "open-settings" },
						{ type: "normal", label: "No Action", enabled: true, actionId: "missing" },
					],
				},
				{ type: "separator" },
			],
			{
				"open-main": () => openCalls.push("open"),
				"open-settings": () => settingsCalls.push("settings"),
			}
		);

		expect(template).toHaveLength(3);

		const first = template[0];
		if (first?.type === "separator") {
			throw new Error("expected first item to be normal");
		}

		first?.click?.();

		expect(openCalls).toEqual(["open"]);

		const tools = template[1];
		if (tools?.type === "separator" || !tools?.submenu) {
			throw new Error("expected second item to contain submenu");
		}

		const settingsItem = tools.submenu[0];
		if (settingsItem && settingsItem.type !== "separator") {
			settingsItem.click?.();
		}

		const noActionItem = tools.submenu[1];
		if (noActionItem && noActionItem.type !== "separator") {
			noActionItem.click?.();
		}

		expect(settingsCalls).toEqual(["settings"]);
	});
});

describe("app-menu-template pure helpers", () => {
	test("toTrimmedString returns trimmed string for valid strings", () => {
		expect(helpers.toTrimmedString("  hello  ")).toBe("hello");
		expect(helpers.toTrimmedString("hello")).toBe("hello");
	});

	test("toTrimmedString returns undefined for empty/whitespace/non-string", () => {
		expect(helpers.toTrimmedString("")).toBeUndefined();
		expect(helpers.toTrimmedString("   ")).toBeUndefined();
		expect(helpers.toTrimmedString(42)).toBeUndefined();
		expect(helpers.toTrimmedString(null)).toBeUndefined();
		expect(helpers.toTrimmedString(undefined)).toBeUndefined();
	});

	test.each([
		[{ type: "separator" }, true],
		[{ type: "normal" }, false],
		[{ type: "other" }, false],
		[{}, false],
	])("isSeparator(%p) === %p", (input, expected) => {
		expect(helpers.isSeparator(input as Record<string, unknown>)).toBe(expected);
	});

	test.each([
		[{ enabled: true }, true],
		[{ enabled: false }, false],
		[{}, true], // default true when absent
		[{ enabled: "yes" }, true], // non-boolean → defaults to true
	])("readEnabled(%p) === %p", (input, expected) => {
		expect(helpers.readEnabled(input as Record<string, unknown>)).toBe(expected);
	});

	test.each([
		[{ checked: true }, true],
		[{ checked: false }, false],
		[{}, undefined],
		[{ checked: "yes" }, undefined], // non-boolean → undefined
	])("readChecked(%p) === %p", (input, expected) => {
		expect(helpers.readChecked(input as Record<string, unknown>)).toBe(expected);
	});

	test("assignDefined assigns when value is defined and skips when undefined", () => {
		const target: { a?: string; b?: string } = {};
		helpers.assignDefined(target, "a", "value");
		helpers.assignDefined(target, "b", undefined);
		expect(target).toEqual({ a: "value" });
	});

	test("isNotNull predicate filters nulls", () => {
		expect(helpers.isNotNull(null)).toBe(false);
		expect(helpers.isNotNull(0)).toBe(true);
		expect(helpers.isNotNull("")).toBe(true);
		expect(helpers.isNotNull(undefined)).toBe(true);
	});

	test("normalizeOne returns null for non-record input", () => {
		expect(helpers.normalizeOne(null)).toBeNull();
		expect(helpers.normalizeOne("string")).toBeNull();
		expect(helpers.normalizeOne(42)).toBeNull();
	});

	test("normalizeOne returns separator type for separator items", () => {
		expect(helpers.normalizeOne({ type: "separator" })).toEqual({ type: "separator" });
	});

	test("normalizeOne returns null when label is missing or empty", () => {
		expect(helpers.normalizeOne({ label: "" })).toBeNull();
		expect(helpers.normalizeOne({ label: "   " })).toBeNull();
		expect(helpers.normalizeOne({ unknown: 1 })).toBeNull();
	});

	test("normalizeNormalItem returns null when label is missing", () => {
		expect(helpers.normalizeNormalItem({})).toBeNull();
	});

	test("normalizeNormalItem trims label and returns normalized item", () => {
		expect(helpers.normalizeNormalItem({ label: "  Foo  ", checked: true })).toEqual({
			type: "normal",
			label: "Foo",
			enabled: true,
			checked: true,
		});
	});

	test("pickNormalizedOptional includes only defined optional fields", () => {
		const out = helpers.pickNormalizedOptional(
			{ checked: true, accelerator: "  Ctrl+S  ", actionId: "save" },
			[]
		);
		expect(out).toEqual({ checked: true, accelerator: "Ctrl+S", actionId: "save" });
	});

	test("pickNormalizedOptional includes submenu when non-empty", () => {
		const submenu: NormalizedAppMenuItem[] = [{ type: "separator" }];
		const out = helpers.pickNormalizedOptional({}, submenu);
		expect(out.submenu).toBe(submenu);
	});

	test("pickNormalizedOptional excludes empty submenu", () => {
		const out = helpers.pickNormalizedOptional({}, []);
		expect(out.submenu).toBeUndefined();
	});

	test("resolveClickHandler returns handler when actionId is registered", () => {
		const handler = () => undefined;
		const result = helpers.resolveClickHandler(
			{ type: "normal", label: "x", enabled: true, actionId: "save" },
			{ save: handler }
		);
		expect(result).toBe(handler);
	});

	test("resolveClickHandler returns undefined for missing actionId", () => {
		expect(
			helpers.resolveClickHandler({ type: "normal", label: "x", enabled: true }, {})
		).toBeUndefined();
		expect(
			helpers.resolveClickHandler(
				{ type: "normal", label: "x", enabled: true, actionId: "missing" },
				{}
			)
		).toBeUndefined();
	});

	test("buildSubmenuMaybe returns undefined when item has no submenu", () => {
		expect(
			helpers.buildSubmenuMaybe({ type: "normal", label: "x", enabled: true }, {})
		).toBeUndefined();
	});

	test("buildSubmenuMaybe maps submenu items when present", () => {
		const result = helpers.buildSubmenuMaybe(
			{
				type: "normal",
				label: "Tools",
				enabled: true,
				submenu: [{ type: "separator" }],
			},
			{}
		);
		expect(result).toEqual([{ type: "separator" }]);
	});

	test("wrapClick returns undefined when handler is undefined", () => {
		expect(helpers.wrapClick(undefined)).toBeUndefined();
	});

	test("wrapClick wraps handler in a click function", () => {
		const calls: string[] = [];
		const wrapped = helpers.wrapClick(() => calls.push("ok"));
		wrapped?.();
		expect(calls).toEqual(["ok"]);
	});

	test("pickBuiltOptional copies defined optional fields", () => {
		const out = helpers.pickBuiltOptional(
			{
				type: "normal",
				label: "x",
				enabled: true,
				checked: false,
				accelerator: "Ctrl+S",
				actionId: "save",
			},
			{ save: () => undefined }
		);
		expect(out.checked).toBe(false);
		expect(out.accelerator).toBe("Ctrl+S");
		expect(typeof out.click).toBe("function");
	});

	test("assignDefined skips assignment when value is undefined (no own property added)", () => {
		const target: Record<string, unknown> = {};
		helpers.assignDefined(target as { x?: string }, "x", undefined);
		// Mutation guard for L58 ConditionalExpression -> true: if condition were
		// always true, target.x would be set to undefined and Object.hasOwn would
		// return true.
		expect(Object.hasOwn(target, "x")).toBe(false);
	});

	test("assignDefined preserves a falsy-but-defined value", () => {
		const target: { x?: number } = {};
		helpers.assignDefined(target, "x", 0);
		expect(target.x).toBe(0);
		expect(Object.hasOwn(target, "x")).toBe(true);
	});

	test("buildAppMenuTemplate returns items with type literal 'normal' (not empty)", () => {
		const result = buildAppMenuTemplate([{ type: "normal", label: "Item", enabled: true }], {});
		const item = result[0];
		// Mutation guard for L159 StringLiteral -> "": catches "type" being
		// replaced with empty string.
		expect(item?.type).toBe("normal");
		expect(item?.type).not.toBe("");
	});

	test("buildAppMenuTemplate handles separator items and preserves separator type literal", () => {
		const result = buildAppMenuTemplate([{ type: "separator" }], {});
		expect(result[0]).toEqual({ type: "separator" });
		expect(result[0]?.type).toBe("separator");
	});
});

// Equivalent mutants that survive but are semantically identical.
// L125 [ConditionalExpression -> true] resolveClickHandler: even with the type
// guard removed, actionId is typed as string|undefined and Record lookup with
// undefined key returns undefined → same observable behavior.
// L144 [ConditionalExpression -> true] pickBuiltOptional: if forced true,
// the ternary still yields `item.checked` which (for undefined) flows into
// assignDefined which then skips assignment → same observable result.
// These are flagged as test gaps but covered by the assignDefined defensive
// check; explicit tests would be tautological.
