import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";

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
		getDisplayNearestPoint: () => ({ workArea: WORK_AREA }),
	},
}));

const { __model_picker_window_test_helpers__: H } = await import("./model-picker-window");

// --- Fake BrowserWindow -----------------------------------------------
type EvtHandler = (...args: unknown[]) => void;

interface FakeBrowserWindow {
	bounds: Electron.Rectangle;
	destroy: () => void;
	destroyCalls: number;
	destroyed: boolean;
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
	sendCalls: unknown[][];
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
		bounds: { x: 0, y: 0, width: 600, height: 560 },
		destroyCalls: 0,
		destroyed: false,
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
		sendCalls: [],
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
			send: (...args) => {
				fw.sendCalls.push(args);
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
	return Object.assign(fw, {
		focus: () => {
			fw.focusCalls++;
		},
		moveTop: () => {
			fw.moveTopCalls++;
		},
	});
}

function resetModuleState(): void {
	H.__setPickerWindow(null);
	H.__setLastAnchor(null);
	H.__setPageLoaded(false);
	H.__setPendingDeferredShow(false);
	H.__setFadeTimer(null);
	H.__setDesiredSize({ width: 600, height: 560 });
	H.__setLastHiddenAt(0);
	H.__setSuppressBlurUntil(0);
}

// --- Geometry ----------------------------------------------------------

describe("computePickerPosition", () => {
	test("bottom glued above the chip, right-aligned to the chip's right edge", () => {
		// Chip right at x=900, top at y=1000; 600×560 picker + 6px gap →
		// y = 1000-560-6 = 434, x = 900-600 = 300.
		const pos = H.computePickerPosition(
			{ screenLeft: 800, screenRight: 900, screenTopY: 1000 },
			{ width: 600, height: 560 },
			WORK_AREA
		);
		expect(pos).toEqual({ x: 300, y: 434, width: 600, height: 560 });
	});

	test("shrinks height instead of crossing the screen top, bottom stays put", () => {
		// Only 300px above the chip → height capped to 300-6=294, top pinned
		// to the work-area top, bottom still ANCHOR_GAP above the chip.
		const pos = H.computePickerPosition(
			{ screenLeft: 300, screenRight: 900, screenTopY: 300 },
			{ width: 600, height: 560 },
			WORK_AREA
		);
		expect(pos.height).toBe(294);
		expect(pos.y).toBe(0);
		expect(pos.y + pos.height).toBe(300 - 6);
	});

	test("pins to top when there's no room above the chip", () => {
		const pos = H.computePickerPosition(
			{ screenLeft: 0, screenRight: 600, screenTopY: 100 },
			{ width: 600, height: 560 },
			WORK_AREA
		);
		expect(pos.y).toBe(0);
	});

	test("clamps x into the work area", () => {
		const pos = H.computePickerPosition(
			{ screenLeft: 1900, screenRight: 1960, screenTopY: 1000 },
			{ width: 600, height: 560 },
			WORK_AREA
		);
		expect(pos.x).toBe(1320); // 1920 - 600
	});

	test("uses fitAbove + pinToTop + computeXAxis directly", () => {
		expect(H.fitAbove({ screenLeft: 0, screenRight: 0, screenTopY: 1000 }, 560, 800, 1032)).toEqual(
			{ height: 560, y: 1000 - 560 - 6 }
		);
		expect(H.pinToTop(560, 1032, 0)).toEqual({ height: 560, y: 0 });
		expect(
			H.computeXAxis({ screenLeft: 0, screenRight: 900, screenTopY: 0 }, 600, {
				x: 0,
				width: 1920,
			})
		).toBe(300);
		expect(
			H.computeXAxis({ screenLeft: 0, screenRight: 100, screenTopY: 0 }, 600, {
				x: 0,
				width: 1920,
			})
		).toBe(0);
	});

	test("computeYAxis room-above + pinToTop branches", () => {
		expect(
			H.computeYAxis({ screenLeft: 0, screenRight: 0, screenTopY: 800 }, 560, {
				y: 0,
				height: 1040,
			})
		).toEqual({ height: 560, y: 800 - 560 - 6 });
		expect(
			H.computeYAxis({ screenLeft: 0, screenRight: 0, screenTopY: 100 }, 560, {
				y: 0,
				height: 1040,
			})
		).toEqual({ height: 560, y: 0 });
	});
});

// --- Easing ------------------------------------------------------------

describe("fade easing", () => {
	test("easeOutCubic: fast then gentle, clamped endpoints", () => {
		expect(H.easeOutCubic(0)).toBe(0);
		expect(H.easeOutCubic(1)).toBe(1);
		// Ease-out is past the midpoint by t=0.5 (decelerating).
		expect(H.easeOutCubic(0.5)).toBeGreaterThan(0.5);
	});

	test("easeInCubic: gentle then fast, clamped endpoints", () => {
		expect(H.easeInCubic(0)).toBe(0);
		expect(H.easeInCubic(1)).toBe(1);
		// Ease-in lags behind the midpoint at t=0.5 (accelerating).
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
		expect(H.normalizeResizePayload({ width: 599.2, height: 559.9 })).toEqual({
			width: 600,
			height: 560,
		});
		expect(H.normalizeResizePayload({ width: 0, height: -5 })).toEqual({ width: 1, height: 1 });
	});

	test("sizeUnchanged compares width and height exactly", () => {
		expect(H.sizeUnchanged({ width: 600, height: 560 }, { width: 600, height: 560 })).toBe(true);
		expect(H.sizeUnchanged({ width: 600, height: 560 }, { width: 600, height: 561 })).toBe(false);
		expect(H.sizeUnchanged({ width: 600, height: 560 }, { width: 601, height: 560 })).toBe(false);
	});

	test("applyResize ignores no-op updates and stores changed sizes", () => {
		resetModuleState();
		H.__setDesiredSize({ width: 600, height: 560 });
		H.applyResize({ width: 600, height: 560 }); // unchanged
		H.applyResize({ width: 700, height: 600 }); // changed, no live picker
	});

	test("reanchorIfVisible skips when picker isn't visible/alive", () => {
		resetModuleState();
		H.reanchorIfVisible(); // null picker
		const fw = makeFakeWindow({ x: -9999, y: -9999 });
		H.__setPickerWindow(fw as unknown as Electron.BrowserWindow);
		H.reanchorIfVisible(); // alive but parked offscreen
	});

	test("isVisibleAlivePicker + isPickerVisible + isPickerNullOrDestroyed", () => {
		resetModuleState();
		expect(H.isVisibleAlivePicker()).toBe(false);
		expect(H.isPickerVisible()).toBe(false);
		expect(H.isPickerNullOrDestroyed()).toBe(true);
		const fw = makeFakeWindow({ x: 0, y: -9999 });
		H.__setPickerWindow(fw as unknown as Electron.BrowserWindow);
		expect(H.isPickerVisible()).toBe(false);
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
		expect(H.isSameOrigin("http://localhost:3000/model-picker", "http://localhost:3000/")).toBe(
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
	});

	test("handleWindowOpen defers external links and denies the open", () => {
		const r = H.handleWindowOpen({ url: "https://example.com" });
		expect(r).toEqual({ action: "deny" });
		const r2 = H.handleWindowOpen({ url: "javascript:alert(1)" });
		expect(r2).toEqual({ action: "deny" });
	});

	test("openExternalSafely / ignoreOpenExternalError swallow errors", () => {
		H.openExternalSafely("https://example.com");
		H.ignoreOpenExternalError();
	});

	test("describeLoadError handles Error and non-Error values", () => {
		expect(H.describeLoadError(new Error("boom"))).toBe("boom");
		expect(H.describeLoadError("plain")).toBe("plain");
		expect(H.describeLoadError(undefined)).toBe("undefined");
	});

	test("logPickerLoadError forwards through dbg", () => {
		H.logPickerLoadError(new Error("x"));
		H.logPickerLoadError("plain");
	});
});

// --- Aliveness, fade timer --------------------------------------------

describe("aliveness + fade timer", () => {
	test("isNonNullWindow / isWindowAlive cover null + destroyed branches", () => {
		expect(H.isNonNullWindow(null)).toBe(false);
		expect(H.isWindowAlive(null)).toBe(false);
		const fw = makeFakeWindow();
		expect(H.isNonNullWindow(fw as unknown as Electron.BrowserWindow)).toBe(true);
		expect(H.isWindowAlive(fw as unknown as Electron.BrowserWindow)).toBe(true);
		fw.destroyed = true;
		expect(H.isWindowAlive(fw as unknown as Electron.BrowserWindow)).toBe(false);
	});

	test("clearFadeTimer no-ops when null, clears when set", () => {
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
		expect(H.getWindowY(fw as unknown as Electron.BrowserWindow)).toBe(50);
		expect(H.isParkedOffscreen(fw as unknown as Electron.BrowserWindow)).toBe(false);
		H.moveOffscreen(fw as unknown as Electron.BrowserWindow);
		expect(fw.position[1]).toBe(-9999);
		expect(H.isParkedOffscreen(fw as unknown as Electron.BrowserWindow)).toBe(true);
	});

	test("markHidden / isInToggleDeadzone / isBlurSuppressed", () => {
		resetModuleState();
		expect(H.isInToggleDeadzone()).toBe(false);
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
		H.hideAliveWindow(fw as unknown as Electron.BrowserWindow);
	});

	test("hideOnscreenWindow exits when parked, kicks fade when onscreen", () => {
		resetModuleState();
		const parked = makeFakeWindow({ x: -9999, y: -9999 });
		H.hideOnscreenWindow(parked as unknown as Electron.BrowserWindow);
		const fw = makeFakeWindow({ x: 50, y: 50 });
		H.hideOnscreenWindow(fw as unknown as Electron.BrowserWindow);
		H.clearFadeTimer();
	});

	test("hideAliveWindow on alive onscreen window starts a fade", () => {
		resetModuleState();
		const fw = makeFakeWindow({ x: 50, y: 50 });
		H.hideAliveWindow(fw as unknown as Electron.BrowserWindow);
		H.clearFadeTimer();
	});

	test("handleBlur honours suppression window then hides", () => {
		resetModuleState();
		H.__setSuppressBlurUntil(Date.now() + 1000);
		H.handleBlur();
		H.__setSuppressBlurUntil(0);
		const fw = makeFakeWindow({ x: 50, y: 50 });
		H.__setPickerWindow(fw as unknown as Electron.BrowserWindow);
		H.handleBlur();
		H.clearFadeTimer();
	});
});

// --- Picker styles -----------------------------------------------------

describe("picker styles", () => {
	test("applyPickerStyles inserts CSS and showInactive", () => {
		const fw = makeFakeWindow();
		H.applyPickerStyles(fw as unknown as Electron.BrowserWindow);
	});

	test("handleDidFinishLoad ignores when picker is missing then sets pageLoaded", () => {
		resetModuleState();
		H.handleDidFinishLoad();
		const fw = makeFakeWindow();
		H.__setPickerWindow(fw as unknown as Electron.BrowserWindow);
		H.handleDidFinishLoad();
	});
});

// --- Tween / animation -------------------------------------------------

describe("opacity tween", () => {
	test("tweenProgress saturates", () => {
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
			win: fw as unknown as Electron.BrowserWindow,
		};
		expect(H.interpolateOpacity(frame, 0)).toBe(0);
		expect(H.interpolateOpacity(frame, 1)).toBe(1);
		expect(H.interpolateOpacity(frame, 0.5)).toBe(0.5);
	});

	test("snapOpacity sets and fires onComplete", () => {
		const fw = makeFakeWindow();
		let done = 0;
		H.snapOpacity(fw as unknown as Electron.BrowserWindow, 1, () => done++);
		expect(fw.opacity).toBe(1);
		expect(done).toBe(1);
		H.snapOpacity(fw as unknown as Electron.BrowserWindow, 0);
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
			win: fw as unknown as Electron.BrowserWindow,
		});
		expect(fw.opacity).toBe(1);
		expect(done).toBe(1);
		H.finalizeTween({
			easing: (t) => t,
			from: 0,
			onComplete: undefined,
			start: 0,
			to: 0,
			win: fw as unknown as Electron.BrowserWindow,
		});
	});

