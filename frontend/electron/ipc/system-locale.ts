import { app, ipcMain } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";

export function setupSystemLocaleHandler(): () => void {
	ipcMain.removeHandler(IPC.APP_GET_SYSTEM_LOCALE);
	ipcMain.handle(IPC.APP_GET_SYSTEM_LOCALE, () => app.getLocale());
	return () => {
		ipcMain.removeHandler(IPC.APP_GET_SYSTEM_LOCALE);
	};
}
