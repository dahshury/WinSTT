import path from "node:path";
import { BrowserWindow, ipcMain, screen, shell } from "electron";
import { dbg } from "../lib/debug-log";

let trayMenuWindow: BrowserWindow | null = null;
let pageLoaded = false;
let fadeTimer: ReturnType<typeof setInterval> | null = null;
let lastShownAt: { x: number; y: number } | null = null;
const OFFSCREEN = -9999;
// Visual gap above the taskbar. On Windows 11 the taskbar's rounded/translucent
// top edge extends a few pixels above the workArea boundary, so a flush
// menu visually overlaps the taskbar. Native context menus leave a small gap.
const TASKBAR_MARGIN = 8;

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
	clearFadeTimer();
	moveOffscreen(win);
}

function handleBlur(): void {
	hideAliveWindow(trayMenuWindow);
}

function applyTrayMenuStyles(win: BrowserWindow | null | undefined): void {
	win?.webContents.insertCSS(
		"html, body { background: transparent !important; overflow: hidden !important; " +
			"height: 100% !important; width: 100% !important; margin: 0 !important; padding: 0 !important; } " +
			"body { display: flex !important; align-items: flex-end !important; }"
	);
	// Show the window offscreen so it's ready — avoids OS show/hide animations later
	win?.showInactive();
}

function handleDidFinishLoad(): void {
	applyTrayMenuStyles(trayMenuWindow);
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

function logTrayMenuLoadError(error: unknown): void {
	dbg(
		"tray-menu",
		"Failed to load tray menu window:",
		error instanceof Error ? error.message : String(error)
	);
}

function buildTrayMenuWindow(): BrowserWindow {
	return new BrowserWindow({
		width: 260,
		height: 290,
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

function attachTrayMenuListeners(win: BrowserWindow): void {
	// Protect against navigation to untrusted origins
	win.webContents.on("will-navigate", handleWillNavigate);
	win.webContents.setWindowOpenHandler(handleWindowOpen);
	win.webContents.once("did-finish-load", handleDidFinishLoad);
	// Load the tray menu page from the renderer server.
	win.loadURL(getRendererRouteUrl("/tray-menu")).catch(logTrayMenuLoadError);
	// When the menu loses focus, move it offscreen
	win.on("blur", handleBlur);
}

export function createTrayMenuWindow(): BrowserWindow {
	if (isWindowAlive(trayMenuWindow)) {
		return trayMenuWindow;
	}
	trayMenuWindow = buildTrayMenuWindow();
	attachTrayMenuListeners(trayMenuWindow);
	return trayMenuWindow;
}

function stepFadeIn(win: BrowserWindow, opacity: number): number {
	const next = Math.min(1, opacity + 0.125);
	win.setOpacity(next);
	if (next >= 1) {
		clearFadeTimer();
	}
	return next;
}

function fadeIn(win: BrowserWindow): void {
	clearFadeTimer();
	let opacity = 0;
	win.setOpacity(0);
	fadeTimer = setInterval(() => {
		opacity = stepFadeIn(win, opacity);
	}, 10);
}

interface MenuPosition {
	x: number;
	y: number;
}

function clampToWorkArea(
	desired: MenuPosition,
	menuSize: { width: number; height: number },
	workArea: { x: number; y: number; width: number; height: number }
): MenuPosition {
	const maxX = workArea.x + workArea.width - menuSize.width;
	const maxY = workArea.y + workArea.height - menuSize.height - TASKBAR_MARGIN;
	const clampedX = Math.min(Math.max(desired.x, workArea.x), maxX);
	const clampedY = Math.min(Math.max(desired.y, workArea.y), maxY);
	return { x: clampedX, y: clampedY };
}

function deferShowUntilLoaded(menu: BrowserWindow, x: number, y: number): void {
	menu.webContents.once("did-finish-load", () => {
		showTrayMenuAt(x, y);
	});
}

function placeAndShowMenu(menu: BrowserWindow, x: number, y: number): void {
	const menuBounds = menu.getBounds();
	const display = screen.getDisplayNearestPoint({ x, y });
	const { x: menuX, y: menuY } = clampToWorkArea({ x, y }, menuBounds, display.workArea);
	menu.setPosition(menuX, menuY);
	lastShownAt = { x, y };
	fadeIn(menu);
	menu.focus();
}

export function showTrayMenuAt(x: number, y: number): void {
	const menu = createTrayMenuWindow();
	if (!pageLoaded) {
		deferShowUntilLoaded(menu, x, y);
		return;
	}
	placeAndShowMenu(menu, x, y);
}

export function hideTrayMenu(): void {
	hideAliveWindow(trayMenuWindow);
	lastShownAt = null;
}

function isMenuVisible(): boolean {
	if (!isWindowAlive(trayMenuWindow)) {
		return false;
	}
	const [, posY] = trayMenuWindow.getPosition();
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

function reanchorMenuIfVisible(): void {
	if (isMenuVisible() && lastShownAt) {
		showTrayMenuAt(lastShownAt.x, lastShownAt.y);
	}
}

function applyResize(win: BrowserWindow, payload: { width: number; height: number }): void {
	const next = normalizeResizePayload(payload);
	if (sizeUnchanged(win.getBounds(), next)) {
		return;
	}
	win.setSize(next.width, next.height);
	// If the menu is currently shown, re-apply positioning so the
	// new size is anchored correctly to the original cursor point.
	reanchorMenuIfVisible();
}

function handleResize(
	_event: Electron.IpcMainEvent,
	payload: { width: number; height: number }
): void {
	if (!isWindowAlive(trayMenuWindow)) {
		return;
	}
	applyResize(trayMenuWindow, payload);
}

function destroyTrayMenuWindow(): void {
	if (isWindowAlive(trayMenuWindow)) {
		trayMenuWindow.destroy();
	}
	trayMenuWindow = null;
	pageLoaded = false;
}

function teardownTrayMenu(closeHandler: () => void): void {
	ipcMain.off("tray-menu:close", closeHandler);
	ipcMain.off("tray-menu:resize", handleResize);
	clearFadeTimer();
	destroyTrayMenuWindow();
}

export function setupTrayMenuHandlers(): () => void {
	// Pre-create the window so it's loaded before the first right-click
	createTrayMenuWindow();

	const closeHandler = () => {
		hideTrayMenu();
	};

	ipcMain.on("tray-menu:close", closeHandler);
	ipcMain.on("tray-menu:resize", handleResize);

	return () => {
		teardownTrayMenu(closeHandler);
	};
}

export const __tray_menu_window_test_helpers__ = {
	isWindowAlive,
	clearFadeTimer,
	moveOffscreen,
	hideAliveWindow,
	isSameOrigin,
	isHttpUrl,
	handleWindowOpen,
	clampToWorkArea,
	stepFadeIn,
	normalizeResizePayload,
	sizeUnchanged,
};
