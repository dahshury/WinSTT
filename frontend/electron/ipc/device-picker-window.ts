import path from "node:path";
import { BrowserWindow, ipcMain, screen, shell } from "electron";
import { uIOhook } from "uiohook-napi";
import { dbg } from "../lib/debug-log";
import {
	isAllowedRendererUrl,
	isHttpUrl,
	isSameOrigin,
	loadRendererPage,
} from "../lib/renderer-url";
import { getTrayMenuBounds, hideTrayMenu, setTrayMenuBlurSuppressed } from "./tray-menu-window";

// Detached, frameless window that hosts the input-device picker. The tray
// menu is a tiny popup window; expanding the device list inline ballooned it
// and pushed it off the screen. This window escapes those bounds: it renders
// the `/device-picker` route, sizes itself to the list's reported content
// size, and anchors just above the mic row in the tray menu that opened it.
// Mirrors the proven model-picker-window mechanism.

let pickerWindow: BrowserWindow | null = null;
let pageLoaded = false;
let fadeTimer: ReturnType<typeof setInterval> | null = null;
const OFFSCREEN = -9999;
// Gap between the picker's bottom edge and the row that opened it.
const ANCHOR_GAP = 6;
const TASKBAR_MARGIN = 8;
const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 360;
// Smallest usable height — only relevant in the degenerate case where the
// row sits almost flush with the screen top.
const MIN_HEIGHT = 140;
// Focusing a freshly-shown frameless window can race with a trailing blur
// from the click that opened it (the row lives in the tray-menu window).
// Ignore blur for a beat after showing so the picker doesn't insta-hide.
const BLUR_GUARD_MS = 160;
// Clicking the row while the picker is open first blurs it, then the row's
// OPEN ipc arrives. Without this, that trailing OPEN would immediately
// reopen what the click just closed. Ignore an OPEN right after a hide.
const TOGGLE_DEADZONE_MS = 250;
// Fade duration, shared by open and close so the pair reads as one motion
// (well under the 300ms ceiling). Tweened in ~16ms ticks (no rAF in main).
const FADE_MS = 150;
const FADE_TICK_MS = 16;

interface Anchor {
	// Screen coords of the row that opened the picker.
	screenLeft: number;
	screenRight: number;
	screenTopY: number;
}
let lastAnchor: Anchor | null = null;
// The window that opened the picker (the tray-menu window). A mouse press
// anywhere in it means the user clicked outside the popup but inside the
// app — dismiss it.
let openerWin: BrowserWindow | null = null;
// Renderer-reported desired footprint (one-shot). Main owns the final size:
// width is honored, height is capped to the room above the row.
let desiredSize = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
let suppressBlurUntil = 0;
let lastHiddenAt = 0;

function isWindowAlive(win: BrowserWindow | null): win is BrowserWindow {
	return win !== null && !win.isDestroyed();
}

function clearFadeTimer(): void {
	if (fadeTimer) {
		clearInterval(fadeTimer);
	}
	fadeTimer = null;
}

function moveOffscreen(win: BrowserWindow): void {
	win.setOpacity(0);
	win.setPosition(OFFSCREEN, OFFSCREEN);
}

function hideAliveWindow(win: BrowserWindow | null): void {
	if (!isWindowAlive(win)) {
		return;
	}
	const [, posY] = win.getPosition();
	if (posY === OFFSCREEN) {
		return;
	}
	lastHiddenAt = Date.now();
	detachOpenerFocus();
	// The picker is gone — let the parent tray menu blur-hide normally again.
	setTrayMenuBlurSuppressed(false);
	animateOpacity(win, 0, easeInCubic, () => moveOffscreen(win));
}

function handleBlur(): void {
	if (Date.now() < suppressBlurUntil) {
		return;
	}
	hideAliveWindow(pickerWindow);
}

function handleOpenerFocus(): void {
	hideAliveWindow(pickerWindow);
}

function isPointInRect(x: number, y: number, b: Electron.Rectangle): boolean {
	return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
}

