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

// --- Window aliveness ---------------------------------------------------
// Split into single-branch helpers so callers don't accumulate CC. The
// underlying truth: a "alive" window is non-null AND not destroyed.

function isNonNullWindow(win: BrowserWindow | null): win is BrowserWindow {
	return win !== null;
}

function isWindowAlive(win: BrowserWindow | null): win is BrowserWindow {
	return isNonNullWindow(win) && !win.isDestroyed();
}

// --- Fade timer ---------------------------------------------------------

function stopFadeInterval(): void {
	clearInterval(fadeTimer as ReturnType<typeof setInterval>);
}

function clearFadeTimer(): void {
	if (fadeTimer === null) {
		return;
	}
	stopFadeInterval();
	fadeTimer = null;
}

// --- Off-screen parking -------------------------------------------------

function moveOffscreen(win: BrowserWindow): void {
	win.setOpacity(0);
	win.setPosition(OFFSCREEN, OFFSCREEN);
}

function getWindowY(win: BrowserWindow): number {
	const [, y] = win.getPosition();
	return y as number;
}

function isParkedOffscreen(win: BrowserWindow): boolean {
	return getWindowY(win) === OFFSCREEN;
}

// --- Hide flow ----------------------------------------------------------

function markHidden(): void {
	lastHiddenAt = Date.now();
}

function beginFadeOut(win: BrowserWindow): void {
	markHidden();
	detachOpenerFocus();
	// The picker is gone — let the parent tray menu blur-hide normally again.
	setTrayMenuBlurSuppressed(false);
	animateOpacity(win, 0, easeInCubic, () => moveOffscreen(win));
}

function hideOnscreenWindow(win: BrowserWindow): void {
	if (isParkedOffscreen(win)) {
		return;
	}
	beginFadeOut(win);
}

function hideAliveWindow(win: BrowserWindow | null): void {
	if (!isWindowAlive(win)) {
		return;
	}
	hideOnscreenWindow(win);
}

// --- Blur / focus handling ---------------------------------------------

function isBlurSuppressed(): boolean {
	return Date.now() < suppressBlurUntil;
}

function handleBlur(): void {
	if (isBlurSuppressed()) {
		return;
	}
	hideAliveWindow(pickerWindow);
}

function handleOpenerFocus(): void {
	hideAliveWindow(pickerWindow);
}

// --- Geometry predicates ------------------------------------------------

function rectRight(b: Electron.Rectangle): number {
	return b.x + b.width;
}

function rectBottom(b: Electron.Rectangle): number {
	return b.y + b.height;
}

function withinHorizontal(x: number, b: Electron.Rectangle): boolean {
	return x >= b.x && x < rectRight(b);
}

function withinVertical(y: number, b: Electron.Rectangle): boolean {
	return y >= b.y && y < rectBottom(b);
}

function isPointInRect(x: number, y: number, b: Electron.Rectangle): boolean {
	return withinHorizontal(x, b) && withinVertical(y, b);
}

function isPickerNullOrDestroyed(): boolean {
	return !isWindowAlive(pickerWindow);
}

function isPointInsidePicker(x: number, y: number): boolean {
	if (isPickerNullOrDestroyed()) {
		return false;
	}
	// `pickerWindow` is alive per the guard above.
	return isPointInRect(x, y, (pickerWindow as BrowserWindow).getBounds());
}

function isInsideTrayMenu(x: number, y: number): boolean {
	const trayBounds = getTrayMenuBounds();
	if (trayBounds === null) {
		return false;
	}
	return isPointInRect(x, y, trayBounds);
}

// --- Global mouse-down (outside-click dismissal) -----------------------

function dismissTrayIfOutside(x: number, y: number): void {
	if (isInsideTrayMenu(x, y)) {
		return;
	}
	hideTrayMenu();
}

function handleOutsideClick(x: number, y: number): void {
	hideAliveWindow(pickerWindow);
	// Clicked the parent tray menu → just close the picker (acts like
	// stepping back to the parent menu). Clicked fully outside both → the
	// whole interaction is over, so dismiss the tray menu too.
	dismissTrayIfOutside(x, y);
}

