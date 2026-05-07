import { describe, expect, test } from "bun:test";
import {
	buildAppMenuTemplate,
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
