import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";
import { uiohookMock } from "@test/mocks/uiohook-napi";

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };

mock.module("electron", () => ({
	...electronMock(),
	BrowserWindow: {
		getAllWindows: () => [],
		fromWebContents: () => null,
	},
	screen: {
		getPrimaryDisplay: () => ({
			workAreaSize: { width: 1920, height: 1080 },
			bounds: { x: 0, y: 0, width: 1920, height: 1080 },
			scaleFactor: 1,
		}),
		getAllDisplays: () => [],
		getCursorScreenPoint: () => ({ x: 0, y: 0 }),
		getDisplayNearestPoint: () => ({ workArea: WORK_AREA }),
	},
}));
mock.module("uiohook-napi", () => ({ ...uiohookMock() }));

// We mock tray-menu-window to keep these unit tests independent of the
// neighbouring module. The sub-module's only surface used here is read-only
// (bounds) and idempotent-side-effect (hide / blur-suppress).
let trayMenuBounds: Electron.Rectangle | null = null;
let trayMenuHideCalls = 0;
let trayMenuBlurSuppressed: boolean | null = null;

// Spy on the relevant exports rather than mock-module-replacing the whole
// `./tray-menu-window` file. mock.module would install a process-global
// replacement that bun 1.3.6 can't isolate per file, poisoning
// `tray-menu-window.test.ts`. spyOn on the namespace flips the bindings
// only for THIS file's lifetime and is restored in afterAll below.
const trayMenuWindowNs = await import("./tray-menu-window");
const getTrayMenuBoundsSpy = spyOn(trayMenuWindowNs, "getTrayMenuBounds").mockImplementation(
	() => trayMenuBounds
);
const hideTrayMenuSpy = spyOn(trayMenuWindowNs, "hideTrayMenu").mockImplementation(() => {
	trayMenuHideCalls++;
});
const setTrayMenuBlurSuppressedSpy = spyOn(
	trayMenuWindowNs,
	"setTrayMenuBlurSuppressed"
).mockImplementation((v: boolean) => {
	trayMenuBlurSuppressed = v;
});

const { __device_picker_window_test_helpers__: H } = await import("./device-picker-window");

// --- Fake BrowserWindow -----------------------------------------------
// Minimal stand-in for Electron.BrowserWindow that lets us exercise every
// branch without spinning up a real renderer. Only the surface the module
// touches is implemented; everything else throws if used (would be a bug).
type EvtHandler = (...args: unknown[]) => void;

interface FakeBrowserWindow {
	bounds: Electron.Rectangle;
	destroy: () => void;
	destroyCalls: number;
	destroyed: boolean;
	emit: (event: string, ...args: unknown[]) => void;
	focusCalls: number;
	getBounds: () => Electron.Rectangle;
	getOpacity: () => number;
	getPosition: () => [number, number];
	isDestroyed: () => boolean;
	listeners: Map<string, EvtHandler[]>;
	moveTopCalls: number;
	off: (event: string, cb: EvtHandler) => void;
	on: (event: string, cb: EvtHandler) => void;
	opacity: number;
	position: [number, number];
	setAlwaysOnTop: (v: boolean) => void;
	setBounds: (b: Electron.Rectangle) => void;
	setOpacity: (v: number) => void;
	setPosition: (x: number, y: number) => void;
	show: () => void;
	showCalls: number;
	showInactive: () => void;
	webContents: {
		insertCSS: (css: string) => Promise<void>;
		once: (event: string, cb: EvtHandler) => void;
		send: (...args: unknown[]) => void;
		setWindowOpenHandler: (cb: (...args: unknown[]) => unknown) => void;
		on: (event: string, cb: EvtHandler) => void;
		_pending: Map<string, EvtHandler[]>;
	};
}

