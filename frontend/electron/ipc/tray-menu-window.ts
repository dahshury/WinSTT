import path from "node:path";
import { BrowserWindow, ipcMain, screen } from "electron";

let trayMenuWindow: BrowserWindow | null = null;
const isDev = process.env.NODE_ENV !== "production";

export function createTrayMenuWindow(): BrowserWindow {
	if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
		return trayMenuWindow;
	}

	trayMenuWindow = new BrowserWindow({
		width: 196, // Matches content width (190px + padding)
		height: 188, // Tight fit for compact menu
		frame: false,
		transparent: true,
		resizable: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		show: false,
		webPreferences: {
			preload: path.join(import.meta.dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	// Load the tray menu page
	if (isDev) {
		trayMenuWindow.loadURL("http://localhost:3000/tray-menu");
	} else {
		trayMenuWindow.loadFile(path.join(import.meta.dirname, "../out/tray-menu.html"));
	}

	// Hide menu when it loses focus
	trayMenuWindow.on("blur", () => {
		if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
			trayMenuWindow.hide();
		}
	});

	return trayMenuWindow;
}

export function showTrayMenuAt(x: number, y: number): void {
	const menu = createTrayMenuWindow();

	// Get the display where the cursor is
	const cursorPoint = { x, y };
	const display = screen.getDisplayNearestPoint(cursorPoint);
	const { workArea } = display;

	// Position menu at cursor, but ensure it stays within screen bounds
	const menuBounds = menu.getBounds();
	let menuX = x;
	let menuY = y;

	// Adjust if menu would go off right edge
	if (menuX + menuBounds.width > workArea.x + workArea.width) {
		menuX = workArea.x + workArea.width - menuBounds.width;
	}

	// Adjust if menu would go off bottom edge
	if (menuY + menuBounds.height > workArea.y + workArea.height) {
		menuY = workArea.y + workArea.height - menuBounds.height;
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
	menu.show();
	menu.focus();
}

export function hideTrayMenu(): void {
	if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
		trayMenuWindow.hide();
	}
}

export function setupTrayMenuHandlers(): () => void {
	// Handle close tray menu request from renderer
	const closeHandler = () => {
		hideTrayMenu();
	};

	ipcMain.on("tray-menu:close", closeHandler);

	return () => {
		ipcMain.off("tray-menu:close", closeHandler);
		if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
			trayMenuWindow.destroy();
		}
		trayMenuWindow = null;
	};
}
