import path from "node:path";
import { BrowserWindow, ipcMain, screen, shell } from "electron";
import { dbg } from "../lib/debug-log";
import {
	isAllowedRendererUrl,
	isHttpUrl,
	isSameOrigin,
	loadRendererPage,
} from "../lib/renderer-url";

// Detached, frameless window that hosts the full STT model picker. The main
// window is only 420×150, and Electron clips DOM at the OS window edge — so
// the rich picker (search / family rail / per-row quantization) physically
// can't be shown inside it.
//
// This is a **full-screen transparent backdrop window**: it fills the entire
// display work area, the visible panel is absolutely positioned inside it
// (anchored above the footer chip via the `model-picker:anchor` IPC), and
// everything else is a transparent click-to-dismiss backdrop. A click that
// isn't the panel — the visualizer, the dictation text, the desktop, another
// window — lands on the backdrop and closes it. That makes dismissal
// independent of OS focus, window activation, drag regions, and global hooks,
// all of which previously each missed some region.

let pickerWindow: BrowserWindow | null = null;
let pageLoaded = false;
let fadeTimer: ReturnType<typeof setInterval> | null = null;
const OFFSCREEN = -9999;
// Gap between the picker's bottom edge and the chip that opened it — matches
// the in-window combobox's `sideOffset`.
const ANCHOR_GAP = 6;
const TASKBAR_MARGIN = 8;
const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 560;
// Smallest usable picker height — only relevant in the degenerate case where
// the chip sits almost flush with the screen top.
const MIN_HEIGHT = 160;
// Focusing a freshly-shown frameless window can race with a trailing blur
// from the click that opened it (the chip lives in the main window). Ignore
// blur for a beat after showing so the picker doesn't insta-hide — which
// looked like "it only opens once". Short, so a deliberate re-click closes.
const BLUR_GUARD_MS = 160;
// Clicking the chip while the picker is open first blurs it (main window
// regains focus → picker hides), then the chip's OPEN ipc arrives. Without
// this, that trailing OPEN would immediately reopen what the click just
// closed. Ignore an OPEN that lands right after a hide so the chip toggles.
const TOGGLE_DEADZONE_MS = 250;
// Fade duration, shared by open and close so the pair reads as one motion
// (well under the 300ms ceiling for user-initiated animation). The window
// opacity is tweened in ~16ms ticks since the main process has no rAF.
const FADE_MS = 150;
const FADE_TICK_MS = 16;

interface Anchor {
	// Screen coords of the chip that opened the picker.
	screenLeft: number;
	screenRight: number;
	screenTopY: number;
}
let lastAnchor: Anchor | null = null;
// Renderer-reported desired footprint (one-shot). Main owns the final size:
// width is honored, height is capped to the room above the chip.
let desiredSize = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
let suppressBlurUntil = 0;
let lastHiddenAt = 0;

// --- Window aliveness ---------------------------------------------------

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
	// Ease-in fade-out, THEN park it off-screen — the close mirrors the
	// open instead of vanishing instantly.
	animateOpacity(win, 0, easeInCubic, () => moveOffscreen(win));
}

function hideOnscreenWindow(win: BrowserWindow): void {
	// Already parked (or mid fade-out): nothing to do, and don't reset the
	// toggle timestamp — otherwise a stray blur would extend the dead-zone.
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

// The renderer backdrop catches in-app clicks; blur only covers leaving to
// another app entirely (alt-tab) — a useful secondary close.
function handleBlur(): void {
	if (isBlurSuppressed()) {
		return;
	}
	hideAliveWindow(pickerWindow);
}

// --- Picker styles + load handlers -------------------------------------

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
	dbg("model-picker", "Failed to load model picker window:", describeLoadError(error));
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
	loadRendererPage(win, "model-picker").catch(logPickerLoadError);
	win.on("blur", handleBlur);
}

function instantiatePickerWindow(): BrowserWindow {
	pickerWindow = buildPickerWindow();
	attachPickerListeners(pickerWindow);
	return pickerWindow;
}

export function createModelPickerWindow(): BrowserWindow {
	if (isWindowAlive(pickerWindow)) {
		return pickerWindow;
	}
	return instantiatePickerWindow();
}

// --- Easing -------------------------------------------------------------

// Entrance: arrive fast, settle gently (ease-out). Exit: start gently,
// build momentum, then leave (ease-in). Both are cubic so neither fade is
// the flagged "linear motion".
export function easeOutCubic(t: number): number {
	return 1 - (1 - t) ** 3;
}
export function easeInCubic(t: number): number {
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
	// Enough space above: keep the bottom glued to the chip, shrink the
	// top down to the screen edge if the full height won't fit.
	const height = Math.min(desiredHeight, room, ceiling);
	return { height, y: anchor.screenTopY - height - ANCHOR_GAP };
}