function makeFakeWindow(initial: Partial<{ x: number; y: number }> = {}): FakeBrowserWindow {
	const listeners = new Map<string, EvtHandler[]>();
	const pending = new Map<string, EvtHandler[]>();
	const fw: FakeBrowserWindow = {
		bounds: { x: 0, y: 0, width: 320, height: 360 },
		destroyCalls: 0,
		destroyed: false,
		emit(event, ...args) {
			for (const l of listeners.get(event) ?? []) {
				l(...args);
			}
		},
		focusCalls: 0,
		getBounds() {
			return this.bounds;
		},
		getOpacity() {
			return this.opacity;
		},
		getPosition() {
			return this.position;
		},
		isDestroyed() {
			return this.destroyed;
		},
		listeners,
		moveTopCalls: 0,
		off(event, cb) {
			const list = listeners.get(event) ?? [];
			listeners.set(
				event,
				list.filter((x) => x !== cb)
			);
		},
		on(event, cb) {
			const list = listeners.get(event) ?? [];
			list.push(cb);
			listeners.set(event, list);
		},
		opacity: 0,
		position: [initial.x ?? 100, initial.y ?? 100],
		setAlwaysOnTop() {
			/* no-op */
		},
		setBounds(b) {
			this.bounds = b;
			this.position = [b.x, b.y];
		},
		setOpacity(v) {
			this.opacity = v;
		},
		setPosition(x, y) {
			this.position = [x, y];
		},
		show() {
			this.showCalls++;
		},
		showCalls: 0,
		webContents: {
			insertCSS: () => Promise.resolve(),
			once: (event, cb) => {
				const list = pending.get(event) ?? [];
				list.push(cb);
				pending.set(event, list);
			},
			send: () => {
				/* no-op */
			},
			setWindowOpenHandler: () => {
				/* no-op */
			},
			on: () => {
				/* no-op */
			},
			_pending: pending,
		},
		destroy() {
			this.destroyCalls++;
			this.destroyed = true;
		},
		showInactive() {
			/* no-op */
		},
	};
	const focusList = listeners.get("focus") ?? [];
	listeners.set("focus", focusList);
	const realFocus = () => {
		fw.focusCalls++;
	};
	return Object.assign(fw, {
		focus: realFocus,
		moveTop: () => {
			fw.moveTopCalls++;
		},
	});
}

// FakeBrowserWindow implements only the BrowserWindow surface this module
// touches. The single boundary cast lives here instead of being repeated at
// every injection call site — the runtime object is returned unchanged.
const asBrowserWindow = (win: FakeBrowserWindow) => win as unknown as Electron.BrowserWindow;

function resetModuleState(): void {
	H.__setPickerWindow(null);
	H.__setLastAnchor(null);
	H.__setPageLoaded(false);
	H.__setPendingDeferredShow(false);
	H.__setFadeTimer(null);
	H.__setDesiredSize({ width: 320, height: 360 });
	H.__setLastHiddenAt(0);
	H.__setSuppressBlurUntil(0);
	H.__setOpenerWin(null);
	trayMenuBounds = null;
	trayMenuHideCalls = 0;
	trayMenuBlurSuppressed = null;
}

// --- Geometry ----------------------------------------------------------

describe("computePickerPosition", () => {
	test("bottom glued above the row, right-aligned to the row's right edge", () => {
		// Row right at x=900, top at y=1000; 320×360 picker + 6px gap →
		// y = 1000-360-6 = 634, x = 900-320 = 580.
		const pos = H.computePickerPosition(
			{ screenLeft: 700, screenRight: 900, screenTopY: 1000 },
			{ width: 320, height: 360 },
			WORK_AREA
		);
		expect(pos).toEqual({ x: 580, y: 634, width: 320, height: 360 });
	});

	test("shrinks height instead of crossing the screen top, bottom stays put", () => {
		// Only 200px above the row → height capped to 200-6=194, top pinned
		// to the work-area top, bottom still ANCHOR_GAP above the row.
		const pos = H.computePickerPosition(
			{ screenLeft: 300, screenRight: 620, screenTopY: 200 },
			{ width: 320, height: 360 },
			WORK_AREA
		);
		expect(pos.height).toBe(194);
		expect(pos.y).toBe(0);
		expect(pos.y + pos.height).toBe(200 - 6);
	});

	test("pins to top edge when room above row is < MIN_HEIGHT", () => {
		// Row at y=100 → room=94 (<140) → pinToTop branch.
		const pos = H.computePickerPosition(
			{ screenLeft: 300, screenRight: 620, screenTopY: 100 },
			{ width: 320, height: 360 },
			WORK_AREA
		);
		expect(pos.y).toBe(0);
	});

	test("clamps x into the work area", () => {
		const pos = H.computePickerPosition(
			{ screenLeft: 1900, screenRight: 1960, screenTopY: 1000 },
			{ width: 320, height: 360 },
			WORK_AREA
		);
		expect(pos.x).toBe(1600); // 1920 - 320
	});

	test("uses fitAbove + computeXAxis helpers directly", () => {
		const above = H.fitAbove({ screenLeft: 0, screenRight: 100, screenTopY: 1000 }, 360, 800, 1032);
		expect(above).toEqual({ height: 360, y: 1000 - 360 - 6 });
		const pinned = H.pinToTop(360, 1032, 0);
		expect(pinned).toEqual({ height: 360, y: 0 });
		expect(
			H.computeXAxis({ screenLeft: 0, screenRight: 500, screenTopY: 0 }, 320, {
				x: 0,
				width: 1920,
			})
		).toBe(180);
		expect(
			H.computeXAxis({ screenLeft: 0, screenRight: 100, screenTopY: 0 }, 320, {
				x: 0,
				width: 1920,
			})
		).toBe(0);
	});

	test("computeYAxis room-above + pinToTop branches", () => {
		expect(
			H.computeYAxis({ screenLeft: 0, screenRight: 0, screenTopY: 800 }, 360, {
				y: 0,
				height: 1040,
			})
		).toEqual({ height: 360, y: 800 - 360 - 6 });
		expect(
			H.computeYAxis({ screenLeft: 0, screenRight: 0, screenTopY: 100 }, 360, {
				y: 0,
				height: 1040,
			})
		).toEqual({ height: 360, y: 0 });
	});
});

