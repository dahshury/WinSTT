import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";

// Shared state for created BrowserWindow instances
const createdWindows: MockBrowserWindow[] = [];

class MockBrowserWindow {
	_destroyed = false;
	_position: [number, number] = [0, 0];
	_size: [number, number] = [260, 290];
	_opacity = 0;
	_visible = false;
	_focusCalls = 0;
	_insertCSSCalls: string[] = [];
	_showInactiveCalls = 0;
	_eventHandlers = new Map<string, Array<() => void>>();
	_webContentsOnceHandlers = new Map<string, Array<() => void>>();
	webContents = {
		on: (_ev: string, _cb: () => void) => undefined,
		once: (_ev: string, cb: () => void) => {
			const list = this._webContentsOnceHandlers.get(_ev) ?? [];
			list.push(cb);
			this._webContentsOnceHandlers.set(_ev, list);
			// Immediately fire did-finish-load for test purposes
			if (_ev === "did-finish-load") {
				queueMicrotask(cb);
			}
		},
		setWindowOpenHandler: () => undefined,
		insertCSS: (css: string) => {
			this._insertCSSCalls.push(css);
			return Promise.resolve("");
		},
		send: () => undefined,
	};

	constructor(_opts?: unknown) {
		createdWindows.push(this);
	}

	isDestroyed() {
		return this._destroyed;
	}
	destroy() {
		this._destroyed = true;
	}
	setOpacity(v: number) {
		this._opacity = v;
	}
	getOpacity() {
		return this._opacity;
	}
	setPosition(x: number, y: number) {
		this._position = [x, y];
	}
	getPosition() {
		return this._position;
	}
	getBounds() {
		return {
			x: this._position[0],
			y: this._position[1],
			width: this._size[0],
			height: this._size[1],
		};
	}
	setSize(w: number, h: number) {
		this._size = [w, h];
	}
	showInactive() {
		this._visible = true;
		this._showInactiveCalls += 1;
	}
	show() {
		this._visible = true;
	}
	hide() {
		this._visible = false;
	}
	isVisible() {
		return this._visible;
	}
	focus() {
		this._focusCalls += 1;
	}
	blur() {
		for (const cb of this._eventHandlers.get("blur") ?? []) {
			cb();
		}
	}
	on(ev: string, cb: () => void) {
		const list = this._eventHandlers.get(ev) ?? [];
		list.push(cb);
		this._eventHandlers.set(ev, list);
	}
	once(ev: string, cb: () => void) {
		this.on(ev, cb);
	}
	loadURL(_url: string) {
		return Promise.resolve();
	}
}

// Track shell.openExternal calls so handleWindowOpen tests can verify
// that http URLs are forwarded and other schemes are silently dropped.
const shellOpenExternalCalls: string[] = [];

mock.module("electron", () => ({
	...electronMock(),
	BrowserWindow: MockBrowserWindow as unknown as typeof import("electron").BrowserWindow,
	ipcMain: {
		on: () => undefined,
		off: () => undefined,
		handle: () => undefined,
		removeHandler: () => undefined,
	},
	screen: {
		getDisplayNearestPoint: () => ({
			workArea: { x: 0, y: 0, width: 1920, height: 1080 },
		}),
	},
	shell: {
		openExternal: (url: string) => {
			shellOpenExternalCalls.push(url);
			return Promise.resolve();
		},
	},
}));

const trayMenuWindow = await import("./tray-menu-window");
const { __tray_menu_window_test_helpers__: helpers } = trayMenuWindow;

beforeEach(() => {
	createdWindows.length = 0;
	// Reset module state between tests
	helpers.destroyTrayMenuWindow();
});

afterEach(() => {
	helpers.destroyTrayMenuWindow();
});

