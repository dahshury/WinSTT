import path from "node:path";
import { type BrowserWindow as BrowserWindowType, nativeImage, Tray } from "electron";
import { showTrayMenuAt } from "./tray-menu-window";

export function setupTray(win: BrowserWindowType): Tray {
	const iconPath = path.join(import.meta.dirname, "..", "build", "icon.ico");
	const icon = nativeImage.createFromPath(iconPath);
	const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);

	tray.setToolTip("WinSTT - Speech to Text");

	// Show main window on left click
	tray.on("click", () => {
		win.show();
	});

	// Show custom menu on right click
	tray.on("right-click", (_event, bounds) => {
		// Position menu at the bottom-left of the tray icon
		const x = bounds.x;
		const y = bounds.y + bounds.height;
		showTrayMenuAt(x, y);
	});

	return tray;
}