function pinToTop(desiredHeight: number, ceiling: number, workAreaY: number): YAxisLayout {
	// Chip is basically flush with the screen top — there's nowhere to
	// put a usable panel above it. Pin to the top edge (never above it)
	// and accept overlapping the chip as the last resort.
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
 * Glue the picker's bottom edge `ANCHOR_GAP` above the chip and right-align
 * it to the chip's right edge. The height is shrunk to the room available
 * above the chip so the window never crosses the screen top — when capped,
 * the bottom stays put and the picker scrolls internally. Everything is then
 * clamped into the display work area.
 */
export function computePickerPosition(
	anchor: Anchor,
	size: { width: number; height: number },
	workArea: { x: number; y: number; width: number; height: number }
): PickerBounds {
	const width = Math.min(size.width, workArea.width);
	const { height, y } = computeYAxis(anchor, size.height, workArea);
	const x = computeXAxis(anchor, width, workArea);
	return { x, y: Math.max(y, workArea.y), width, height };
}

// Tell the renderer where to draw the panel inside the full-screen window.
// Coords are window-local (= screen coords minus the work-area origin, since
// the window IS the work area).
function sendAnchor(win: BrowserWindow, panel: PickerBounds, workArea: { x: number; y: number }) {
	win.webContents.send("model-picker:anchor", {
		x: panel.x - workArea.x,
		y: panel.y - workArea.y,
		width: panel.width,
		height: panel.height,
	});
}

function showWindowAtWorkArea(
	win: BrowserWindow,
	workArea: { x: number; y: number; width: number; height: number },
	panel: PickerBounds
): void {
	win.setOpacity(0);
	win.setBounds(workArea);
	sendAnchor(win, panel, workArea);
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
	const { workArea } = display;
	// The window fills the whole work area; the visible panel is positioned
	// within it by the renderer, everything else is a transparent backdrop.
	const panel = computePickerPosition(anchor, desiredSize, workArea);
	showWindowAtWorkArea(win, workArea, panel);
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
	// Repeated chip clicks before the route finishes loading must not stack
	// multiple did-finish-load callbacks (each would re-run the show). One
	// is enough — it reads the latest `lastAnchor` when it fires.
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

export function showModelPickerAtAnchor(anchor: Anchor): void {
	lastAnchor = anchor;
	showWhenReady(createModelPickerWindow());
}

export function hideModelPicker(): void {
	hideAliveWindow(pickerWindow);
	lastAnchor = null;
}

function isPickerNullOrDestroyed(): boolean {
	return !isWindowAlive(pickerWindow);
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
	// Re-anchor so the (re-sized) picker stays glued above the chip; if it's
	// not on screen yet the new desiredSize is just used on the next open.
	if (!isVisibleAlivePicker()) {
		return;
	}
	placeAndShowPicker(pickerWindow as BrowserWindow);
}

export function applyResize(payload: { width: number; height: number }): void {
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
	// Chip is a toggle. If the picker is up, this click closes it.
	hideModelPicker();
	return true;
}

function anchorFromRect(senderWin: BrowserWindow, payload: OpenRect): Anchor {
	// Payload is the chip's rect in renderer viewport coords. Convert to
	// screen space via the requesting window's bounds.
	const b = senderWin.getBounds();
	const screenLeft = b.x + payload.x;
	return {
		screenLeft,
		screenRight: screenLeft + payload.width,
		screenTopY: b.y + payload.y,
	};
}

function tryOpenForSender(event: Electron.IpcMainEvent, payload: OpenRect): void {
	const senderWin = BrowserWindow.fromWebContents(event.sender);
	if (!isWindowAlive(senderWin)) {
		return;
	}
	showModelPickerAtAnchor(anchorFromRect(senderWin, payload));
}

function processOpen(event: Electron.IpcMainEvent, payload: OpenRect): void {
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
	hideModelPicker();
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

function teardownModelPickerHandlers(): void {
	ipcMain.off("model-picker:open", handleOpen);
	ipcMain.off("model-picker:resize", handleResize);
	ipcMain.off("model-picker:close", handleClose);
	clearFadeTimer();
	destroyPickerWindow();
}

export function setupModelPickerHandlers(): () => void {
	// Pre-create so the route is loaded before the first chip click.
	createModelPickerWindow();

	ipcMain.on("model-picker:open", handleOpen);
	ipcMain.on("model-picker:resize", handleResize);
	ipcMain.on("model-picker:close", handleClose);

	return teardownModelPickerHandlers;
}

// Test-only setters to drive internal state without booting a real
// BrowserWindow. Mirrors the device-picker test surface.
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

function __getFadeTimer(): ReturnType<typeof setInterval> | null {
	return fadeTimer;
}

function __getPendingDeferredShow(): boolean {
	return pendingDeferredShow;
}

export const __model_picker_window_test_helpers__ = {
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
	isHttpUrl,
	isSameOrigin,
	handleWindowOpen,
	openExternalSafely,
	ignoreOpenExternalError,
	describeLoadError,
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
	isPickerNullOrDestroyed,
	isPickerVisible,
	applyResize,
	handleResize,
	handleClose,
	handleOpen,
	processOpen,
	tryOpenForSender,
	anchorFromRect,
	consumeToggleIfOpen,
	isInToggleDeadzone,
	isObjectRecord,
	isSizePayload,
	isOpenPayload,
	hasNumericWH,
	hasNumericXY,
	hideModelPicker,
	showModelPickerAtAnchor,
	showWhenReady,
	deferShowUntilLoaded,
	onDeferredLoadComplete,
	placeAndShowPicker,
	renderPickerAt,
	showWindowAtWorkArea,
	sendAnchor,
	destroyPickerWindow,
	destroyAlivePickerWindow,
	teardownModelPickerHandlers,
	__setPickerWindow,
	__setLastAnchor,
	__setPageLoaded,
	__setPendingDeferredShow,
	__setFadeTimer,
	__setDesiredSize,
	__setLastHiddenAt,
	__setSuppressBlurUntil,
	__getFadeTimer,
	__getPendingDeferredShow,
};
