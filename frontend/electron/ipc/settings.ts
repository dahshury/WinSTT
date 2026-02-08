import { BrowserWindow, ipcMain } from "electron";
import { store } from "../lib/store";

const ALLOWED_SETTINGS_KEYS = new Set([
	"model",
	"quality",
	"audio",
	"general",
	"hotkey",
	"dictionary",
	"snippets",
]);

export function setupSettingsHandlers() {
	ipcMain.handle("settings:load", () => {
		return store.store;
	});

	ipcMain.on("settings:save", (event, { settings }: { settings: Record<string, unknown> }) => {
		for (const [key, value] of Object.entries(settings)) {
			if (ALLOWED_SETTINGS_KEYS.has(key)) {
				store.set(key, value);
			}
		}

		// Forward updated settings to all OTHER windows so their stores stay in sync
		for (const win of BrowserWindow.getAllWindows()) {
			if (win.webContents.id !== event.sender.id) {
				win.webContents.send("settings:changed", { settings });
			}
		}
	});
}