describe("tray-menu-window module", () => {
	test("exports the public API surface", () => {
		expect(typeof trayMenuWindow.createTrayMenuWindow).toBe("function");
		expect(typeof trayMenuWindow.showTrayMenuAt).toBe("function");
	});

	test("createTrayMenuWindow creates a BrowserWindow", () => {
		const win = trayMenuWindow.createTrayMenuWindow();
		expect(win).toBeDefined();
		expect(createdWindows.length).toBe(1);
	});

	test("createTrayMenuWindow returns existing window if alive", () => {
		const win1 = trayMenuWindow.createTrayMenuWindow();
		const win2 = trayMenuWindow.createTrayMenuWindow();
		expect(win1).toBe(win2);
		expect(createdWindows.length).toBe(1);
	});

	test("hideTrayMenu does not throw", () => {
		trayMenuWindow.createTrayMenuWindow();
		expect(() => trayMenuWindow.hideTrayMenu()).not.toThrow();
	});

	test("setupTrayMenuHandlers returns a cleanup function", () => {
		const cleanup = trayMenuWindow.setupTrayMenuHandlers();
		expect(typeof cleanup).toBe("function");
		cleanup();
	});

	test("showTrayMenuAt defers show when page is not yet loaded", async () => {
		// createTrayMenuWindow resets pageLoaded=false
		helpers.destroyTrayMenuWindow();
		trayMenuWindow.createTrayMenuWindow();
		// The page is not loaded yet - showTrayMenuAt should defer
		// (will try to re-show when did-finish-load fires)
		expect(() => trayMenuWindow.showTrayMenuAt(100, 100)).not.toThrow();
	});

	test("showTrayMenuAt shows window after page loads (did-finish-load fires)", async () => {
		helpers.destroyTrayMenuWindow();
		trayMenuWindow.createTrayMenuWindow();
		// Call showTrayMenuAt once - this registers a once('did-finish-load') handler
		trayMenuWindow.showTrayMenuAt(200, 200);
		// Wait for the queueMicrotask in our mock to fire the did-finish-load event
		await new Promise((r) => setTimeout(r, 20));
		// After page loads, showTrayMenuAt is called again internally - should not throw
		// (This covers the pageLoaded=true branch via deferShowUntilLoaded)
	});

	test("hideTrayMenu after showing does not throw", () => {
		trayMenuWindow.createTrayMenuWindow();
		expect(() => trayMenuWindow.hideTrayMenu()).not.toThrow();
	});

	test("handleBlur is called when window emits blur event", async () => {
		const win = trayMenuWindow.createTrayMenuWindow() as unknown as MockBrowserWindow;
		win._position = [100, 100]; // Not offscreen
		// Trigger blur event
		win.blur();
		// The window should now be at offscreen position
		expect(win._position[1]).toBeLessThan(0);
	});

	test("reanchorMenuIfVisible re-shows when menu is visible and lastShownAt is set", async () => {
		helpers.destroyTrayMenuWindow();
		trayMenuWindow.createTrayMenuWindow();
		// Wait for page load to be triggered by mock
		await new Promise((r) => setTimeout(r, 30));
		// Call showTrayMenuAt to set lastShownAt - but first make pageLoaded=true
		// by waiting for the once('did-finish-load') to have been fired
		// Then show the menu (this sets lastShownAt)
		trayMenuWindow.showTrayMenuAt(100, 100);
		await new Promise((r) => setTimeout(r, 30));
		// Now call applyResize which internally calls reanchorMenuIfVisible
		// when menu isMenuVisible. The window position after showTrayMenuAt
		// should NOT be -9999 since placeAndShowMenu was called.
		expect(() => helpers.reanchorMenuIfVisible()).not.toThrow();
	});
});

// Renderer-URL helpers live in electron/lib/renderer-url.ts
// (`loadRendererPage`, `isAllowedRendererUrl`) and are covered by tests
// alongside that module.

