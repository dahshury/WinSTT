import fs from "node:fs";
import path from "node:path";
import { type BrowserWindow as BrowserWindowType, nativeImage, Tray } from "electron";
import { showTrayMenuAt } from "./tray-menu-window";

export function setupTray(win: BrowserWindowType): Tray {
	const preferredIconPath =
		process.platform === "win32"
			? path.join(import.meta.dirname, "..", "build", "icon.ico")
			: path.join(import.meta.dirname, "..", "build", "icon.png");
	const icon = fs.existsSync(preferredIconPath)
		? nativeImage.createFromPath(preferredIconPath)
		: nativeImage.createEmpty();
	const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);

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
