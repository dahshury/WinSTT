import fs from "node:fs";
import path from "node:path";
import {
	type BrowserWindow as BrowserWindowType,
	type NativeImage,
	nativeImage,
	Tray,
} from "electron";
import { showTrayMenuAt } from "./tray-menu-window";

function resolveIconFilename(): string {
	return process.platform === "win32" ? "icon.ico" : "icon.png";
}

function loadTrayIcon(): NativeImage {
	const iconPath = path.join(import.meta.dirname, "..", "build", resolveIconFilename());
	if (!fs.existsSync(iconPath)) {
		return nativeImage.createEmpty();
	}
	const icon = nativeImage.createFromPath(iconPath);
	return icon.isEmpty() ? nativeImage.createEmpty() : icon;
}

export function setupTray(win: BrowserWindowType): Tray {
	const tray = new Tray(loadTrayIcon());

	tray.setToolTip("WinSTT - Speech to Text");

	// Show main window on left click
	tray.on("click", () => {
		win.show();
	});

	// Show custom menu on right click
	tray.on("right-click", (_event, bounds) => {
		showTrayMenuAt(bounds.x, bounds.y + bounds.height);
	});

	return tray;
}