// True if the screen point falls within the picker window's current bounds.
function isPointInsidePicker(x: number, y: number): boolean {
	if (!isWindowAlive(pickerWindow)) {
		return false;
	}
	return isPointInRect(x, y, pickerWindow.getBounds());
}

// A mouse press anywhere outside the picker dismisses it. The global OS
// hook — already running for hotkeys — sees every press regardless of
// focus, window activation, or drag regions, which the `focus`/`blur`,
// renderer-pointer, and `webContents` input-event signals all miss.
function handleGlobalMouseDown(): void {
	if (!isPickerVisible()) {
		return;
	}
	// uIOhook reports physical pixels; `getBounds()` is in DIP. Read the
	// cursor via `screen` so both sides share the DIP space (matters on
	// HiDPI / fractional display scaling).
	const { x, y } = screen.getCursorScreenPoint();
	if (isPointInsidePicker(x, y)) {
		return;
	}
	hideAliveWindow(pickerWindow);
	// Clicked the parent tray menu → just close the picker (acts like
	// stepping back to the parent menu). Clicked fully outside both → the
	// whole interaction is over, so dismiss the tray menu too.
	const trayBounds = getTrayMenuBounds();
	if (!(trayBounds && isPointInRect(x, y, trayBounds))) {
		hideTrayMenu();
	}
}

function detachOpenerFocus(): void {
	if (openerWin && !openerWin.isDestroyed()) {
		openerWin.off("focus", handleOpenerFocus);
	}
	openerWin = null;
	uIOhook.off("mousedown", handleGlobalMouseDown);
}

function attachOpenerFocus(win: BrowserWindow): void {
	detachOpenerFocus();
	openerWin = win;
	win.on("focus", handleOpenerFocus);
	uIOhook.on("mousedown", handleGlobalMouseDown);
}

function applyPickerStyles(win: BrowserWindow | null | undefined): void {
	win?.webContents.insertCSS(
		"html, body { background: transparent !important; overflow: hidden !important; " +
			"height: 100% !important; width: 100% !important; margin: 0 !important; padding: 0 !important; }"
	);
	win?.showInactive();
}

function handleDidFinishLoad(): void {
	applyPickerStyles(pickerWindow);
	pageLoaded = true;
}

function handleWillNavigate(event: Electron.Event, url: string): void {
	if (isAllowedRendererUrl(url)) {
		return;
	}
	event.preventDefault();
}

function handleWindowOpen({ url }: { url: string }): { action: "deny" } {
	if (isHttpUrl(url)) {
		// biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op error handler
		shell.openExternal(url).catch(() => {});
	}
	return { action: "deny" };
}

function logPickerLoadError(error: unknown): void {
	dbg(
		"device-picker",
		"Failed to load device picker window:",
		error instanceof Error ? error.message : String(error)
	);
}

