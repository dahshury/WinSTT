import { app, ipcMain } from "electron";

function supportsLoginItems(): boolean {
	return process.platform === "win32" || process.platform === "darwin";
}

function extractEnabled(payload: unknown): boolean | null {
	if (payload && typeof (payload as { enabled: unknown }).enabled === "boolean") {
		return (payload as { enabled: boolean }).enabled;
	}
	return null;
}

export function setupAutostartHandlers(): void {
	ipcMain.handle("autostart:get", () => {
		if (!supportsLoginItems()) {
			return false;
		}
		return app.getLoginItemSettings().openAtLogin;
	});

	ipcMain.on("autostart:set", (_event, payload: unknown) => {
		if (!supportsLoginItems()) {
			return;
		}
		const enabled = extractEnabled(payload);
		if (enabled === null) {
			return;
		}
		app.setLoginItemSettings({ openAtLogin: enabled });
	});
}
