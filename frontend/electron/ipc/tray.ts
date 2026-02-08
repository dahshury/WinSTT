import path from "node:path";
import { app, type BrowserWindow, Menu, nativeImage, Tray } from "electron";

export function setupTray(win: BrowserWindow): Tray {
	const iconPath = path.join(import.meta.dirname, "..", "build", "icon.ico");
	const icon = nativeImage.createFromPath(iconPath);
	const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);

	const contextMenu = Menu.buildFromTemplate([
		{
			label: "Show",
			click: () => win.show(),
		},
		{
			label: "Quit",
			click: () => {
				app.quit();
			},
		},
	]);

	tray.setToolTip("WinSTT");
	tray.setContextMenu(contextMenu);

	tray.on("click", () => {
		win.show();
	});

	return tray;
}