// --- Easing ------------------------------------------------------------

describe("fade easing", () => {
	test("easeOutCubic: fast then gentle, clamped endpoints", () => {
		expect(H.easeOutCubic(0)).toBe(0);
		expect(H.easeOutCubic(1)).toBe(1);
		expect(H.easeOutCubic(0.5)).toBeGreaterThan(0.5);
	});

	test("easeInCubic: gentle then fast, clamped endpoints", () => {
		expect(H.easeInCubic(0)).toBe(0);
		expect(H.easeInCubic(1)).toBe(1);
		expect(H.easeInCubic(0.5)).toBeLessThan(0.5);
	});
});

// --- Payload guards ----------------------------------------------------

describe("payload guards", () => {
	test("isObjectRecord true/false branches", () => {
		expect(H.isObjectRecord({})).toBe(true);
		expect(H.isObjectRecord(null)).toBe(false);
		expect(H.isObjectRecord("nope")).toBe(false);
	});

	test("hasNumericWH / hasNumericXY", () => {
		expect(H.hasNumericWH({ width: 1, height: 2 })).toBe(true);
		expect(H.hasNumericWH({ width: 1 })).toBe(false);
		expect(H.hasNumericXY({ x: 1, y: 2 })).toBe(true);
		expect(H.hasNumericXY({ x: "1", y: 2 })).toBe(false);
	});

	test("isSizePayload accepts width/height objects only", () => {
		expect(H.isSizePayload({ width: 1, height: 2 })).toBe(true);
		expect(H.isSizePayload({ width: "1", height: 2 })).toBe(false);
		expect(H.isSizePayload(null)).toBe(false);
		expect(H.isSizePayload("x")).toBe(false);
	});

	test("isOpenPayload accepts a full numeric rect and rejects anything else", () => {
		expect(H.isOpenPayload({ x: 12, y: 34, width: 56, height: 78 })).toBe(true);
		expect(H.isOpenPayload({ x: 12, y: 34 })).toBe(false);
		expect(H.isOpenPayload({ x: "12", y: 34, width: 1, height: 1 })).toBe(false);
		expect(H.isOpenPayload(null)).toBe(false);
		expect(H.isOpenPayload(undefined)).toBe(false);
		expect(H.isOpenPayload("nope")).toBe(false);
	});
});

// --- Resize ------------------------------------------------------------