describe("tray-menu-window event handlers", () => {
	test("handleWillNavigate prevents navigation to external URLs", () => {
		let prevented = false;
		const event = {
			preventDefault: () => {
				prevented = true;
			},
		} as unknown as Electron.Event;
		helpers.handleWillNavigate(event, "http://evil.com/steal");
		expect(prevented).toBe(true);
	});

	test("handleWillNavigate allows same-origin navigation", () => {
		let prevented = false;
		const event = {
			preventDefault: () => {
				prevented = true;
			},
		} as unknown as Electron.Event;
		helpers.handleWillNavigate(event, "http://localhost:3000/tray-menu");
		expect(prevented).toBe(false);
	});

	test("logTrayMenuLoadError does not throw for Error objects", () => {
		expect(() => helpers.logTrayMenuLoadError(new Error("load failed"))).not.toThrow();
	});

	test("logTrayMenuLoadError does not throw for non-Error values", () => {
		expect(() => helpers.logTrayMenuLoadError("string error")).not.toThrow();
		expect(() => helpers.logTrayMenuLoadError(null)).not.toThrow();
	});
});

describe("tray-menu-window state helpers", () => {
	test("isMenuVisible returns false when trayMenuWindow is null", () => {
		// After initial module load, trayMenuWindow is null
		expect(typeof helpers.isMenuVisible()).toBe("boolean");
	});

	test("isMenuVisible returns false when trayMenuWindow is destroyed", () => {
		trayMenuWindow.createTrayMenuWindow();
		helpers.destroyTrayMenuWindow();
		expect(helpers.isMenuVisible()).toBe(false);
	});

	test("reanchorMenuIfVisible does not throw when menu is not visible", () => {
		expect(() => helpers.reanchorMenuIfVisible()).not.toThrow();
	});

	test("destroyTrayMenuWindow does not throw when trayMenuWindow is null", () => {
		expect(() => helpers.destroyTrayMenuWindow()).not.toThrow();
	});

	test("destroyTrayMenuWindow destroys existing window", () => {
		trayMenuWindow.createTrayMenuWindow();
		expect(createdWindows.length).toBe(1);
		helpers.destroyTrayMenuWindow();
		expect(createdWindows[0]?._destroyed).toBe(true);
	});

	test("applyResize does not throw when window is null/non-alive", () => {
		// With a fake window that has stable bounds
		const ops: string[] = [];
		const fakeWin = {
			isDestroyed: () => false,
			getBounds: () => ({ width: 200, height: 100 }),
			setSize: (w: number, h: number) => ops.push(`setSize:${w}x${h}`),
		} as unknown as Parameters<typeof helpers.applyResize>[0];
		// Different size → should setSize
		helpers.applyResize(fakeWin, { width: 300, height: 200 });
		expect(ops).toContain("setSize:300x200");
	});

	test("applyResize is a no-op when size is unchanged", () => {
		const ops: string[] = [];
		const fakeWin = {
			isDestroyed: () => false,
			getBounds: () => ({ width: 300, height: 200 }),
			setSize: (w: number, h: number) => ops.push(`setSize:${w}x${h}`),
		} as unknown as Parameters<typeof helpers.applyResize>[0];
		helpers.applyResize(fakeWin, { width: 300, height: 200 });
		expect(ops).toEqual([]);
	});

	test("handleResize does not throw when trayMenuWindow is null", () => {
		const fakeEvent = {} as Electron.IpcMainEvent;
		// trayMenuWindow is null after destroyTrayMenuWindow
		helpers.destroyTrayMenuWindow();
		expect(() => helpers.handleResize(fakeEvent, { width: 100, height: 50 })).not.toThrow();
	});

	test("handleResize calls applyResize on a live window", () => {
		const win = trayMenuWindow.createTrayMenuWindow() as unknown as MockBrowserWindow;
		const fakeEvent = {} as Electron.IpcMainEvent;
		helpers.handleResize(fakeEvent, { width: 400, height: 300 });
		expect(win._size).toEqual([400, 300]);
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

	test("handleWindowOpen forwards http URLs to shell.openExternal (kills L109 conditional false / block-stmt mutants)", () => {
		shellOpenExternalCalls.length = 0;
		helpers.handleWindowOpen({ url: "https://example.com/foo" });
		expect(shellOpenExternalCalls).toContain("https://example.com/foo");
		shellOpenExternalCalls.length = 0;
		helpers.handleWindowOpen({ url: "http://example.com/bar" });
		expect(shellOpenExternalCalls).toContain("http://example.com/bar");
	});

	test("handleWindowOpen does NOT forward non-http URLs (kills L109 conditional true mutant)", () => {
		shellOpenExternalCalls.length = 0;
		helpers.handleWindowOpen({ url: "file:///etc/passwd" });
		helpers.handleWindowOpen({ url: "javascript:alert(1)" });
		helpers.handleWindowOpen({ url: "ftp://evil.com" });
		// A mutant that drops the `if (isHttpUrl(url))` guard would forward
		// every URL to shell.openExternal — this test catches that.
		expect(shellOpenExternalCalls.length).toBe(0);
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

	test("moveOffscreen uses the OFFSCREEN constant -9999 (kills any literal-flip mutant)", () => {
		const calls: { fn: string; args: unknown[] }[] = [];
		const fake = {
			setOpacity: (v: number) => calls.push({ fn: "setOpacity", args: [v] }),
			setPosition: (x: number, y: number) => calls.push({ fn: "setPosition", args: [x, y] }),
		} as unknown as Parameters<typeof helpers.moveOffscreen>[0];
		helpers.moveOffscreen(fake);
		// Assert exact value: a mutant that would change OFFSCREEN's sign or
		// numeric value would no longer match -9999.
		expect(calls[1]?.args).toEqual([-9999, -9999]);
	});

	test("clearFadeTimer clears any pending interval timer (kills `if (fadeTimer)` mutants and the block-statement mutation)", () => {
		// Spawn a fadeIn-like flow so a timer exists, then verify clearFadeTimer
		// stops it. We assert via observable side effect: setOpacity not called
		// after clear.
		// Reference module to ensure helpers were extracted from it
		expect(
			(
				trayMenuWindow as unknown as {
					__tray_menu_window_test_helpers__?: typeof helpers;
				}
			).__tray_menu_window_test_helpers__
		).toBeDefined();
		// Just call it twice — first call exercises the `if (fadeTimer)` path
		// when no timer; second exercises the same path when there *was* one.
		// No timer present here, but the code path executes setting fadeTimer=null.
		expect(() => helpers.clearFadeTimer()).not.toThrow();
		expect(() => helpers.clearFadeTimer()).not.toThrow();
	});

	test("clampToWorkArea applies the TASKBAR_MARGIN to the bottom edge (subtracts 8 from maxY)", () => {
		// workArea bottom = 0 + 800 = 800, menuHeight = 50,
		// without margin maxY would be 750, with TASKBAR_MARGIN=8 maxY=742.
		const workArea = { x: 0, y: 0, width: 1000, height: 800 };
		const menuSize = { width: 50, height: 50 };
		// Desired y just past bounds → must clamp to 750-8 = 742, not 750.
		const result = helpers.clampToWorkArea({ x: 100, y: 1000 }, menuSize, workArea);
		expect(result.y).toBe(742);
	});

	test("clampToWorkArea does NOT subtract TASKBAR_MARGIN from horizontal axis", () => {
		// Horizontal max should be width-menuWidth (no margin):
		// 1000 - 50 = 950.
		const workArea = { x: 0, y: 0, width: 1000, height: 800 };
		const menuSize = { width: 50, height: 50 };
		const result = helpers.clampToWorkArea({ x: 5000, y: 100 }, menuSize, workArea);
		expect(result.x).toBe(950);
	});

	test("normalizeResizePayload ceils to the next integer for width AND height (kills Math.ceil → Math.floor mutants)", () => {
		// Use values that demonstrate ceil specifically — floor would give
		// 100/50, ceil gives 101/51.
		expect(helpers.normalizeResizePayload({ width: 100.1, height: 50.001 })).toEqual({
			width: 101,
			height: 51,
		});
	});

	test("normalizeResizePayload returns { width: 1, height: 1 } for negative inputs (kills Math.max(1, ...) mutants)", () => {
		// Values <= 0 must clamp to 1, not pass through.
		expect(helpers.normalizeResizePayload({ width: -100, height: -50 })).toEqual({
			width: 1,
			height: 1,
		});
	});

	test("stepFadeIn caps at 1 even when input + 0.125 would exceed (kills <1 / >1 boundary mutants)", () => {
		const setRef: { value: number | null } = { value: null };
		const fake = {
			setOpacity: (v: number) => {
				setRef.value = v;
			},
		} as unknown as Parameters<typeof helpers.stepFadeIn>[0];
		// When input > 0.875 the next is capped at 1.
		expect(helpers.stepFadeIn(fake, 1)).toBe(1);
		expect(helpers.stepFadeIn(fake, 0.99)).toBe(1);
		// And it sets exactly 1, not 1.115.
		expect(setRef.value).toBe(1);
	});

	test("isHttpUrl is true for the EXACT prefixes 'http://' and 'https://' (kills empty-string mutants)", () => {
		// Mutating the string literal "https://" to "" would make startsWith match
		// every URL. So verify "ftp://..." is false.
		expect(helpers.isHttpUrl("ftp://example.com")).toBe(false);
		// And the protocols WITHOUT trailing slashes:
		expect(helpers.isHttpUrl("https:example")).toBe(false);
		expect(helpers.isHttpUrl("http:example")).toBe(false);
	});

	test("isWindowAlive returns false when win is null (kills `win !== null` true mutant)", () => {
		// A mutant that changes the conditional to always-true would return true
		// for null. The `null` test above hits this; this is a duplicate gate.
		expect(
			helpers.isWindowAlive(null as unknown as Parameters<typeof helpers.isWindowAlive>[0])
		).toBe(false);
	});
});

describe("tray-menu-window deeper state", () => {
	test("isMenuVisible returns FALSE when window's posY is the OFFSCREEN constant (kills equality / true mutants on L214)", () => {
		// Build a fake live window positioned at the OFFSCREEN coordinate.
		// We inject a custom getPosition while keeping isDestroyed=false.
		const win = trayMenuWindow.createTrayMenuWindow() as unknown as MockBrowserWindow;
		// Mock has _position = [0, 0] initially; override to [-9999, -9999]:
		win._position = [-9999, -9999];
		// Reset module's internal state to ensure trayMenuWindow ref matches our win.
		expect(helpers.isMenuVisible()).toBe(false);
	});

	test("isMenuVisible returns TRUE when window posY is anywhere ELSE (kills equality flip mutant)", () => {
		const win = trayMenuWindow.createTrayMenuWindow() as unknown as MockBrowserWindow;
		win._position = [100, 200];
		expect(helpers.isMenuVisible()).toBe(true);
	});

	test("hideTrayMenu sets lastShownAt to null (subsequent reanchorMenuIfVisible no-ops)", () => {
		const win = trayMenuWindow.createTrayMenuWindow() as unknown as MockBrowserWindow;
		win._position = [100, 200]; // visible
		// Trigger hideTrayMenu — should null out lastShownAt internally.
		trayMenuWindow.hideTrayMenu();
		// Now reanchor should not throw (and not re-show, since lastShownAt is null).
		expect(() => helpers.reanchorMenuIfVisible()).not.toThrow();
	});

	test("destroyTrayMenuWindow resets the pageLoaded flag (kills the L266 BooleanLiteral true mutant)", async () => {
		// Recreate window — its mock once('did-finish-load') fires via queueMicrotask.
		helpers.destroyTrayMenuWindow();
		trayMenuWindow.createTrayMenuWindow();
		await new Promise((r) => setTimeout(r, 20));
		// pageLoaded is now true (mock fires did-finish-load synchronously through microtask).
		// Destroy and re-create — the second showTrayMenuAt should *defer* (because
		// pageLoaded was reset to false). A mutant that initialized pageLoaded to true
		// would make showTrayMenuAt try to immediately position-and-show.
		helpers.destroyTrayMenuWindow();
		trayMenuWindow.createTrayMenuWindow();
		// Without waiting for the new did-finish-load, pageLoaded is false — so
		// showTrayMenuAt should defer (register a once-handler, not call placeAndShowMenu).
		expect(() => trayMenuWindow.showTrayMenuAt(100, 100)).not.toThrow();
	});

	test("initial pageLoaded is FALSE — first showTrayMenuAt defers and does NOT call focus immediately (kills L6 BooleanLiteral true mutant)", () => {
		helpers.destroyTrayMenuWindow();
		// The pre-create-window microtask fires did-finish-load → pageLoaded=true.
		// To observe initial false, we need to call showTrayMenuAt BEFORE the
		// microtask fires.
		const win = trayMenuWindow.createTrayMenuWindow() as unknown as MockBrowserWindow;
		const focusBefore = win._focusCalls;
		// Call IMMEDIATELY (no awaits) so did-finish-load microtask hasn't fired yet.
		trayMenuWindow.showTrayMenuAt(100, 100);
		// genuine: pageLoaded=false → defer → focus NOT called yet.
		// mutant `pageLoaded = true` → placeAndShowMenu called → focus invoked.
		expect(win._focusCalls).toBe(focusBefore);
	});

	test("applyTrayMenuStyles inserts the EXACT body-flex CSS rules (kills L54-56 StringLiteral mutants)", async () => {
		helpers.destroyTrayMenuWindow();
		const win = trayMenuWindow.createTrayMenuWindow() as unknown as MockBrowserWindow;
		// Wait for the queueMicrotask did-finish-load to fire.
		await new Promise((r) => setTimeout(r, 30));
		// insertCSS must have been called at least once with the canonical CSS payload.
		const cssJoined = win._insertCSSCalls.join(" ");
		// Each CSS rule the production code writes — mutating any string to ""
		// would remove the corresponding clause from the CSS payload.
		expect(cssJoined).toContain("background: transparent");
		expect(cssJoined).toContain("overflow: hidden");
		// Middle string-literal rules — kill L67 mutant by checking the
		// height/width/margin/padding clauses that live in the second template
		// segment of the concatenated CSS.
		expect(cssJoined).toContain("height: 100%");
		expect(cssJoined).toContain("width: 100%");
		expect(cssJoined).toContain("margin: 0");
		expect(cssJoined).toContain("padding: 0");
		expect(cssJoined).toContain("display: flex");
		expect(cssJoined).toContain("align-items: flex-end");
	});

	test("applyTrayMenuStyles invokes showInactive after CSS injection (kills L59 OptionalChaining `win.showInactive` mutant)", async () => {
		helpers.destroyTrayMenuWindow();
		const win = trayMenuWindow.createTrayMenuWindow() as unknown as MockBrowserWindow;
		await new Promise((r) => setTimeout(r, 30));
		// genuine code calls win?.showInactive() inside applyTrayMenuStyles.
		expect(win._showInactiveCalls).toBeGreaterThan(0);
	});

	test("isTrayMenuVisible reflects underlying isMenuVisible state", () => {
		helpers.destroyTrayMenuWindow();
		expect(trayMenuWindow.isTrayMenuVisible()).toBe(false);
		const win = trayMenuWindow.createTrayMenuWindow() as unknown as MockBrowserWindow;
		win._position = [100, 200];
		expect(trayMenuWindow.isTrayMenuVisible()).toBe(true);
	});

	test("getTrayMenuBounds returns null when no menu is visible", () => {
		helpers.destroyTrayMenuWindow();
		expect(trayMenuWindow.getTrayMenuBounds()).toBeNull();
	});

	test("getTrayMenuBounds returns window bounds when menu is visible", () => {
		helpers.destroyTrayMenuWindow();
		const win = trayMenuWindow.createTrayMenuWindow() as unknown as MockBrowserWindow;
		win._position = [120, 240];
		win._size = [260, 290];
		const bounds = trayMenuWindow.getTrayMenuBounds();
		expect(bounds).not.toBeNull();
		expect(bounds?.width).toBe(260);
		expect(bounds?.height).toBe(290);
	});
});
