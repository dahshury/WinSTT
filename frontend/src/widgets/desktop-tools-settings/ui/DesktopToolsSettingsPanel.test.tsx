import { describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import {
	DesktopToolsSettingsPanel,
	__desktop_tools_settings_panel_test_helpers__ as helpers,
} from "./DesktopToolsSettingsPanel";

describe("DesktopToolsSettingsPanel", () => {
	test("renders without crashing", () => {
		const { container } = render(
			<IntlProvider>
				<DesktopToolsSettingsPanel />
			</IntlProvider>
		);
		expect(container.firstElementChild).not.toBeNull();
	});

	test("renders multiple action buttons (apply, reset, clipboard, updater, etc.)", () => {
		render(
			<IntlProvider>
				<DesktopToolsSettingsPanel />
			</IntlProvider>
		);
		expect(screen.getAllByRole("button").length).toBeGreaterThan(5);
	});

	test("renders a JSON textarea pre-populated with the demo template", () => {
		render(
			<IntlProvider>
				<DesktopToolsSettingsPanel />
			</IntlProvider>
		);
		const textareas = document.querySelectorAll("textarea");
		expect(textareas.length).toBe(1);
		expect((textareas[0] as HTMLTextAreaElement).value.length).toBeGreaterThan(0);
	});
});

const tStub = ((key: string, vars?: Record<string, unknown>) =>
	vars ? `${key}:${JSON.stringify(vars)}` : key) as any;

describe("DesktopToolsSettingsPanel helpers — errorToMessage", () => {
	test("returns Error.message for Error instances", () => {
		expect(helpers.errorToMessage(new Error("nope"))).toBe("nope");
	});

	test("stringifies non-Error values", () => {
		expect(helpers.errorToMessage("plain")).toBe("plain");
		expect(helpers.errorToMessage(42)).toBe("42");
	});
});

describe("DesktopToolsSettingsPanel helpers — describeContextMenuResult", () => {
	test("returns selected message when id is truthy", () => {
		const result = helpers.describeContextMenuResult("copy", tStub);
		expect(result).toContain("contextMenuSelected");
		expect(result).toContain("copy");
	});

	test("returns closed message when id is null/undefined", () => {
		expect(helpers.describeContextMenuResult(null, tStub)).toBe("contextMenuClosed");
		expect(helpers.describeContextMenuResult(undefined, tStub)).toBe("contextMenuClosed");
	});
});

describe("DesktopToolsSettingsPanel helpers — applyMenuJsonAction", () => {
	test("reports parse error for invalid JSON", async () => {
		const setMenuStatus = mock((_msg: string) => undefined);
		await helpers.applyMenuJsonAction({
			menuJson: "not-json{",
			t: tStub,
			setMenuStatus,
		});
		const calledWith = (setMenuStatus.mock.calls[0]?.[0] ?? "") as string;
		expect(calledWith).toContain("Invalid JSON");
	});

	test("applies template via appMenuSetTemplate (happy path with default fallback)", async () => {
		const setMenuStatus = mock((_msg: string) => undefined);
		await helpers.applyMenuJsonAction({
			menuJson: JSON.stringify([{ label: "File" }]),
			t: tStub,
			setMenuStatus,
		});
		// In tests, electronAPI.invoke resolves to undefined => fallback
		// `{ applied: false, itemCount: 0 }`. So we expect the success path
		// with `appliedMenu` translation key.
		const calledWith = (setMenuStatus.mock.calls[0]?.[0] ?? "") as string;
		expect(calledWith).toContain("appliedMenu");
	});
});

describe("DesktopToolsSettingsPanel helpers — showDemoContextMenuAction", () => {
	test("reports the closed-or-selected status (default selectedId=null)", async () => {
		const setContextStatus = mock(() => undefined);
		await helpers.showDemoContextMenuAction({
			clientX: 10,
			clientY: 20,
			t: tStub,
			setContextStatus,
		});
		expect(setContextStatus).toHaveBeenCalledWith("contextMenuClosed");
	});

	test("calls setContextStatus exactly once per invocation", async () => {
		const setContextStatus = mock(() => undefined);
		await helpers.showDemoContextMenuAction({
			clientX: 0,
			clientY: 0,
			t: tStub,
			setContextStatus,
		});
		expect(setContextStatus).toHaveBeenCalledTimes(1);
	});
});

describe("DesktopToolsSettingsPanel helpers — detectElectron", () => {
	test("true when window.electronAPI is present (test preload sets it)", () => {
		expect(helpers.detectElectron()).toBe(true);
	});

	test("false when electronAPI is removed", () => {
		const original = window.electronAPI;
		(window as any).electronAPI = null;
		try {
			expect(helpers.detectElectron()).toBe(false);
		} finally {
			window.electronAPI = original;
		}
	});
});

describe("DesktopToolsSettingsPanel helpers — describeUpdaterEntry", () => {
	test("includes version and message when both provided", () => {
		const text = helpers.describeUpdaterEntry({
			status: "available",
			timestamp: 0,
			version: "1.2.3",
			message: "ready",
		});
		expect(text).toBe("available • v1.2.3 • ready");
	});

	test("omits version and message when not provided", () => {
		const text = helpers.describeUpdaterEntry({ status: "idle", timestamp: 0 });
		expect(text).toBe("idle");
	});
});

describe("DesktopToolsSettingsPanel helpers — describeTelemetryRow", () => {
	test("formats event and bounds", () => {
		const text = helpers.describeTelemetryRow({
			timestamp: 0,
			payload: {
				event: "moved",
				bounds: { x: 1, y: 2, width: 3, height: 4 },
			},
		});
		expect(text).toBe("moved • x:1 y:2 w:3 h:4");
	});

	test("works for resized event with different bounds", () => {
		const text = helpers.describeTelemetryRow({
			timestamp: 0,
			payload: {
				event: "resized",
				bounds: { x: 100, y: 200, width: 800, height: 600 },
			},
		});
		expect(text).toBe("resized • x:100 y:200 w:800 h:600");
	});
});