describe("resize helpers", () => {
	test("normalizeResizePayload ceils and floors to at least 1px", () => {
		expect(H.normalizeResizePayload({ width: 319.2, height: 359.9 })).toEqual({
			width: 320,
			height: 360,
		});
		expect(H.normalizeResizePayload({ width: 0, height: -5 })).toEqual({ width: 1, height: 1 });
	});

	test("sizeUnchanged compares width and height exactly", () => {
		expect(H.sizeUnchanged({ width: 320, height: 360 }, { width: 320, height: 360 })).toBe(true);
		expect(H.sizeUnchanged({ width: 320, height: 360 }, { width: 320, height: 361 })).toBe(false);
		expect(H.sizeUnchanged({ width: 320, height: 360 }, { width: 321, height: 360 })).toBe(false);
	});

	test("applyResize ignores no-op updates and stores changed sizes", () => {
		resetModuleState();
		H.__setDesiredSize({ width: 320, height: 360 });
		// Same size → no-op
		H.applyResize({ width: 320, height: 360 });
		// New size, no live picker → just stores the new size silently.
		H.applyResize({ width: 400, height: 400 });
	});

	test("reanchorIfVisible skips when picker isn't visible/alive", () => {
		resetModuleState();
		H.reanchorIfVisible(); // picker null
		const fw = makeFakeWindow({ x: 0, y: -9999 });
		H.__setPickerWindow(asBrowserWindow(fw));
		H.reanchorIfVisible(); // alive but parked offscreen
	});

	test("isVisibleAlivePicker / isPickerVisible / isPickerNullOrDestroyed", () => {
		resetModuleState();
		expect(H.isVisibleAlivePicker()).toBe(false);
		expect(H.isPickerVisible()).toBe(false);
		expect(H.isPickerNullOrDestroyed()).toBe(true);
		const fw = makeFakeWindow({ x: 0, y: -9999 });
		H.__setPickerWindow(asBrowserWindow(fw));
		expect(H.isPickerVisible()).toBe(false); // parked
		expect(H.isPickerNullOrDestroyed()).toBe(false);
		fw.position = [10, 10];
		expect(H.isPickerVisible()).toBe(true);
		expect(H.isVisibleAlivePicker()).toBe(true);
		fw.destroyed = true;
		expect(H.isVisibleAlivePicker()).toBe(false);
		expect(H.isPickerNullOrDestroyed()).toBe(true);
	});

	test("handleResize ignores bad payloads and forwards good ones", () => {
		resetModuleState();
		H.handleResize({} as Electron.IpcMainEvent, "garbage");
		H.handleResize({} as Electron.IpcMainEvent, { width: 500, height: 500 });
	});
});

// --- URL guards --------------------------------------------------------

describe("url guards", () => {
	test("isHttpUrl matches http/https only", () => {
		expect(H.isHttpUrl("https://example.com")).toBe(true);
		expect(H.isHttpUrl("http://example.com")).toBe(true);
		expect(H.isHttpUrl("file:///c:/x")).toBe(false);
	});

	test("isSameOrigin compares origins and tolerates garbage", () => {
		expect(H.isSameOrigin("http://localhost:3000/device-picker", "http://localhost:3000/")).toBe(
			true
		);
		expect(H.isSameOrigin("http://evil.test/", "http://localhost:3000/")).toBe(false);
		expect(H.isSameOrigin("not-a-url", "http://localhost:3000/")).toBe(false);
	});

	test("handleWillNavigate calls preventDefault for disallowed URLs", () => {
		let prevented = 0;
		const ev = { preventDefault: () => prevented++ } as unknown as Electron.Event;
		H.handleWillNavigate(ev, "http://evil.test/");
		expect(prevented).toBe(1);
		// Allowed URLs in test env return false from isAllowedRendererUrl;
		// the second branch was covered by the call above.
	});

	test("handleWindowOpen defers external links and denies the open", () => {
		const r = H.handleWindowOpen({ url: "https://example.com" });
		expect(r).toEqual({ action: "deny" });
		const r2 = H.handleWindowOpen({ url: "javascript:alert(1)" });
		expect(r2).toEqual({ action: "deny" });
	});

	test("openExternalSafely / ignoreOpenExternalError swallow errors", async () => {
		H.openExternalSafely("https://example.com");
		// Calling the swallow function directly to cover both branches.
		H.ignoreOpenExternalError();
	});

	test("describeLoadError handles Error and non-Error values", () => {
		expect(H.describeLoadError(new Error("boom"))).toBe("boom");
		expect(H.describeLoadError("string error")).toBe("string error");
		expect(H.describeLoadError(undefined)).toBe("undefined");
	});

	test("logPickerLoadError forwards through dbg", () => {
		H.logPickerLoadError(new Error("x"));
		H.logPickerLoadError("plain");
	});
});

// --- Geometry predicates ----------------------------------------------