function processGlobalCursor(): void {
	// uIOhook reports physical pixels; `getBounds()` is in DIP. Read the
	// cursor via `screen` so both sides share the DIP space (matters on
	// HiDPI / fractional display scaling).
	const { x, y } = screen.getCursorScreenPoint();
	if (isPointInsidePicker(x, y)) {
		return;
	}
	handleOutsideClick(x, y);
}

// A mouse press anywhere outside the picker dismisses it. The global OS
// hook — already running for hotkeys — sees every press regardless of
// focus, window activation, or drag regions, which the `focus`/`blur`,
// renderer-pointer, and `webContents` input-event signals all miss.
function handleGlobalMouseDown(): void {
	if (!isPickerVisible()) {
		return;
	}
	processGlobalCursor();
}

// --- Opener focus binding ----------------------------------------------

function detachOpenerListener(win: BrowserWindow): void {
	win.off("focus", handleOpenerFocus);
}

function detachOpenerFocus(): void {
	if (isWindowAlive(openerWin)) {
		detachOpenerListener(openerWin);
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

// --- Picker window setup -----------------------------------------------

const PICKER_CSS =
	"html, body { background: transparent !important; overflow: hidden !important; " +
	"height: 100% !important; width: 100% !important; margin: 0 !important; padding: 0 !important; }";

function applyPickerStyles(win: BrowserWindow): void {
	win.webContents.insertCSS(PICKER_CSS);
	win.showInactive();
}

function handleDidFinishLoad(): void {
	if (!isWindowAlive(pickerWindow)) {
		return;
	}
	applyPickerStyles(pickerWindow);
	pageLoaded = true;
}

function handleWillNavigate(event: Electron.Event, url: string): void {
	if (isAllowedRendererUrl(url)) {
		return;
	}
	event.preventDefault();
}

// biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op error handler
function ignoreOpenExternalError(): void {}

function openExternalSafely(url: string): void {
	shell.openExternal(url).catch(ignoreOpenExternalError);
}

function handleWindowOpen({ url }: { url: string }): { action: "deny" } {
	if (isHttpUrl(url)) {
		openExternalSafely(url);
	}
	return { action: "deny" };
}

function describeLoadError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function logPickerLoadError(error: unknown): void {
	dbg("device-picker", "Failed to load device picker window:", describeLoadError(error));
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

function instantiatePickerWindow(): BrowserWindow {
	pickerWindow = buildPickerWindow();
	attachPickerListeners(pickerWindow);
	return pickerWindow;
}

function createDevicePickerWindow(): BrowserWindow {
	if (isWindowAlive(pickerWindow)) {
		return pickerWindow;
	}
	return instantiatePickerWindow();
}

// --- Easing -------------------------------------------------------------

// Entrance: arrive fast, settle gently (ease-out). Exit: start gently,
// build momentum, then leave (ease-in). Both cubic so neither is the
// flagged "linear motion".
function easeOutCubic(t: number): number {
	return 1 - (1 - t) ** 3;
}
function easeInCubic(t: number): number {
	return t ** 3;
}

// --- Opacity tween ------------------------------------------------------

interface TweenFrame {
	easing: (t: number) => number;
	from: number;
	onComplete: (() => void) | undefined;
	start: number;
	to: number;
	win: BrowserWindow;
}

function tweenProgress(start: number): number {
	return Math.min(1, (Date.now() - start) / FADE_MS);
}

function interpolateOpacity(frame: TweenFrame, p: number): number {
	return frame.from + (frame.to - frame.from) * frame.easing(p);
}

function finalizeTween(frame: TweenFrame): void {
	frame.win.setOpacity(frame.to);
	clearFadeTimer();
	frame.onComplete?.();
}

function tickTween(frame: TweenFrame): void {
	const p = tweenProgress(frame.start);
	frame.win.setOpacity(interpolateOpacity(frame, p));
	if (p < 1) {
		return;
	}
	finalizeTween(frame);
}

function snapOpacity(win: BrowserWindow, to: number, onComplete?: () => void): void {
	win.setOpacity(to);
	onComplete?.();
}

function startTween(frame: TweenFrame): void {
	fadeTimer = setInterval(() => tickTween(frame), FADE_TICK_MS);
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
		snapOpacity(win, to, onComplete);
		return;
	}
	startTween({ easing, from, onComplete, start: Date.now(), to, win });
}

function fadeIn(win: BrowserWindow): void {
	animateOpacity(win, 1, easeOutCubic);
}

// --- Geometry / placement ----------------------------------------------

interface PickerBounds {
	height: number;
	width: number;
	x: number;
	y: number;
}

interface YAxisLayout {
	height: number;
	y: number;
}

function fitAbove(
	anchor: Anchor,
	desiredHeight: number,
	room: number,
	ceiling: number
): YAxisLayout {
	const height = Math.min(desiredHeight, room, ceiling);
	return { height, y: anchor.screenTopY - height - ANCHOR_GAP };
}

function pinToTop(desiredHeight: number, ceiling: number, workAreaY: number): YAxisLayout {
	return { height: Math.min(desiredHeight, ceiling), y: workAreaY };
}

function computeYAxis(
	anchor: Anchor,
	desiredHeight: number,
	workArea: { y: number; height: number }
): YAxisLayout {
	const room = anchor.screenTopY - workArea.y - ANCHOR_GAP;
	const ceiling = workArea.height - TASKBAR_MARGIN;
	if (room >= MIN_HEIGHT) {
		return fitAbove(anchor, desiredHeight, room, ceiling);
	}
	return pinToTop(desiredHeight, ceiling, workArea.y);
}

function computeXAxis(
	anchor: Anchor,
	width: number,
	workArea: { x: number; width: number }
): number {
	const desiredX = anchor.screenRight - width;
	const maxX = workArea.x + workArea.width - width;
	return Math.min(Math.max(desiredX, workArea.x), Math.max(workArea.x, maxX));
}

/**
 * Glue the picker's bottom edge `ANCHOR_GAP` above the row and right-align
 * it to the row's right edge. The height is shrunk to the room available
 * above the row so the window never crosses the screen top — when capped,
 * the bottom stays put and the picker scrolls internally. Everything is
 * then clamped into the display work area.
 */
function computePickerPosition(
	anchor: Anchor,
	size: { width: number; height: number },
	workArea: { x: number; y: number; width: number; height: number }
): PickerBounds {
	const width = Math.min(size.width, workArea.width);
	const { height, y } = computeYAxis(anchor, size.height, workArea);
	const x = computeXAxis(anchor, width, workArea);
	return { x, y: Math.max(y, workArea.y), width, height };
}

function showWindowAtBounds(win: BrowserWindow, bounds: PickerBounds): void {
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

function renderPickerAt(win: BrowserWindow, anchor: Anchor): void {
	const display = screen.getDisplayNearestPoint({
		x: anchor.screenLeft,
		y: anchor.screenTopY,
	});
	const bounds = computePickerPosition(anchor, desiredSize, display.workArea);
	showWindowAtBounds(win, bounds);
}

function placeAndShowPicker(win: BrowserWindow): void {
	if (lastAnchor === null) {
		return;
	}
	renderPickerAt(win, lastAnchor);
}

let pendingDeferredShow = false;

function onDeferredLoadComplete(win: BrowserWindow): void {
	pendingDeferredShow = false;
	placeAndShowPicker(win);
}

function deferShowUntilLoaded(win: BrowserWindow): void {
	if (pendingDeferredShow) {
		return;
	}
	pendingDeferredShow = true;
	win.webContents.once("did-finish-load", () => onDeferredLoadComplete(win));
}

function showWhenReady(win: BrowserWindow): void {
	if (pageLoaded) {
		placeAndShowPicker(win);
		return;
	}
	deferShowUntilLoaded(win);
}

function showDevicePickerAtAnchor(anchor: Anchor): void {
	lastAnchor = anchor;
	showWhenReady(createDevicePickerWindow());
}

function hideDevicePicker(): void {
	hideAliveWindow(pickerWindow);
	lastAnchor = null;
}

function isPickerVisible(): boolean {
	if (isPickerNullOrDestroyed()) {
		return false;
	}
	return !isParkedOffscreen(pickerWindow as BrowserWindow);
}

// --- Resize -------------------------------------------------------------

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

function isVisibleAlivePicker(): boolean {
	return isWindowAlive(pickerWindow) && isPickerVisible();
}

function reanchorIfVisible(): void {
	if (!isVisibleAlivePicker()) {
		return;
	}
	placeAndShowPicker(pickerWindow as BrowserWindow);
}

function applyResize(payload: { width: number; height: number }): void {
	const next = normalizeResizePayload(payload);
	if (sizeUnchanged(desiredSize, next)) {
		return;
	}
	desiredSize = next;
	reanchorIfVisible();
}

// --- Payload guards -----------------------------------------------------

interface OpenRect {
	height: number;
	width: number;
	x: number;
	y: number;
}

function hasNumericWH(r: Record<string, unknown>): boolean {
	return typeof r.width === "number" && typeof r.height === "number";
}

function hasNumericXY(r: Record<string, unknown>): boolean {
	return typeof r.x === "number" && typeof r.y === "number";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	if (value === null) {
		return false;
	}
	return typeof value === "object";
}

function isSizePayload(value: unknown): value is { width: number; height: number } {
	if (!isObjectRecord(value)) {
		return false;
	}
	return hasNumericWH(value);
}

function isOpenPayload(value: unknown): value is OpenRect {
	if (!isSizePayload(value)) {
		return false;
	}
	return hasNumericXY(value as Record<string, unknown>);
}

// --- Open / close handlers ---------------------------------------------

function isInToggleDeadzone(): boolean {
	return Date.now() - lastHiddenAt < TOGGLE_DEADZONE_MS;
}

function consumeToggleIfOpen(): boolean {
	if (!isPickerVisible()) {
		return false;
	}
	hideDevicePicker();
	return true;
}

function anchorFromRect(senderWin: BrowserWindow, payload: OpenRect): Anchor {
	const b = senderWin.getBounds();
	const screenLeft = b.x + payload.x;
	return {
		screenLeft,
		screenRight: screenLeft + payload.width,
		screenTopY: b.y + payload.y,
	};
}

function openPickerFor(senderWin: BrowserWindow, payload: OpenRect): void {
	attachOpenerFocus(senderWin);
	showDevicePickerAtAnchor(anchorFromRect(senderWin, payload));
}

function tryOpenForSender(event: Electron.IpcMainEvent, payload: OpenRect): void {
	const senderWin = BrowserWindow.fromWebContents(event.sender);
	if (!isWindowAlive(senderWin)) {
		return;
	}
	openPickerFor(senderWin, payload);
}

function processOpen(event: Electron.IpcMainEvent, payload: OpenRect): void {
	// Row is a toggle. If the picker is up, this click closes it.
	if (consumeToggleIfOpen()) {
		return;
	}
	// If it was just hidden (the same click first blurred it away), swallow
	// the OPEN so it doesn't bounce straight back open.
	if (isInToggleDeadzone()) {
		return;
	}
	tryOpenForSender(event, payload);
}

function handleOpen(event: Electron.IpcMainEvent, payload: unknown): void {
	if (!isOpenPayload(payload)) {
		return;
	}
	processOpen(event, payload);
}

function handleResize(_event: Electron.IpcMainEvent, payload: unknown): void {
	if (!isSizePayload(payload)) {
		return;
	}
	applyResize(payload);
}

function handleClose(): void {
	// Renderer closes on device selection or Escape — the menu interaction
	// is finished, so dismiss the parent tray menu along with the picker
	// (mirrors a native submenu collapsing its whole menu on choose).
	hideDevicePicker();
	hideTrayMenu();
}

function destroyAlivePickerWindow(): void {
	if (!isWindowAlive(pickerWindow)) {
		return;
	}
	pickerWindow.destroy();
}

function destroyPickerWindow(): void {
	destroyAlivePickerWindow();
	pickerWindow = null;
	pageLoaded = false;
	pendingDeferredShow = false;
}

function teardownDevicePickerHandlers(): void {
	ipcMain.off("device-picker:open", handleOpen);
	ipcMain.off("device-picker:resize", handleResize);
	ipcMain.off("device-picker:close", handleClose);
	detachOpenerFocus();
	setTrayMenuBlurSuppressed(false);
	clearFadeTimer();
	destroyPickerWindow();
}

export function setupDevicePickerHandlers(): () => void {
	// Pre-create so the route is loaded before the first row click.
	createDevicePickerWindow();

	ipcMain.on("device-picker:open", handleOpen);
	ipcMain.on("device-picker:resize", handleResize);
	ipcMain.on("device-picker:close", handleClose);

	return teardownDevicePickerHandlers;
}

// Setters used by tests to drive internal state without mocking the
// underlying BrowserWindow / uIOhook surface. Keeping them on the test
// helper object (instead of as exports) avoids any production surface area.
function __setPickerWindow(win: BrowserWindow | null): void {
	pickerWindow = win;
}

function __setLastAnchor(anchor: Anchor | null): void {
	lastAnchor = anchor;
}

function __setPageLoaded(v: boolean): void {
	pageLoaded = v;
}

function __setPendingDeferredShow(v: boolean): void {
	pendingDeferredShow = v;
}

function __setFadeTimer(t: ReturnType<typeof setInterval> | null): void {
	fadeTimer = t;
}

function __setDesiredSize(s: { width: number; height: number }): void {
	desiredSize = s;
}

function __setLastHiddenAt(ts: number): void {
	lastHiddenAt = ts;
}

function __setSuppressBlurUntil(ts: number): void {
	suppressBlurUntil = ts;
}

function __setOpenerWin(win: BrowserWindow | null): void {
	openerWin = win;
}

function __getFadeTimer(): ReturnType<typeof setInterval> | null {
	return fadeTimer;
}

function __getPendingDeferredShow(): boolean {
	return pendingDeferredShow;
}

export const __device_picker_window_test_helpers__ = {
	isWindowAlive,
	isNonNullWindow,
	clearFadeTimer,
	stopFadeInterval,
	moveOffscreen,
	isParkedOffscreen,
	getWindowY,
	hideAliveWindow,
	hideOnscreenWindow,
	beginFadeOut,
	markHidden,
	isBlurSuppressed,
	handleBlur,
	handleOpenerFocus,
	isHttpUrl,
	isSameOrigin,
	handleWindowOpen,
	openExternalSafely,
	ignoreOpenExternalError,
	describeLoadError,
	rectRight,
	rectBottom,
	withinHorizontal,
	withinVertical,
	isPointInRect,
	isPointInsidePicker,
	isPickerNullOrDestroyed,
	isInsideTrayMenu,
	dismissTrayIfOutside,
	handleOutsideClick,
	processGlobalCursor,
	handleGlobalMouseDown,
	detachOpenerFocus,
	detachOpenerListener,
	attachOpenerFocus,
	applyPickerStyles,
	handleDidFinishLoad,
	computePickerPosition,
	computeXAxis,
	computeYAxis,
	fitAbove,
	pinToTop,
	easeOutCubic,
	easeInCubic,
	tweenProgress,
	interpolateOpacity,
	finalizeTween,
	tickTween,
	snapOpacity,
	fadeIn,
	normalizeResizePayload,
	sizeUnchanged,
	isVisibleAlivePicker,
	reanchorIfVisible,
	handleWillNavigate,
	logPickerLoadError,
	isPickerVisible,
	applyResize,
	handleResize,
	handleClose,
	handleOpen,
	processOpen,
	tryOpenForSender,
	openPickerFor,
	anchorFromRect,
	consumeToggleIfOpen,
	isInToggleDeadzone,
	isObjectRecord,
	isSizePayload,
	isOpenPayload,
	hasNumericWH,
	hasNumericXY,
	hideDevicePicker,
	showDevicePickerAtAnchor,
	showWhenReady,
	deferShowUntilLoaded,
	onDeferredLoadComplete,
	placeAndShowPicker,
	renderPickerAt,
	showWindowAtBounds,
	destroyPickerWindow,
	destroyAlivePickerWindow,
	teardownDevicePickerHandlers,
	__setPickerWindow,
	__setLastAnchor,
	__setPageLoaded,
	__setPendingDeferredShow,
	__setFadeTimer,
	__setDesiredSize,
	__setLastHiddenAt,
	__setSuppressBlurUntil,
	__setOpenerWin,
	__getFadeTimer,
	__getPendingDeferredShow,
};
