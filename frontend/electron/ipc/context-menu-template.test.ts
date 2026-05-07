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
});
