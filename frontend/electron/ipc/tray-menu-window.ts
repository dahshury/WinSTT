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

export function createTrayMenuWindow(): BrowserWindow {
	if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
		return trayMenuWindow;
	}

	trayMenuWindow = new BrowserWindow({
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

	// Protect against navigation to untrusted origins
	trayMenuWindow.webContents.on("will-navigate", (event, url) => {
		try {
			const urlOrigin = new URL(url).origin;
			const baseOrigin = new URL(getRendererBaseUrl()).origin;
			if (urlOrigin === baseOrigin) {
				return;
			}
		} catch {
			// Invalid URL — block
		}
		event.preventDefault();
	});

	trayMenuWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("https://") || url.startsWith("http://")) {
			// biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op error handler
			shell.openExternal(url).catch(() => {});
		}
		return { action: "deny" };
	});

	trayMenuWindow.webContents.once("did-finish-load", () => {
		trayMenuWindow?.webContents.insertCSS(
			"html, body { background: transparent !important; overflow: hidden !important; " +
				"height: 100% !important; width: 100% !important; margin: 0 !important; padding: 0 !important; } " +
				"body { display: flex !important; align-items: flex-end !important; }"
		);
		// Show the window offscreen so it's ready — avoids OS show/hide animations later
		trayMenuWindow?.showInactive();
		pageLoaded = true;
	});

	// Load the tray menu page from the renderer server.
	trayMenuWindow.loadURL(getRendererRouteUrl("/tray-menu")).catch((error) => {
		dbg(
			"tray-menu",
			"Failed to load tray menu window:",
			error instanceof Error ? error.message : String(error)
		);
	});

	// When the menu loses focus, move it offscreen
	trayMenuWindow.on("blur", () => {
		if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
			if (fadeTimer) {
				clearInterval(fadeTimer);
			}
			trayMenuWindow.setOpacity(0);
			trayMenuWindow.setPosition(OFFSCREEN, OFFSCREEN);
		}
	});

	return trayMenuWindow;
}

function fadeIn(win: BrowserWindow): void {
	if (fadeTimer) {
		clearInterval(fadeTimer);
	}
	let opacity = 0;
	win.setOpacity(0);
	fadeTimer = setInterval(() => {
		opacity = Math.min(1, opacity + 0.125);
		win.setOpacity(opacity);
		if (opacity >= 1) {
			if (fadeTimer) {
				clearInterval(fadeTimer);
			}
			fadeTimer = null;
		}
	}, 10);
}

export function showTrayMenuAt(x: number, y: number): void {
	const menu = createTrayMenuWindow();

	if (!pageLoaded) {
		menu.webContents.once("did-finish-load", () => {
			showTrayMenuAt(x, y);
		});
		return;
	}

	const menuBounds = menu.getBounds();

	// Get the display where the cursor is
	const display = screen.getDisplayNearestPoint({ x, y });
	const { workArea } = display;

	let menuX = x;
	let menuY = y;

	// Adjust if menu would go off right edge
	if (menuX + menuBounds.width > workArea.x + workArea.width) {
		menuX = workArea.x + workArea.width - menuBounds.width;
	}

	// Adjust if menu would go off bottom edge (pushes it above the taskbar)
	if (menuY + menuBounds.height > workArea.y + workArea.height - TASKBAR_MARGIN) {
		menuY = workArea.y + workArea.height - menuBounds.height - TASKBAR_MARGIN;
	}

	// Adjust if menu would go off left edge
	if (menuX < workArea.x) {
		menuX = workArea.x;
	}

	// Adjust if menu would go off top edge
	if (menuY < workArea.y) {
		menuY = workArea.y;
	}

	menu.setPosition(menuX, menuY);
	lastShownAt = { x, y };
	fadeIn(menu);
	menu.focus();
}

export function hideTrayMenu(): void {
	if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
		if (fadeTimer) {
			clearInterval(fadeTimer);
		}
		trayMenuWindow.setOpacity(0);
		trayMenuWindow.setPosition(OFFSCREEN, OFFSCREEN);
	}
	lastShownAt = null;
}

function isMenuVisible(): boolean {
	if (!trayMenuWindow || trayMenuWindow.isDestroyed()) {
		return false;
	}
	const [, posY] = trayMenuWindow.getPosition();
	return posY !== OFFSCREEN;
}

export function setupTrayMenuHandlers(): () => void {
	// Pre-create the window so it's loaded before the first right-click
	createTrayMenuWindow();

	const closeHandler = () => {
		hideTrayMenu();
	};

	const resizeHandler = (
		_event: Electron.IpcMainEvent,
		payload: { width: number; height: number }
	) => {
		if (!trayMenuWindow || trayMenuWindow.isDestroyed()) {
			return;
		}
		const width = Math.max(1, Math.ceil(payload.width));
		const height = Math.max(1, Math.ceil(payload.height));
		const current = trayMenuWindow.getBounds();
		if (current.width === width && current.height === height) {
			return;
		}
		trayMenuWindow.setSize(width, height);
		// If the menu is currently shown, re-apply positioning so the
		// new size is anchored correctly to the original cursor point.
		if (isMenuVisible() && lastShownAt) {
			showTrayMenuAt(lastShownAt.x, lastShownAt.y);
		}
	};

	ipcMain.on("tray-menu:close", closeHandler);
	ipcMain.on("tray-menu:resize", resizeHandler);

	return () => {
		ipcMain.off("tray-menu:close", closeHandler);
		ipcMain.off("tray-menu:resize", resizeHandler);
		if (fadeTimer) {
			clearInterval(fadeTimer);
		}
		if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
			trayMenuWindow.destroy();
		}
		trayMenuWindow = null;
		pageLoaded = false;
	};
}
