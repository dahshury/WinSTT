import { app, ipcMain } from "electron";

function supportsLoginItems(): boolean {
	return process.platform === "win32" || process.platform === "darwin";
}

export function setupAutostartHandlers(): void {
	ipcMain.handle("autostart:get", () => {
		if (!supportsLoginItems()) {
			return false;
		}
		return app.getLoginItemSettings().openAtLogin;
	});

	ipcMain.on("autostart:set", (_event, payload: { enabled: boolean }) => {
		if (!supportsLoginItems()) {
			return;
		}
		if (!payload || typeof payload.enabled !== "boolean") {
			return;
		}
		app.setLoginItemSettings({ openAtLogin: payload.enabled });
	});
}
