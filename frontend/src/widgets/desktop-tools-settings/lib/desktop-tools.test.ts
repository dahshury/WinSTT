import { describe, expect, test } from "bun:test";
import {
	appendBounded,
	DEFAULT_APP_MENU_TEMPLATE,
	formatTimestamp,
	parseAppMenuTemplateJson,
} from "./desktop-tools";

describe("parseAppMenuTemplateJson", () => {
	test("parses valid menu template JSON array", () => {
		const source = JSON.stringify(DEFAULT_APP_MENU_TEMPLATE);
		const result = parseAppMenuTemplateJson(source);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error(result.error);
		}
		expect(Array.isArray(result.template)).toBe(true);
		expect(result.template.length).toBeGreaterThan(0);
	});

	test("returns typed error when input is invalid JSON", () => {
		const result = parseAppMenuTemplateJson("{not-json");
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("expected parse failure");
		}
		expect(result.error).toContain("Invalid JSON");
	});

	test("returns typed error when root value is not an array", () => {
		const result = parseAppMenuTemplateJson('{"label":"File"}');
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("expected array validation failure");
		}
		expect(result.error).toContain("JSON root must be an array");
	});

	test("returns typed error when array items fail schema validation", () => {
		// An array whose items are not valid menu items (missing required fields)
		const result = parseAppMenuTemplateJson('[{"notAValidField": 123}]');
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("expected schema validation failure");
		}
		expect(result.error).toContain("Invalid menu template");
	});

	test("parses an array with a separator item", () => {
		const result = parseAppMenuTemplateJson('[{"type":"separator"}]');
		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error(result.error);
		}
		expect(result.template).toHaveLength(1);
	});
});

describe("appendBounded", () => {
	test("keeps only the latest entries up to max size", () => {
		let values: number[] = [];
		values = appendBounded(values, 1, 3);
		values = appendBounded(values, 2, 3);
		values = appendBounded(values, 3, 3);
		values = appendBounded(values, 4, 3);

		expect(values).toEqual([2, 3, 4]);
	});
});

describe("formatTimestamp", () => {
	test("formats epoch millis to local HH:MM:SS-ish string", () => {
		const value = formatTimestamp(1_700_000_000_000);
		expect(typeof value).toBe("string");
		expect(value.length).toBeGreaterThan(0);
	});
});

describe("DEFAULT_APP_MENU_TEMPLATE structure", () => {
	test("top-level WinSTT entry has a non-empty submenu", () => {
		// Mutating the submenu literal to [] would silently strip every menu
		// command — guard against that here.
		expect(DEFAULT_APP_MENU_TEMPLATE).toHaveLength(1);
		const root = DEFAULT_APP_MENU_TEMPLATE[0];
		if (!(root && "submenu" in root && root.submenu)) {
			throw new Error("Expected root submenu");
		}
		expect(Array.isArray(root.submenu)).toBe(true);
		expect(root.submenu.length).toBeGreaterThan(0);
	});

	test("show-main-window action has its label and accelerator", () => {
		// Pin specific labels and accelerators so a string-literal mutation to
		// "" or to a different shortcut would fail.
		const root = DEFAULT_APP_MENU_TEMPLATE[0];
		if (!(root && "submenu" in root && root.submenu)) {
			throw new Error("Expected root submenu");
		}
		const show = root.submenu.find(
			(item) => "actionId" in item && item.actionId === "show-main-window"
		);
		expect(show).toBeDefined();
		if (show && "label" in show) {
			expect(show.label).toBe("Show Window");
			expect(show.accelerator).toBe("CmdOrCtrl+Shift+W");
		}
	});

	test("quit action has its label and accelerator", () => {
		const root = DEFAULT_APP_MENU_TEMPLATE[0];
		if (!(root && "submenu" in root && root.submenu)) {
			throw new Error("Expected root submenu");
		}
		const quit = root.submenu.find((item) => "actionId" in item && item.actionId === "quit-app");
		expect(quit).toBeDefined();
		if (quit && "label" in quit) {
			expect(quit.label).toBe("Quit");
			expect(quit.accelerator).toBe("CmdOrCtrl+Q");
		}
	});

	test("contains a separator item between actions", () => {
		const root = DEFAULT_APP_MENU_TEMPLATE[0];
		if (!(root && "submenu" in root && root.submenu)) {
			throw new Error("Expected root submenu");
		}
		const sep = root.submenu.find((item) => "type" in item && item.type === "separator");
		expect(sep).toBeDefined();
	});

	test("root label is exactly 'WinSTT'", () => {
		const root = DEFAULT_APP_MENU_TEMPLATE[0];
		if (!(root && "label" in root)) {
			throw new Error("Expected root with label");
		}
		expect(root.label).toBe("WinSTT");
	});

	test("open-settings entry has the expected label and shortcut", () => {
		const root = DEFAULT_APP_MENU_TEMPLATE[0];
		if (!(root && "submenu" in root && root.submenu)) {
			throw new Error("Expected root submenu");
		}
		const openSettings = root.submenu.find(
			(item) => "actionId" in item && item.actionId === "open-settings"
		);
		expect(openSettings).toBeDefined();
		if (openSettings && "label" in openSettings) {
			expect(openSettings.label).toBe("Open Settings");
			expect(openSettings.accelerator).toBe("CmdOrCtrl+,");
		}
	});

	test("hide-main-window entry has its label", () => {
		const root = DEFAULT_APP_MENU_TEMPLATE[0];
		if (!(root && "submenu" in root && root.submenu)) {
			throw new Error("Expected root submenu");
		}
		const hide = root.submenu.find(
			(item) => "actionId" in item && item.actionId === "hide-main-window"
		);
		expect(hide).toBeDefined();
		if (hide && "label" in hide) {
			expect(hide.label).toBe("Hide Window");
		}
	});
});

describe("parseAppMenuTemplateJson error joining", () => {
	test("joins multiple validation issues with the '; ' separator", () => {
		// Two invalid items each yield at least one issue; the join callback +
		// '; ' separator must produce a comma-style list inside the error.
		const result = parseAppMenuTemplateJson(JSON.stringify([{ notValid: 1 }, { alsoNot: 2 }]));
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("expected failure");
		}
		// Without the join callback (mutated to () => undefined) the rendered
		// message would be "; ; " with no real text. Without the "; " separator,
		// messages run together with no whitespace. Both mutations break this.
		expect(result.error).toMatch(/Invalid menu template:.+; .+/);
	});
});
