import path from "node:path";
import { BrowserWindow, ipcMain, screen, shell } from "electron";
import { dbg } from "../lib/debug-log";

// Detached, frameless window that hosts the full STT model picker. The main
// window is only 420×150, and Electron clips DOM at the OS window edge — so
// the rich picker (search / family rail / per-row quantization) physically
// can't be shown inside it. This window escapes those bounds: it renders the
// `/model-picker` route, sizes itself to the picker's reported content size,
// and anchors just above the footer chip that opened it. Mirrors the proven
// tray-menu-window mechanism.

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

function getRendererBaseUrl(): string {
	return process.env.WINSTT_RENDERER_BASE_URL ?? "http://localhost:3000";
}

function getRendererRouteUrl(route: string): string {
	const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
	return new URL(normalizedRoute, `${getRendererBaseUrl()}/`).toString();
}

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
	// Already parked (or mid fade-out): nothing to do, and don't reset the
	// toggle timestamp — otherwise a stray blur would extend the dead-zone.
	const [, posY] = win.getPosition();
	if (posY === OFFSCREEN) {
		return;
	}
	lastHiddenAt = Date.now();
	// Ease-in fade-out, THEN park it off-screen — the close mirrors the
	// open instead of vanishing instantly.
	animateOpacity(win, 0, easeInCubic, () => moveOffscreen(win));
}

function handleBlur(): void {
	if (Date.now() < suppressBlurUntil) {
		return;
	}
	hideAliveWindow(pickerWindow);
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

function isSameOrigin(url: string, baseUrl: string): boolean {
	try {
		return new URL(url).origin === new URL(baseUrl).origin;
	} catch {
		return false;
	}
}

function handleWillNavigate(event: Electron.Event, url: string): void {
	if (isSameOrigin(url, getRendererBaseUrl())) {
		return;
	}
	event.preventDefault();
}

function isHttpUrl(url: string): boolean {
	return url.startsWith("https://") || url.startsWith("http://");
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
		"model-picker",
		"Failed to load model picker window:",
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
	win.loadURL(getRendererRouteUrl("/model-picker")).catch(logPickerLoadError);
	win.on("blur", handleBlur);
}

export function createModelPickerWindow(): BrowserWindow {
	if (isWindowAlive(pickerWindow)) {
		return pickerWindow;
	}
	pickerWindow = buildPickerWindow();
	attachPickerListeners(pickerWindow);
	return pickerWindow;
}

// Entrance: arrive fast, settle gently (ease-out). Exit: start gently,
// build momentum, then leave (ease-in). Both are cubic so neither fade is
// the flagged "linear motion".
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
	const room = anchor.screenTopY - workArea.y - ANCHOR_GAP;
	const ceiling = workArea.height - TASKBAR_MARGIN;
	let height: number;
	let y: number;
	if (room >= MIN_HEIGHT) {
		// Enough space above: keep the bottom glued to the chip, shrink the
		// top down to the screen edge if the full height won't fit.
		height = Math.min(size.height, room, ceiling);
		y = anchor.screenTopY - height - ANCHOR_GAP;
	} else {
		// Chip is basically flush with the screen top — there's nowhere to
		// put a usable panel above it. Pin to the top edge (never above it)
		// and accept overlapping the chip as the last resort.
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
	win.setOpacity(0);
	win.setBounds(bounds);
	win.show();
	win.setAlwaysOnTop(true);
	win.moveTop();
	suppressBlurUntil = Date.now() + BLUR_GUARD_MS;
	fadeIn(win);
	win.focus();
}

function deferShowUntilLoaded(win: BrowserWindow): void {
	win.webContents.once("did-finish-load", () => {
		placeAndShowPicker(win);
	});
}

export function showModelPickerAtAnchor(anchor: Anchor): void {
	lastAnchor = anchor;
	const win = createModelPickerWindow();
	if (!pageLoaded) {
		deferShowUntilLoaded(win);
		return;
	}
	placeAndShowPicker(win);
}

export function hideModelPicker(): void {
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
	// Re-anchor so the (re-sized) picker stays glued above the chip; if it's
	// not on screen yet the new desiredSize is just used on the next open.
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

function isOpenPayload(value: unknown): value is OpenRect {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const r = value as Record<string, unknown>;
	return (
		typeof r.x === "number" &&
		typeof r.y === "number" &&
		typeof r.width === "number" &&
		typeof r.height === "number"
	);
}

function handleOpen(event: Electron.IpcMainEvent, payload: unknown): void {
	if (!isOpenPayload(payload)) {
		return;
	}
	// Chip is a toggle. If the picker is up, this click closes it. If it was
	// just hidden (the same click first blurred it away), swallow the OPEN so
	// it doesn't bounce straight back open.
	if (isPickerVisible()) {
		hideModelPicker();
		return;
	}
	if (Date.now() - lastHiddenAt < TOGGLE_DEADZONE_MS) {
		return;
	}
	// Payload is the chip's rect in renderer viewport coords. Convert to
	// screen space via the requesting window's bounds.
	const senderWin = BrowserWindow.fromWebContents(event.sender);
	if (!isWindowAlive(senderWin)) {
		return;
	}
	const b = senderWin.getBounds();
	const screenLeft = b.x + payload.x;
	showModelPickerAtAnchor({
		screenLeft,
		screenRight: screenLeft + payload.width,
		screenTopY: b.y + payload.y,
	});
}

function handleResize(_event: Electron.IpcMainEvent, payload: unknown): void {
	if (
		typeof payload !== "object" ||
		payload === null ||
		typeof (payload as { width: unknown }).width !== "number" ||
		typeof (payload as { height: unknown }).height !== "number"
	) {
		return;
	}
	applyResize(payload as { width: number; height: number });
}

function handleClose(): void {
	hideModelPicker();
}

function destroyPickerWindow(): void {
	if (isWindowAlive(pickerWindow)) {
		pickerWindow.destroy();
	}
	pickerWindow = null;
	pageLoaded = false;
}

export function setupModelPickerHandlers(): () => void {
	// Pre-create so the route is loaded before the first chip click.
	createModelPickerWindow();

	ipcMain.on("model-picker:open", handleOpen);
	ipcMain.on("model-picker:resize", handleResize);
	ipcMain.on("model-picker:close", handleClose);

	return () => {
		ipcMain.off("model-picker:open", handleOpen);
		ipcMain.off("model-picker:resize", handleResize);
		ipcMain.off("model-picker:close", handleClose);
		clearFadeTimer();
		destroyPickerWindow();
	};
}

export const __model_picker_window_test_helpers__ = {
	isWindowAlive,
	clearFadeTimer,
	moveOffscreen,
	hideAliveWindow,
	isSameOrigin,
	isHttpUrl,
	handleWindowOpen,
	computePickerPosition,
	easeOutCubic,
	easeInCubic,
	normalizeResizePayload,
	sizeUnchanged,
	getRendererBaseUrl,
	getRendererRouteUrl,
	handleWillNavigate,
	logPickerLoadError,
	isPickerVisible,
	applyResize,
	handleResize,
	isOpenPayload,
	destroyPickerWindow,
};