function buildPickerWindow(): BrowserWindow {
	return new BrowserWindow({
		width: DEFAULT_WIDTH,
		height: DEFAULT_HEIGHT,
		x: OFFSCREEN,
		y: OFFSCREEN,
		frame: false,
		transparent: true,
		resizable: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		show: false,
		opacity: 0,
		webPreferences: {
			preload: path.join(import.meta.dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
}

function attachPickerListeners(win: BrowserWindow): void {
	win.webContents.on("will-navigate", handleWillNavigate);
	win.webContents.setWindowOpenHandler(handleWindowOpen);
	win.webContents.once("did-finish-load", handleDidFinishLoad);
	loadRendererPage(win, "device-picker").catch(logPickerLoadError);
	win.on("blur", handleBlur);
}

export function createDevicePickerWindow(): BrowserWindow {
	if (isWindowAlive(pickerWindow)) {
		return pickerWindow;
	}
	pickerWindow = buildPickerWindow();
	attachPickerListeners(pickerWindow);
	return pickerWindow;
}

// Entrance: arrive fast, settle gently (ease-out). Exit: start gently,
// build momentum, then leave (ease-in). Both cubic so neither is the
// flagged "linear motion".
export function easeOutCubic(t: number): number {
	return 1 - (1 - t) ** 3;
}
export function easeInCubic(t: number): number {
	return t ** 3;
}

/** Time-based opacity tween with easing. Cancels any in-flight fade first,
 *  so a reopen mid-close (or vice-versa) picks up from the current opacity
 *  instead of snapping. `onComplete` only fires if the tween runs to the
 *  end — a superseding fade clears the timer and its callback never runs. */
function animateOpacity(
	win: BrowserWindow,
	to: number,
	easing: (t: number) => number,
	onComplete?: () => void
): void {
	clearFadeTimer();
	const from = win.getOpacity();
	if (from === to) {
		win.setOpacity(to);
		onComplete?.();
		return;
	}
	const start = Date.now();
	fadeTimer = setInterval(() => {
		const p = Math.min(1, (Date.now() - start) / FADE_MS);
		win.setOpacity(from + (to - from) * easing(p));
		if (p >= 1) {
			win.setOpacity(to);
			clearFadeTimer();
			onComplete?.();
		}
	}, FADE_TICK_MS);
}

function fadeIn(win: BrowserWindow): void {
	animateOpacity(win, 1, easeOutCubic);
}

interface PickerBounds {
	height: number;
	width: number;
	x: number;
	y: number;
}

/**
 * Glue the picker's bottom edge `ANCHOR_GAP` above the row and right-align
 * it to the row's right edge. The height is shrunk to the room available
 * above the row so the window never crosses the screen top — when capped,
 * the bottom stays put and the picker scrolls internally. Everything is
 * then clamped into the display work area.
 */
export function computePickerPosition(
	anchor: Anchor,
	size: { width: number; height: number },
	workArea: { x: number; y: number; width: number; height: number }
): PickerBounds {
	const width = Math.min(size.width, workArea.width);
	const room = anchor.screenTopY - workArea.y - ANCHOR_GAP;
	const ceiling = workArea.height - TASKBAR_MARGIN;
	let height: number;
	let y: number;
	if (room >= MIN_HEIGHT) {
		height = Math.min(size.height, room, ceiling);
		y = anchor.screenTopY - height - ANCHOR_GAP;
	} else {
		height = Math.min(size.height, ceiling);
		y = workArea.y;
	}
	const desiredX = anchor.screenRight - width;
	const maxX = workArea.x + workArea.width - width;
	const x = Math.min(Math.max(desiredX, workArea.x), Math.max(workArea.x, maxX));
	return { x, y: Math.max(y, workArea.y), width, height };
}

function placeAndShowPicker(win: BrowserWindow): void {
	if (!lastAnchor) {
		return;
	}
	const display = screen.getDisplayNearestPoint({
		x: lastAnchor.screenLeft,
		y: lastAnchor.screenTopY,
	});
	const bounds = computePickerPosition(lastAnchor, desiredSize, display.workArea);
	// Stealing focus for the picker would blur-hide the tray menu it opened
	// from; keep the parent visible behind/around this child popup.
	setTrayMenuBlurSuppressed(true);
	win.setOpacity(0);
	win.setBounds(bounds);
	win.show();
	win.setAlwaysOnTop(true);
	win.moveTop();
	suppressBlurUntil = Date.now() + BLUR_GUARD_MS;
	fadeIn(win);
	win.focus();
}

let pendingDeferredShow = false;

function deferShowUntilLoaded(win: BrowserWindow): void {
	if (pendingDeferredShow) {
		return;
	}
	pendingDeferredShow = true;
	win.webContents.once("did-finish-load", () => {
		pendingDeferredShow = false;
		placeAndShowPicker(win);
	});
}

export function showDevicePickerAtAnchor(anchor: Anchor): void {
	lastAnchor = anchor;
	const win = createDevicePickerWindow();
	if (!pageLoaded) {
		deferShowUntilLoaded(win);
		return;
	}
	placeAndShowPicker(win);
}

export function hideDevicePicker(): void {
	hideAliveWindow(pickerWindow);
	lastAnchor = null;
}

function isPickerVisible(): boolean {
	if (!isWindowAlive(pickerWindow)) {
		return false;
	}
	const [, posY] = pickerWindow.getPosition();
	return posY !== OFFSCREEN;
}

function normalizeResizePayload(payload: { width: number; height: number }): {
	width: number;
	height: number;
} {
	return {
		width: Math.max(1, Math.ceil(payload.width)),
		height: Math.max(1, Math.ceil(payload.height)),
	};
}

function sizeUnchanged(
	current: { width: number; height: number },
	next: { width: number; height: number }
): boolean {
	return current.width === next.width && current.height === next.height;
}

export function applyResize(payload: { width: number; height: number }): void {
	const next = normalizeResizePayload(payload);
	if (sizeUnchanged(desiredSize, next)) {
		return;
	}
	desiredSize = next;
	if (isWindowAlive(pickerWindow) && isPickerVisible()) {
		placeAndShowPicker(pickerWindow);
	}
}

interface OpenRect {
	height: number;
	width: number;
	x: number;
	y: number;
}

function isSizePayload(value: unknown): value is { width: number; height: number } {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const r = value as Record<string, unknown>;
	return typeof r.width === "number" && typeof r.height === "number";
}

function isOpenPayload(value: unknown): value is OpenRect {
	if (!isSizePayload(value)) {
		return false;
	}
	const r = value as Record<string, unknown>;
	return typeof r.x === "number" && typeof r.y === "number";
}

function handleOpen(event: Electron.IpcMainEvent, payload: unknown): void {
	if (!isOpenPayload(payload)) {
		return;
	}
	// Row is a toggle. If the picker is up, this click closes it. If it was
	// just hidden (the same click first blurred it away), swallow the OPEN
	// so it doesn't bounce straight back open.
	if (isPickerVisible()) {
		hideDevicePicker();
		return;
	}
	if (Date.now() - lastHiddenAt < TOGGLE_DEADZONE_MS) {
		return;
	}
	const senderWin = BrowserWindow.fromWebContents(event.sender);
	if (!isWindowAlive(senderWin)) {
		return;
	}
	const b = senderWin.getBounds();
	attachOpenerFocus(senderWin);
	const screenLeft = b.x + payload.x;
	showDevicePickerAtAnchor({
		screenLeft,
		screenRight: screenLeft + payload.width,
		screenTopY: b.y + payload.y,
	});
}

function handleResize(_event: Electron.IpcMainEvent, payload: unknown): void {
	if (isSizePayload(payload)) {
		applyResize(payload);
	}
}

function handleClose(): void {
	// Renderer closes on device selection or Escape — the menu interaction
	// is finished, so dismiss the parent tray menu along with the picker
	// (mirrors a native submenu collapsing its whole menu on choose).
	hideDevicePicker();
	hideTrayMenu();
}

function destroyPickerWindow(): void {
	if (isWindowAlive(pickerWindow)) {
		pickerWindow.destroy();
	}
	pickerWindow = null;
	pageLoaded = false;
	pendingDeferredShow = false;
}

export function setupDevicePickerHandlers(): () => void {
	// Pre-create so the route is loaded before the first row click.
	createDevicePickerWindow();

	ipcMain.on("device-picker:open", handleOpen);
	ipcMain.on("device-picker:resize", handleResize);
	ipcMain.on("device-picker:close", handleClose);

	return () => {
		ipcMain.off("device-picker:open", handleOpen);
		ipcMain.off("device-picker:resize", handleResize);
		ipcMain.off("device-picker:close", handleClose);
		detachOpenerFocus();
		setTrayMenuBlurSuppressed(false);
		clearFadeTimer();
		destroyPickerWindow();
	};
}

export const __device_picker_window_test_helpers__ = {
	isWindowAlive,
	clearFadeTimer,
	moveOffscreen,
	hideAliveWindow,
	isHttpUrl,
	isSameOrigin,
	handleWindowOpen,
	computePickerPosition,
	easeOutCubic,
	easeInCubic,
	normalizeResizePayload,
	sizeUnchanged,
	handleWillNavigate,
	logPickerLoadError,
	isPickerVisible,
	applyResize,
	handleResize,
	isOpenPayload,
	destroyPickerWindow,
};
