import { describe, expect, test } from "bun:test";
import { type ContextMenuTemplateItem, convertContextMenuTemplate } from "./context-menu-template";

describe("convertContextMenuTemplate", () => {
	test("converts actionable items and separator while wiring click ids", () => {
		const selectedIds: string[] = [];
		const template: ContextMenuTemplateItem[] = [
			{ id: "copy", label: "Copy", accelerator: "CmdOrCtrl+C" },
			{ type: "separator" },
			{ id: "autoCorrect", label: "Auto Correct", type: "checkbox", checked: true, enabled: false },
		];

		const converted = convertContextMenuTemplate(template, (id) => {
			selectedIds.push(id);
		});

		expect(converted).toHaveLength(3);
		expect(converted[0]).toMatchObject({
			type: "normal",
			label: "Copy",
			accelerator: "CmdOrCtrl+C",
		});
		expect(converted[1]).toEqual({ type: "separator" });
		expect(converted[2]).toMatchObject({
			type: "checkbox",
			label: "Auto Correct",
			checked: true,
			enabled: false,
		});

		(converted[0] as { click?: () => void }).click?.();
		(converted[2] as { click?: () => void }).click?.();
		expect(selectedIds).toEqual(["copy", "autoCorrect"]);
	});

	test("converts nested submenu items recursively", () => {
		const selectedIds: string[] = [];
		const template: ContextMenuTemplateItem[] = [
			{
				label: "Spelling",
				submenu: [
					{ id: "ignoreWord", label: "Ignore" },
					{ id: "learnWord", label: "Learn" },
				],
			},
		];

		const converted = convertContextMenuTemplate(template, (id) => {
			selectedIds.push(id);
		});
		const submenu = converted[0]?.submenu as
			| Array<{ click?: () => void; label?: string }>
			| undefined;

		expect(submenu?.map((item) => item.label)).toEqual(["Ignore", "Learn"]);
		submenu?.[1]?.click?.();
		expect(selectedIds).toEqual(["learnWord"]);
	});

	test("does not attach click handler when id is omitted", () => {
		const converted = convertContextMenuTemplate([{ label: "Plain Label" }], () => {
			throw new Error("should not be called");
		});

		expect(converted[0]).toMatchObject({ type: "normal", label: "Plain Label" });
		expect((converted[0] as { click?: unknown }).click).toBeUndefined();
	});

	test("omits text fields that were not provided (label, sublabel, role, accelerator)", () => {
		const converted = convertContextMenuTemplate([{ id: "x" }], () => undefined);
		const item = converted[0] as Record<string, unknown>;
		expect(item.type).toBe("normal");
		expect(item).not.toHaveProperty("label");
		expect(item).not.toHaveProperty("sublabel");
		expect(item).not.toHaveProperty("role");
		expect(item).not.toHaveProperty("accelerator");
	});

	test("propagates text fields when present", () => {
		const converted = convertContextMenuTemplate(
			[{ id: "x", label: "L", sublabel: "S", role: "copy", accelerator: "Cmd+C" }],
			() => undefined
		);
		expect(converted[0]).toMatchObject({
			label: "L",
			sublabel: "S",
			role: "copy",
			accelerator: "Cmd+C",
		});
	});

	test("propagates enabled, visible, checked when explicitly set (true and false)", () => {
		const converted = convertContextMenuTemplate(
			[
				{ id: "a", enabled: true, visible: true, checked: true },
				{ id: "b", enabled: false, visible: false, checked: false },
			],
			() => undefined
		);
		expect(converted[0]).toMatchObject({ enabled: true, visible: true, checked: true });
		expect(converted[1]).toMatchObject({ enabled: false, visible: false, checked: false });
	});

	test("omits enabled/visible/checked when not provided", () => {
		const converted = convertContextMenuTemplate([{ id: "x" }], () => undefined);
		const item = converted[0] as Record<string, unknown>;
		expect(item).not.toHaveProperty("enabled");
		expect(item).not.toHaveProperty("visible");
		expect(item).not.toHaveProperty("checked");
	});

	test("separator item type literal is exactly 'separator' and has no other properties", () => {
		// Pass extra fields that buildNonSeparatorItem WOULD propagate. If the
		// `if (item.type === "separator")` branch is mutated (-> false / "" / {}),
		// the function falls through to buildNonSeparatorItem and the extra
		// `label` field (and click handler from `id`) would be present.
		const converted = convertContextMenuTemplate(
			[
				{
					type: "separator",
					label: "should-be-stripped",
					id: "should-not-create-click",
					enabled: true,
				} as unknown as ContextMenuTemplateItem,
			],
			() => undefined
		);
		expect(converted[0]).toEqual({ type: "separator" });
		expect((converted[0] as { type: string }).type).toBe("separator");
		expect(Object.keys(converted[0] as object)).toEqual(["type"]);
		expect((converted[0] as Record<string, unknown>).label).toBeUndefined();
		expect((converted[0] as Record<string, unknown>).click).toBeUndefined();
		expect((converted[0] as Record<string, unknown>).enabled).toBeUndefined();
	});

	test("non-separator items get default type 'normal' and never become 'separator'", () => {
		const converted = convertContextMenuTemplate([{ id: "x", label: "L" }], () => undefined);
		expect((converted[0] as { type: string }).type).toBe("normal");
		expect((converted[0] as { type: string }).type).not.toBe("separator");
	});

	test("a non-separator item that omits visible does NOT include visible:false (block-mutation guard)", () => {
		const converted = convertContextMenuTemplate([{ id: "x", label: "L" }], () => undefined);
		const item = converted[0] as Record<string, unknown>;
		// If the `if (item.visible !== undefined)` branch was deleted (BlockStatement -> {}),
		// the assignment to menuItem.visible would never run — same outcome.
		// Conversely if the condition flipped (true), menuItem.visible would be set to undefined.
		// Verify the property is truly absent (not present-with-undefined).
		expect(Object.hasOwn(item, "visible")).toBe(false);
	});

	test("submenu attachment is omitted when submenu is not provided", () => {
		const converted = convertContextMenuTemplate([{ id: "x", label: "L" }], () => undefined);
		const item = converted[0] as Record<string, unknown>;
		expect(Object.hasOwn(item, "submenu")).toBe(false);
	});

	test("submenu attachment recurses with the same onSelected handler", () => {
		const selectedIds: string[] = [];
		const converted = convertContextMenuTemplate(
			[
				{
					label: "Outer",
					submenu: [
						{
							label: "Inner",
							submenu: [{ id: "deep", label: "Deep" }],
						},
					],
				},
			],
			(id) => {
				selectedIds.push(id);
			}
		);
		const outer = converted[0]?.submenu as
			| Array<{ submenu?: Array<{ click?: () => void }> }>
			| undefined;
		outer?.[0]?.submenu?.[0]?.click?.();
		expect(selectedIds).toEqual(["deep"]);
	});

	test("click handler is omitted when id is an empty string (falsy guard)", () => {
		const converted = convertContextMenuTemplate([{ id: "", label: "L" }], () => {
			throw new Error("should not be called");
		});
		const item = converted[0] as Record<string, unknown>;
		expect(Object.hasOwn(item, "click")).toBe(false);
	});

	test("item.type defaults to 'normal' when omitted and is preserved when explicitly set", () => {
		const converted = convertContextMenuTemplate(
			[{ id: "a" }, { id: "b", type: "checkbox" }, { id: "c", type: "radio" }],
			() => undefined
		);
		expect((converted[0] as { type: string }).type).toBe("normal");
		expect((converted[1] as { type: string }).type).toBe("checkbox");
		expect((converted[2] as { type: string }).type).toBe("radio");
	});
});