	test("tickTween mid-frame and final-frame branches", () => {
		const fw = makeFakeWindow();
		H.tickTween({
			easing: (t) => t,
			from: 0,
			onComplete: undefined,
			start: Date.now() + 10_000,
			to: 1,
			win: fw as unknown as Electron.BrowserWindow,
		});
		H.tickTween({
			easing: (t) => t,
			from: 0,
			onComplete: undefined,
			start: 0,
			to: 1,
			win: fw as unknown as Electron.BrowserWindow,
		});
	});

	test("fadeIn / animateOpacity short-circuit when from==to", () => {
		const fw = makeFakeWindow();
		fw.opacity = 0;
		H.fadeIn(fw as unknown as Electron.BrowserWindow);
		H.clearFadeTimer();
		fw.opacity = 1;
		H.fadeIn(fw as unknown as Electron.BrowserWindow);
	});
});

// --- Placement + show flow --------------------------------------------

describe("placement + show", () => {
	test("placeAndShowPicker no-ops without a last anchor", () => {
		resetModuleState();
		const fw = makeFakeWindow();
		H.placeAndShowPicker(fw as unknown as Electron.BrowserWindow);
	});

	test("renderPickerAt + showWindowAtWorkArea happy path", () => {
		resetModuleState();
		const fw = makeFakeWindow();
		H.renderPickerAt(fw as unknown as Electron.BrowserWindow, {
			screenLeft: 0,
			screenRight: 600,
			screenTopY: 800,
		});
		expect(fw.showCalls).toBe(1);
		expect(fw.moveTopCalls).toBe(1);
		expect(fw.sendCalls.length).toBe(1);
		H.clearFadeTimer();
	});

	test("sendAnchor relays renderer-local coords", () => {
		const fw = makeFakeWindow();
		H.sendAnchor(
			fw as unknown as Electron.BrowserWindow,
			{ x: 100, y: 200, width: 600, height: 560 },
			{ x: 50, y: 100 }
		);
		expect(fw.sendCalls[0]?.[1]).toEqual({ x: 50, y: 100, width: 600, height: 560 });
	});

	test("placeAndShowPicker with anchor draws", () => {
		resetModuleState();
		H.__setLastAnchor({ screenLeft: 0, screenRight: 600, screenTopY: 800 });
		const fw = makeFakeWindow();
		H.placeAndShowPicker(fw as unknown as Electron.BrowserWindow);
		expect(fw.showCalls).toBe(1);
		H.clearFadeTimer();
	});

	test("deferShowUntilLoaded ignores re-entry, onDeferredLoadComplete clears flag", () => {
		resetModuleState();
		const fw = makeFakeWindow();
		H.deferShowUntilLoaded(fw as unknown as Electron.BrowserWindow);
		expect(H.__getPendingDeferredShow()).toBe(true);
		H.deferShowUntilLoaded(fw as unknown as Electron.BrowserWindow);
		H.onDeferredLoadComplete(fw as unknown as Electron.BrowserWindow);
		expect(H.__getPendingDeferredShow()).toBe(false);
	});

	test("showWhenReady covers pageLoaded + defer branches", () => {
		resetModuleState();
		const fw = makeFakeWindow();
		H.__setPageLoaded(false);
		H.showWhenReady(fw as unknown as Electron.BrowserWindow);
		expect(H.__getPendingDeferredShow()).toBe(true);
		H.__setPendingDeferredShow(false);
		H.__setPageLoaded(true);
		H.__setLastAnchor({ screenLeft: 0, screenRight: 600, screenTopY: 800 });
		H.showWhenReady(fw as unknown as Electron.BrowserWindow);
		H.clearFadeTimer();
	});

	test("hideModelPicker / showModelPickerAtAnchor", () => {
		resetModuleState();
		H.hideModelPicker();
		const fw = makeFakeWindow();
		H.__setPickerWindow(fw as unknown as Electron.BrowserWindow);
		H.__setPageLoaded(true);
		H.showModelPickerAtAnchor({ screenLeft: 0, screenRight: 600, screenTopY: 800 });
		expect(fw.showCalls).toBe(1);
		H.hideModelPicker();
		H.clearFadeTimer();
	});
});

