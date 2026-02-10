import { dialog, ipcMain } from "electron";

export function setupDialogHandlers() {
	ipcMain.handle(
		"dialog:open-file",
		async (_event, options: { filters?: Electron.FileFilter[]; title?: string }) => {
			const result = await dialog.showOpenDialog({
				title: options.title ?? "Select File",
				filters: options.filters,
				properties: ["openFile"],
			});
			if (result.canceled || result.filePaths.length === 0) {
				return null;
			}
			return result.filePaths[0];
		}
	);
}