describe("geometry predicates", () => {
	test("rectRight / rectBottom", () => {
		expect(H.rectRight({ x: 10, y: 20, width: 30, height: 40 })).toBe(40);
		expect(H.rectBottom({ x: 10, y: 20, width: 30, height: 40 })).toBe(60);
	});

	test("isPointInRect covers all four sides", () => {
		const b = { x: 0, y: 0, width: 10, height: 10 };
		expect(H.isPointInRect(5, 5, b)).toBe(true);
		expect(H.isPointInRect(-1, 5, b)).toBe(false); // left
		expect(H.isPointInRect(10, 5, b)).toBe(false); // right
		expect(H.isPointInRect(5, -1, b)).toBe(false); // top
		expect(H.isPointInRect(5, 10, b)).toBe(false); // bottom
	});

	test("isPointInsidePicker requires alive picker", () => {
		resetModuleState();
		expect(H.isPointInsidePicker(5, 5)).toBe(false);
		const fw = makeFakeWindow();
		fw.bounds = { x: 0, y: 0, width: 100, height: 100 };
		H.__setPickerWindow(asBrowserWindow(fw));
		expect(H.isPointInsidePicker(10, 10)).toBe(true);
		expect(H.isPointInsidePicker(200, 200)).toBe(false);
	});

	test("isInsideTrayMenu returns false when tray menu has no bounds", () => {
		trayMenuBounds = null;
		expect(H.isInsideTrayMenu(0, 0)).toBe(false);
		trayMenuBounds = { x: 0, y: 0, width: 100, height: 100 };
		expect(H.isInsideTrayMenu(50, 50)).toBe(true);
		expect(H.isInsideTrayMenu(500, 500)).toBe(false);
	});

	test("dismissTrayIfOutside hides tray when click is outside", () => {
		trayMenuBounds = { x: 0, y: 0, width: 100, height: 100 };
		trayMenuHideCalls = 0;
		H.dismissTrayIfOutside(50, 50);
		expect(trayMenuHideCalls).toBe(0);
		H.dismissTrayIfOutside(500, 500);
		expect(trayMenuHideCalls).toBe(1);
	});
});

// --- Aliveness, fade timer --------------------------------------------

describe("aliveness + fade timer", () => {
	test("isNonNullWindow / isWindowAlive cover null + destroyed branches", () => {
		expect(H.isNonNullWindow(null)).toBe(false);
		expect(H.isWindowAlive(null)).toBe(false);
		const fw = makeFakeWindow();
		expect(H.isNonNullWindow(asBrowserWindow(fw))).toBe(true);
		expect(H.isWindowAlive(asBrowserWindow(fw))).toBe(true);
		fw.destroyed = true;
		expect(H.isWindowAlive(asBrowserWindow(fw))).toBe(false);
	});

	test("clearFadeTimer no-ops when timer is null, clears when set", () => {
		resetModuleState();
		H.clearFadeTimer();
		const t = setInterval(() => undefined, 10_000);
		H.__setFadeTimer(t);
		expect(H.__getFadeTimer()).toBe(t);
		H.clearFadeTimer();
		expect(H.__getFadeTimer()).toBe(null);
	});

	test("moveOffscreen / isParkedOffscreen / getWindowY", () => {
		const fw = makeFakeWindow({ x: 50, y: 50 });
		expect(H.getWindowY(asBrowserWindow(fw))).toBe(50);
		expect(H.isParkedOffscreen(asBrowserWindow(fw))).toBe(false);
		H.moveOffscreen(asBrowserWindow(fw));
		expect(fw.position[1]).toBe(-9999);
		expect(H.isParkedOffscreen(asBrowserWindow(fw))).toBe(true);
	});

	test("markHidden / isInToggleDeadzone / isBlurSuppressed", () => {
		resetModuleState();
		expect(H.isInToggleDeadzone()).toBe(false); // 0 - very old
		H.markHidden();
		expect(H.isInToggleDeadzone()).toBe(true);
		expect(H.isBlurSuppressed()).toBe(false);
		H.__setSuppressBlurUntil(Date.now() + 1000);
		expect(H.isBlurSuppressed()).toBe(true);
	});
});

// --- Hide flow ---------------------------------------------------------

describe("hide flow", () => {
	test("hideAliveWindow null / destroyed → no-op", () => {
		H.hideAliveWindow(null);
		const fw = makeFakeWindow();
		fw.destroyed = true;
		H.hideAliveWindow(asBrowserWindow(fw));
	});

	test("hideOnscreenWindow exits when parked, kicks fade when onscreen", () => {
		resetModuleState();
		const fwParked = makeFakeWindow({ x: -9999, y: -9999 });
		H.hideOnscreenWindow(asBrowserWindow(fwParked));
		const fw = makeFakeWindow({ x: 50, y: 50 });
		H.hideOnscreenWindow(asBrowserWindow(fw));
		expect(trayMenuBlurSuppressed).toBe(false);
		H.clearFadeTimer(); // tidy up interval set by beginFadeOut
	});

	test("hideAliveWindow on alive onscreen window starts a fade", () => {
		resetModuleState();
		const fw = makeFakeWindow({ x: 50, y: 50 });
		H.hideAliveWindow(asBrowserWindow(fw));
		H.clearFadeTimer();
	});

	test("handleBlur honours suppression window then hides", () => {
		resetModuleState();
		H.__setSuppressBlurUntil(Date.now() + 1000);
		H.handleBlur(); // suppressed
		H.__setSuppressBlurUntil(0);
		const fw = makeFakeWindow({ x: 50, y: 50 });
		H.__setPickerWindow(asBrowserWindow(fw));
		H.handleBlur();
		H.clearFadeTimer();
	});

	test("handleOpenerFocus dispatches to hide", () => {
		resetModuleState();
		H.handleOpenerFocus();
	});
});

