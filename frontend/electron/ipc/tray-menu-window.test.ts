import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";

mock.module("electron", () => ({
	...electronMock(),
	BrowserWindow: class {
		isDestroyed = () => false;
		webContents = {
			loadURL: () => Promise.resolve(),
			on: () => undefined,
			send: () => undefined,
			openDevTools: () => undefined,
		};
		setBounds = () => undefined;
		setOpacity = () => undefined;
		show = () => undefined;
		hide = () => undefined;
		close = () => undefined;
		on = () => undefined;
		once = () => undefined;
		setSkipTaskbar = () => undefined;
		setAlwaysOnTop = () => undefined;
		isVisible = () => false;
		focus = () => undefined;
		blur = () => undefined;
		loadURL = () => Promise.resolve();
	} as unknown as typeof import("electron").BrowserWindow,
}));

mock.module("../lib/debug-log", () => ({
	dbg: () => undefined,
}));

const trayMenuWindow = await import("./tray-menu-window");
const { __tray_menu_window_test_helpers__: helpers } = trayMenuWindow;

describe("tray-menu-window module", () => {
	test("exports the public API surface", () => {
		expect(typeof trayMenuWindow.createTrayMenuWindow).toBe("function");
		expect(typeof trayMenuWindow.showTrayMenuAt).toBe("function");
	});
});

describe("tray-menu-window pure helpers", () => {
	test("isWindowAlive false for null", () => {
		expect(helpers.isWindowAlive(null)).toBe(false);
	});

	test("isWindowAlive false when isDestroyed returns true", () => {
		const fake = { isDestroyed: () => true } as unknown as Parameters<
			typeof helpers.isWindowAlive
		>[0];
		expect(helpers.isWindowAlive(fake)).toBe(false);
	});

	test("isWindowAlive true when window present and not destroyed", () => {
		const fake = { isDestroyed: () => false } as unknown as Parameters<
			typeof helpers.isWindowAlive
		>[0];
		expect(helpers.isWindowAlive(fake)).toBe(true);
	});

	test("clearFadeTimer is a no-op when no timer is active", () => {
		expect(() => helpers.clearFadeTimer()).not.toThrow();
	});

	test("moveOffscreen sets opacity 0 and offscreen position", () => {
		const calls: { fn: string; args: unknown[] }[] = [];
		const fake = {
			setOpacity: (v: number) => calls.push({ fn: "setOpacity", args: [v] }),
			setPosition: (x: number, y: number) => calls.push({ fn: "setPosition", args: [x, y] }),
		} as unknown as Parameters<typeof helpers.moveOffscreen>[0];
		helpers.moveOffscreen(fake);
		expect(calls[0]).toEqual({ fn: "setOpacity", args: [0] });
		expect(calls[1]?.fn).toBe("setPosition");
		const [x, y] = calls[1]?.args as [number, number];
		expect(x).toBeLessThan(0);
		expect(y).toBeLessThan(0);
	});

	test("hideAliveWindow no-ops on null", () => {
		expect(() => helpers.hideAliveWindow(null)).not.toThrow();
	});

	test("hideAliveWindow moves alive window offscreen", () => {
		let opacity = 1;
		let position: [number, number] | null = null;
		const fake = {
			isDestroyed: () => false,
			setOpacity: (v: number) => {
				opacity = v;
			},
			setPosition: (x: number, y: number) => {
				position = [x, y];
			},
		} as unknown as Parameters<typeof helpers.hideAliveWindow>[0];
		helpers.hideAliveWindow(fake);
		expect(opacity).toBe(0);
		expect(position).not.toBeNull();
	});

	test.each([
		["http://localhost:3000/x", "http://localhost:3000/", true],
		["http://localhost:3000/y", "http://localhost:3000", true],
		["http://evil.com/x", "http://localhost:3000", false],
		["not-a-url", "http://localhost:3000", false],
	])("isSameOrigin(%p, %p) === %p", (url, base, expected) => {
		expect(helpers.isSameOrigin(url, base)).toBe(expected);
	});

	test.each([
		["http://example.com", true],
		["https://example.com", true],
		["file:///foo", false],
		["javascript:alert(1)", false],
		["", false],
	])("isHttpUrl(%p) === %p", (url, expected) => {
		expect(helpers.isHttpUrl(url)).toBe(expected);
	});

	test("handleWindowOpen always returns deny action", () => {
		expect(helpers.handleWindowOpen({ url: "http://example.com" })).toEqual({
			action: "deny",
		});
		expect(helpers.handleWindowOpen({ url: "file:///foo" })).toEqual({ action: "deny" });
	});

	test("clampToWorkArea pulls coordinates within work area", () => {
		const workArea = { x: 0, y: 0, width: 1000, height: 800 };
		const menuSize = { width: 200, height: 200 };
		// Desired bottom-right beyond bounds → clamped
		const result = helpers.clampToWorkArea({ x: 5000, y: 5000 }, menuSize, workArea);
		expect(result.x).toBeLessThanOrEqual(workArea.x + workArea.width - menuSize.width);
		expect(result.y).toBeLessThanOrEqual(workArea.y + workArea.height - menuSize.height);
	});

	test("clampToWorkArea pulls coordinates above work area origin", () => {
		const workArea = { x: 100, y: 100, width: 1000, height: 800 };
		const menuSize = { width: 50, height: 50 };
		const result = helpers.clampToWorkArea({ x: -10, y: -10 }, menuSize, workArea);
		expect(result.x).toBe(workArea.x);
		expect(result.y).toBe(workArea.y);
	});

	test("clampToWorkArea returns desired coordinates when within bounds", () => {
		const workArea = { x: 0, y: 0, width: 1000, height: 800 };
		const menuSize = { width: 50, height: 50 };
		expect(helpers.clampToWorkArea({ x: 100, y: 100 }, menuSize, workArea)).toEqual({
			x: 100,
			y: 100,
		});
	});

	test("stepFadeIn ramps opacity by 0.125 and caps at 1", () => {
		const setRef: { value: number | null } = { value: null };
		const fake = {
			setOpacity: (v: number) => {
				setRef.value = v;
			},
		} as unknown as Parameters<typeof helpers.stepFadeIn>[0];
		expect(helpers.stepFadeIn(fake, 0)).toBe(0.125);
		expect(setRef.value).toBe(0.125);
		expect(helpers.stepFadeIn(fake, 0.95)).toBe(1);
		expect(setRef.value).toBe(1);
	});

	test("normalizeResizePayload ceils non-integers and floors at 1", () => {
		expect(helpers.normalizeResizePayload({ width: 100.4, height: 50.9 })).toEqual({
			width: 101,
			height: 51,
		});
		expect(helpers.normalizeResizePayload({ width: 0, height: -5 })).toEqual({
			width: 1,
			height: 1,
		});
	});

	test.each([
		[{ width: 100, height: 50 }, { width: 100, height: 50 }, true],
		[{ width: 100, height: 50 }, { width: 101, height: 50 }, false],
		[{ width: 100, height: 50 }, { width: 100, height: 51 }, false],
	])("sizeUnchanged(%p, %p) === %p", (a, b, expected) => {
		expect(helpers.sizeUnchanged(a, b)).toBe(expected);
	});
});
