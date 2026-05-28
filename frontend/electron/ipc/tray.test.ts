import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as realFs from "node:fs";
import { electronMock } from "@test/mocks/electron";

type TrayHandler = (...args: unknown[]) => void;

interface TrayInstance {
	contextMenus: unknown[];
	destroyed: boolean;
	handlers: Map<string, TrayHandler>;
	imageCount: number;
	isDestroyed: () => boolean;
	on: (event: string, handler: TrayHandler) => void;
	setContextMenu: (menu: unknown) => void;
	setImage: () => void;
	setToolTip: (tip: string) => void;
	tooltips: string[];
}

const trayInstances: TrayInstance[] = [];

function makeTray(): TrayInstance {
	const handlers = new Map<string, TrayHandler>();
	const instance: TrayInstance = {
		contextMenus: [],
		destroyed: false,
		handlers,
		imageCount: 0,
		isDestroyed() {
			return instance.destroyed;
		},
		tooltips: [],
		setToolTip(tip: string) {
			instance.tooltips.push(tip);
		},
		on(event: string, handler: TrayHandler) {
			handlers.set(event, handler);
		},
		setImage() {
			instance.imageCount += 1;
		},
		setContextMenu(menu: unknown) {
			instance.contextMenus.push(menu);
		},
	};
	trayInstances.push(instance);
	return instance;
}

let createFromPathEmpty = false;
let existsSyncReturn = true;

const themeListeners: Array<() => void> = [];

mock.module("electron", () => ({
	...electronMock(),
	nativeImage: {
		createFromPath: () => ({ isEmpty: () => createFromPathEmpty }),
		createEmpty: () => ({ isEmpty: () => true }),
	},
	nativeTheme: {
		shouldUseDarkColors: true,
		on: (event: string, cb: () => void) => {
			if (event === "updated") {
				themeListeners.push(cb);
			}
		},
		off: (event: string, cb: () => void) => {
			if (event === "updated") {
				const idx = themeListeners.indexOf(cb);
				if (idx !== -1) {
					themeListeners.splice(idx, 1);
				}
			}
		},
	},
	Menu: {
		buildFromTemplate: (template: unknown[]) => ({ template }),
	},
	Tray: function TrayCtor(this: TrayInstance) {
		const t = makeTray();
		Object.assign(this, t);
		return this;
	} as unknown as typeof import("electron").Tray,
}));

// Spread `realFs` so sibling tests that share bun's process-global mock
// registry still see real readFileSync/readdirSync/etc — without it, any
// later test that imports `node:fs` and calls anything besides existsSync
// gets `undefined` and crashes (see z-index-discipline.test.ts).
mock.module("node:fs", () => ({
	...realFs,
	default: { ...realFs, existsSync: () => existsSyncReturn },
	existsSync: () => existsSyncReturn,
}));

const showTrayMenuCalls: Array<{ x: number; y: number }> = [];
// Spy on the real `showTrayMenuAt` rather than mock-module-replacing the
// whole `./tray-menu-window` file. mock.module would install a process-
// global replacement that bun 1.3.6 can't isolate per file, poisoning
// `tray-menu-window.test.ts`. spyOn on the namespace flips the binding
// only for THIS file's lifetime and is restored in afterAll below.
const trayMenuWindowNs = await import("./tray-menu-window");
const showTrayMenuAtSpy = spyOn(trayMenuWindowNs, "showTrayMenuAt").mockImplementation(
	(x: number, y: number) => {
		showTrayMenuCalls.push({ x, y });
	}
);

const { setupTray } = await import("./tray");
const trayStateNs = await import("./tray-state");

function makeWin(): { show: () => void; showCount: number } {
	const win = {
		showCount: 0,
		show() {
			win.showCount++;
		},
	};
	return win;
}

// The mock window exposes only the `show()` surface `setupTray` touches; this
// helper contains the single boundary cast so it isn't repeated per call site.
// The runtime object is returned unchanged.
const asBrowserWin = (w: { show: () => void; showCount: number }) =>
	w as unknown as Electron.BrowserWindow;

describe("setupTray", () => {
	afterEach(() => {
		// Reset the tray-state singleton between tests so each setupTray
		// call attaches against a clean slate (no stale theme listener, no
		// previous Tray reference).
		trayStateNs.__tray_state_test_helpers__.resetForTests();
	});

	test("module exports the setup function", () => {
		expect(typeof setupTray).toBe("function");
	});

	test("returns a tray, sets tooltip, and registers click/right-click", () => {
		existsSyncReturn = true;
		createFromPathEmpty = false;
		const win = makeWin();
		const tray = setupTray(asBrowserWin(win));
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
		setupTray(asBrowserWin(win));
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
		setupTray(asBrowserWin(win));
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
		const tray = setupTray(asBrowserWin(win));
		expect(tray).toBeDefined();
	});

	test("uses empty image when icon loads but is empty", () => {
		existsSyncReturn = true;
		createFromPathEmpty = true;
		const win = makeWin();
		const tray = setupTray(asBrowserWin(win));
		expect(tray).toBeDefined();
	});
});

// Restore the spy so `electron/ipc/tray-menu-window.test.ts` sees the real
// `showTrayMenuAt` when it imports its SUT — bun shares module bindings
// across test files, so without this the stubbed impl would persist and
// break the tray-menu-window suite.
afterAll(() => {
	showTrayMenuAtSpy.mockRestore();
});