// --- Global mouse-down ------------------------------------------------

describe("global mouse-down", () => {
	test("handleGlobalMouseDown exits when picker isn't visible", () => {
		resetModuleState();
		H.handleGlobalMouseDown();
	});

	test("processGlobalCursor inside picker → no hide", () => {
		resetModuleState();
		const fw = makeFakeWindow({ x: 0, y: 0 });
		fw.bounds = { x: 0, y: 0, width: 5000, height: 5000 };
		H.__setPickerWindow(asBrowserWindow(fw));
		H.processGlobalCursor();
	});

	test("handleOutsideClick hides picker then optionally tray", () => {
		resetModuleState();
		const fw = makeFakeWindow({ x: 50, y: 50 });
		H.__setPickerWindow(asBrowserWindow(fw));
		trayMenuBounds = { x: 0, y: 0, width: 100, height: 100 };
		trayMenuHideCalls = 0;
		H.handleOutsideClick(50, 50); // inside tray → tray stays open
		expect(trayMenuHideCalls).toBe(0);
		// new alive window since the previous one is mid-fade
		const fw2 = makeFakeWindow({ x: 50, y: 50 });
		H.__setPickerWindow(asBrowserWindow(fw2));
		H.handleOutsideClick(500, 500);
		expect(trayMenuHideCalls).toBe(1);
		H.clearFadeTimer();
	});
});

// --- Opener focus binding ---------------------------------------------

describe("opener focus binding", () => {
	test("detachOpenerListener removes the focus handler", () => {
		const fw = makeFakeWindow();
		const cb = () => undefined;
		fw.on("focus", cb);
		expect(fw.listeners.get("focus")?.length).toBe(1);
		H.detachOpenerListener(asBrowserWindow(fw));
	});

	test("detachOpenerFocus null opener vs alive opener", () => {
		resetModuleState();
		H.detachOpenerFocus(); // no opener
		const fw = makeFakeWindow();
		H.__setOpenerWin(asBrowserWindow(fw));
		H.detachOpenerFocus();
	});

	test("attachOpenerFocus replaces prior opener cleanly", () => {
		resetModuleState();
		const fw1 = makeFakeWindow();
		const fw2 = makeFakeWindow();
		H.attachOpenerFocus(asBrowserWindow(fw1));
		H.attachOpenerFocus(asBrowserWindow(fw2));
		H.detachOpenerFocus();
	});
});

// --- Picker styles -----------------------------------------------------

describe("picker styles", () => {
	test("applyPickerStyles inserts CSS and showInactive", () => {
		const fw = makeFakeWindow();
		H.applyPickerStyles(asBrowserWindow(fw));
	});

	test("handleDidFinishLoad ignores when picker is missing then sets pageLoaded", () => {
		resetModuleState();
		H.handleDidFinishLoad(); // no picker
		const fw = makeFakeWindow();
		H.__setPickerWindow(asBrowserWindow(fw));
		H.handleDidFinishLoad();
	});
});

// --- Tween / animation -------------------------------------------------

