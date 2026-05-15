import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";

type TrayHandler = (...args: unknown[]) => void;

interface TrayInstance {
	handlers: Map<string, TrayHandler>;
	on: (event: string, handler: TrayHandler) => void;
	setImage: () => void;
	setToolTip: (tip: string) => void;
	tooltips: string[];
}

const trayInstances: TrayInstance[] = [];

function makeTray(): TrayInstance {
	const handlers = new Map<string, TrayHandler>();
	const instance: TrayInstance = {
		handlers,
		tooltips: [],
		setToolTip(tip: string) {
			instance.tooltips.push(tip);
		},
		on(event: string, handler: TrayHandler) {
			handlers.set(event, handler);
		},
		setImage() {
			/* noop */
		},
	};
	trayInstances.push(instance);
	return instance;
}

let createFromPathEmpty = false;
let existsSyncReturn = true;

mock.module("electron", () => ({
	...electronMock(),
	nativeImage: {
		createFromPath: () => ({ isEmpty: () => createFromPathEmpty }),
		createEmpty: () => ({ isEmpty: () => true }),
	},
	Tray: function TrayCtor(this: TrayInstance) {
		const t = makeTray();
		Object.assign(this, t);
		return this;
	} as unknown as typeof import("electron").Tray,
}));

mock.module("node:fs", () => ({
	default: {
		existsSync: () => existsSyncReturn,
	},
	existsSync: () => existsSyncReturn,
}));

const showTrayMenuCalls: Array<{ x: number; y: number }> = [];
mock.module("./tray-menu-window", () => ({
	showTrayMenuAt: (x: number, y: number) => {
		showTrayMenuCalls.push({ x, y });
	},
}));

const { setupTray } = await import("./tray");

function makeWin(): { show: () => void; showCount: number } {
	const win = {
		showCount: 0,
		show() {
			win.showCount++;
		},
	};
	return win;
}

describe("setupTray", () => {
	test("module exports the setup function", () => {
		expect(typeof setupTray).toBe("function");
	});

	test("returns a tray, sets tooltip, and registers click/right-click", () => {
		existsSyncReturn = true;
		createFromPathEmpty = false;
		const win = makeWin();
		const tray = setupTray(win as unknown as Electron.BrowserWindow);
		expect(tray).toBeDefined();
		const instance = trayInstances.at(-1);
		expect(instance?.tooltips).toEqual(["WinSTT - Speech to Text"]);
		expect(instance?.handlers.has("click")).toBe(true);
		expect(instance?.handlers.has("right-click")).toBe(true);
	});

	test("click handler shows the main window", () => {
		existsSyncReturn = true;
		createFromPathEmpty = false;
		const win = makeWin();
		setupTray(win as unknown as Electron.BrowserWindow);
		const instance = trayInstances.at(-1);
		const click = instance?.handlers.get("click");
		click?.();
		expect(win.showCount).toBe(1);
	});

	test("right-click handler forwards bounds to showTrayMenuAt", () => {
		existsSyncReturn = true;
		createFromPathEmpty = false;
		const before = showTrayMenuCalls.length;
		const win = makeWin();
		setupTray(win as unknown as Electron.BrowserWindow);
		const instance = trayInstances.at(-1);
		const rightClick = instance?.handlers.get("right-click");
		rightClick?.({}, { x: 10, y: 20, width: 4, height: 6 });
		expect(showTrayMenuCalls.length).toBe(before + 1);
		expect(showTrayMenuCalls.at(-1)).toEqual({ x: 10, y: 26 });
	});

	test("uses empty image when icon file does not exist", () => {
		existsSyncReturn = false;
		createFromPathEmpty = false;
		const win = makeWin();
		const tray = setupTray(win as unknown as Electron.BrowserWindow);
		expect(tray).toBeDefined();
	});

	test("uses empty image when icon loads but is empty", () => {
		existsSyncReturn = true;
		createFromPathEmpty = true;
		const win = makeWin();
		const tray = setupTray(win as unknown as Electron.BrowserWindow);
		expect(tray).toBeDefined();
	});
});