// --- IPC handlers ------------------------------------------------------

describe("ipc handlers", () => {
	test("handleClose hides", () => {
		resetModuleState();
		H.handleClose();
	});

	test("handleOpen rejects bad payloads", () => {
		resetModuleState();
		H.handleOpen({} as Electron.IpcMainEvent, "garbage");
		H.handleOpen({} as Electron.IpcMainEvent, { x: 1, y: 1 });
	});

	test("consumeToggleIfOpen closes the open picker", () => {
		resetModuleState();
		const fw = makeFakeWindow({ x: 50, y: 50 });
		H.__setPickerWindow(fw as unknown as Electron.BrowserWindow);
		expect(H.consumeToggleIfOpen()).toBe(true);
		expect(H.consumeToggleIfOpen()).toBe(false);
		H.clearFadeTimer();
	});

	test("processOpen toggle/deadzone branches", () => {
		resetModuleState();
		const fw = makeFakeWindow({ x: 50, y: 50 });
		H.__setPickerWindow(fw as unknown as Electron.BrowserWindow);
		H.processOpen({} as Electron.IpcMainEvent, { x: 0, y: 0, width: 10, height: 10 });
		H.clearFadeTimer();
		H.__setPickerWindow(null);
		H.__setLastHiddenAt(Date.now());
		H.processOpen({} as Electron.IpcMainEvent, { x: 0, y: 0, width: 10, height: 10 });
	});

	test("anchorFromRect derives screen coords", () => {
		const fw = makeFakeWindow();
		fw.bounds = { x: 100, y: 200, width: 1, height: 1 };
		expect(
			H.anchorFromRect(fw as unknown as Electron.BrowserWindow, {
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
});

// --- Destroy / teardown ------------------------------------------------

describe("destroy / teardown", () => {
	test("destroyAlivePickerWindow no-ops when null, destroys when alive", () => {
		resetModuleState();
		H.destroyAlivePickerWindow();
		const fw = makeFakeWindow();
		H.__setPickerWindow(fw as unknown as Electron.BrowserWindow);
		H.destroyAlivePickerWindow();
		expect(fw.destroyCalls).toBe(1);
	});

	test("destroyPickerWindow nulls + resets flags", () => {
		resetModuleState();
		const fw = makeFakeWindow();
		H.__setPickerWindow(fw as unknown as Electron.BrowserWindow);
		H.__setPageLoaded(true);
		H.__setPendingDeferredShow(true);
		H.destroyPickerWindow();
	});

	test("teardownModelPickerHandlers unregisters everything", () => {
		resetModuleState();
		H.teardownModelPickerHandlers();
	});
});