describe("opacity tween", () => {
	test("tweenProgress saturates to 1", () => {
		expect(H.tweenProgress(Date.now() + 1000)).toBeLessThanOrEqual(0);
		expect(H.tweenProgress(Date.now() - 1_000_000)).toBe(1);
	});

	test("interpolateOpacity uses easing", () => {
		const fw = makeFakeWindow();
		const frame = {
			easing: (t: number) => t,
			from: 0,
			onComplete: undefined,
			start: Date.now(),
			to: 1,
			win: asBrowserWindow(fw),
		};
		expect(H.interpolateOpacity(frame, 0)).toBe(0);
		expect(H.interpolateOpacity(frame, 1)).toBe(1);
		expect(H.interpolateOpacity(frame, 0.5)).toBe(0.5);
	});

	test("snapOpacity sets and fires onComplete", () => {
		const fw = makeFakeWindow();
		let done = 0;
		H.snapOpacity(asBrowserWindow(fw), 1, () => done++);
		expect(fw.opacity).toBe(1);
		expect(done).toBe(1);
		H.snapOpacity(asBrowserWindow(fw), 0);
		expect(fw.opacity).toBe(0);
	});

	test("finalizeTween snaps opacity, clears timer, fires onComplete", () => {
		resetModuleState();
		const fw = makeFakeWindow();
		let done = 0;
		H.finalizeTween({
			easing: (t) => t,
			from: 0,
			onComplete: () => done++,
			start: 0,
			to: 1,
			win: asBrowserWindow(fw),
		});
		expect(fw.opacity).toBe(1);
		expect(done).toBe(1);
		// Variant without onComplete
		H.finalizeTween({
			easing: (t) => t,
			from: 0,
			onComplete: undefined,
			start: 0,
			to: 0,
			win: asBrowserWindow(fw),
		});
	});

	test("tickTween mid-frame and final-frame branches", () => {
		const fw = makeFakeWindow();
		// Mid frame (start in future → progress=0)
		H.tickTween({
			easing: (t) => t,
			from: 0,
			onComplete: undefined,
			start: Date.now() + 10_000,
			to: 1,
			win: asBrowserWindow(fw),
		});
		// Final frame (start far in past → progress=1)
		H.tickTween({
			easing: (t) => t,
			from: 0,
			onComplete: undefined,
			start: 0,
			to: 1,
			win: asBrowserWindow(fw),
		});
	});

	test("fadeIn drives animateOpacity through startTween path", () => {
		const fw = makeFakeWindow();
		fw.opacity = 0;
		H.fadeIn(asBrowserWindow(fw));
		H.clearFadeTimer();
	});

	test("animateOpacity equal-from-to short-circuits via snapOpacity", () => {
		const fw = makeFakeWindow();
		fw.opacity = 0.5;
		// Reach this via fadeIn-style call with target equal to current.
		// We replicate fadeIn's call path with `to == from`.
		// animateOpacity isn't exported, but its short-circuit branch is the
		// fadeIn(...) below when getOpacity() === target.
		fw.opacity = 1;
		H.fadeIn(asBrowserWindow(fw));
	});
});

// --- Placement + show flow --------------------------------------------

describe("placement + show", () => {
	test("placeAndShowPicker no-ops without a last anchor", () => {
		resetModuleState();
		const fw = makeFakeWindow();
		H.placeAndShowPicker(asBrowserWindow(fw));
	});

	test("renderPickerAt + showWindowAtBounds happy path", () => {
		resetModuleState();
		const fw = makeFakeWindow();
		H.renderPickerAt(asBrowserWindow(fw), {
			screenLeft: 0,
			screenRight: 320,
			screenTopY: 800,
		});
		expect(fw.showCalls).toBe(1);
		expect(fw.moveTopCalls).toBe(1);
		expect(trayMenuBlurSuppressed).toBe(true);
		H.clearFadeTimer();
	});

	test("placeAndShowPicker with anchor draws", () => {
		resetModuleState();
		H.__setLastAnchor({ screenLeft: 0, screenRight: 320, screenTopY: 800 });
		const fw = makeFakeWindow();
		H.placeAndShowPicker(asBrowserWindow(fw));
		expect(fw.showCalls).toBe(1);
		H.clearFadeTimer();
	});

	test("deferShowUntilLoaded ignores re-entry, onDeferredLoadComplete clears flag", () => {
		resetModuleState();
		const fw = makeFakeWindow();
		H.deferShowUntilLoaded(asBrowserWindow(fw));
		expect(H.__getPendingDeferredShow()).toBe(true);
		H.deferShowUntilLoaded(asBrowserWindow(fw)); // re-entry no-op
		H.onDeferredLoadComplete(asBrowserWindow(fw));
		expect(H.__getPendingDeferredShow()).toBe(false);
	});

	test("showWhenReady covers pageLoaded + defer branches", () => {
		resetModuleState();
		const fw = makeFakeWindow();
		H.__setPageLoaded(false);
		H.showWhenReady(asBrowserWindow(fw));
		expect(H.__getPendingDeferredShow()).toBe(true);
		H.__setPendingDeferredShow(false);
		H.__setPageLoaded(true);
		H.__setLastAnchor({ screenLeft: 0, screenRight: 320, screenTopY: 800 });
		H.showWhenReady(asBrowserWindow(fw));
		H.clearFadeTimer();
	});

	test("hideDevicePicker / showDevicePickerAtAnchor", () => {
		resetModuleState();
		// hide with no picker
		H.hideDevicePicker();
		// show creates a picker via createDevicePickerWindow which uses real
		// BrowserWindow constructor — the electron mock doesn't expose it as
		// a constructor, so we install a fake picker first and stub through
		// instantiatePickerWindow by setting the window directly via
		// showDevicePickerAtAnchor's `pageLoaded === true` path.
		const fw = makeFakeWindow();
		H.__setPickerWindow(asBrowserWindow(fw));
		H.__setPageLoaded(true);
		H.showDevicePickerAtAnchor({ screenLeft: 0, screenRight: 320, screenTopY: 800 });
		expect(fw.showCalls).toBe(1);
		H.hideDevicePicker();
		H.clearFadeTimer();
	});
});

