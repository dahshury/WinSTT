import { app, ipcMain } from "electron";

export function setupAutostartHandlers() {
	ipcMain.handle("autostart:get", () => {
		return app.getLoginItemSettings().openAtLogin;
	});

	ipcMain.on("autostart:set", (_event, { enabled }: { enabled: boolean }) => {
		app.setLoginItemSettings({ openAtLogin: enabled });
	});
}