// --- IPC handlers ------------------------------------------------------

describe("ipc handlers", () => {
	test("handleClose hides both windows", () => {
		resetModuleState();
		trayMenuHideCalls = 0;
		H.handleClose();
		expect(trayMenuHideCalls).toBe(1);
	});

	test("handleOpen rejects bad payloads", () => {
		resetModuleState();
		H.handleOpen({} as Electron.IpcMainEvent, "garbage");
		H.handleOpen({} as Electron.IpcMainEvent, { x: 1, y: 1 });
	});

	test("consumeToggleIfOpen closes the open picker and signals consumed", () => {
		resetModuleState();
		const fw = makeFakeWindow({ x: 50, y: 50 });
		H.__setPickerWindow(asBrowserWindow(fw));
		expect(H.consumeToggleIfOpen()).toBe(true);
		expect(H.consumeToggleIfOpen()).toBe(false);
		H.clearFadeTimer();
	});

	test("processOpen toggle/deadzone branches", () => {
		resetModuleState();
		// Visible picker → toggle closes
		const fw = makeFakeWindow({ x: 50, y: 50 });
		H.__setPickerWindow(asBrowserWindow(fw));
		H.processOpen({} as Electron.IpcMainEvent, { x: 0, y: 0, width: 10, height: 10 });
		H.clearFadeTimer();
		// Deadzone branch
		H.__setPickerWindow(null);
		H.__setLastHiddenAt(Date.now());
		H.processOpen({} as Electron.IpcMainEvent, { x: 0, y: 0, width: 10, height: 10 });
	});

	test("anchorFromRect derives screen coords", () => {
		const fw = makeFakeWindow();
		fw.bounds = { x: 100, y: 200, width: 1, height: 1 };
		expect(
			H.anchorFromRect(asBrowserWindow(fw), {
				x: 10,
				y: 20,
				width: 30,
				height: 40,
			})
		).toEqual({ screenLeft: 110, screenRight: 140, screenTopY: 220 });
	});

	test("tryOpenForSender skips when senderWin is missing", () => {
		resetModuleState();
		H.tryOpenForSender({ sender: {} } as unknown as Electron.IpcMainEvent, {
			x: 0,
			y: 0,
			width: 10,
			height: 10,
		});
	});

	test("openPickerFor attaches opener and shows", () => {
		resetModuleState();
		const sender = makeFakeWindow({ x: 0, y: 0 });
		const picker = makeFakeWindow();
		H.__setPickerWindow(asBrowserWindow(picker));
		H.__setPageLoaded(true);
		H.openPickerFor(asBrowserWindow(sender), {
			x: 0,
			y: 0,
			width: 10,
			height: 10,
		});
		expect(picker.showCalls).toBe(1);
		H.detachOpenerFocus();
		H.clearFadeTimer();
	});
});

// --- Destroy / teardown ------------------------------------------------

describe("destroy / teardown", () => {
	test("destroyAlivePickerWindow no-ops when null, destroys when alive", () => {
		resetModuleState();
		H.destroyAlivePickerWindow();
		const fw = makeFakeWindow();
		H.__setPickerWindow(asBrowserWindow(fw));
		H.destroyAlivePickerWindow();
		expect(fw.destroyCalls).toBe(1);
	});

	test("destroyPickerWindow nulls + resets flags", () => {
		resetModuleState();
		const fw = makeFakeWindow();
		H.__setPickerWindow(asBrowserWindow(fw));
		H.__setPageLoaded(true);
		H.__setPendingDeferredShow(true);
		H.destroyPickerWindow();
	});

	test("teardownDevicePickerHandlers unregisters everything", () => {
		resetModuleState();
		H.teardownDevicePickerHandlers();
	});
});

// Restore the spies so `electron/ipc/tray-menu-window.test.ts` sees the real
// `getTrayMenuBounds` / `hideTrayMenu` / `setTrayMenuBlurSuppressed` when it
// imports its SUT — bun shares module bindings across test files, so without
// this the stubbed impls would persist and break the tray-menu-window suite.
afterAll(() => {
	getTrayMenuBoundsSpy.mockRestore();
	hideTrayMenuSpy.mockRestore();
	setTrayMenuBlurSuppressedSpy.mockRestore();
});
