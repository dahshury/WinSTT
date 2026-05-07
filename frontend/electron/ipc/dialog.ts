import { dialog, ipcMain } from "electron";

export function setupDialogHandlers(): void {
	ipcMain.handle(
		"dialog:open-file",
		async (_event, options: { filters?: Electron.FileFilter[]; title?: string }) => {
			const safeOptions = options && typeof options === "object" ? options : {};
			const title = typeof safeOptions.title === "string" ? safeOptions.title : "Select File";
			const filters = Array.isArray(safeOptions.filters) ? safeOptions.filters : undefined;
			const result = await dialog.showOpenDialog({
				title,
				filters,
				properties: ["openFile"],
			});
			if (result.canceled || result.filePaths.length === 0) {
				return null;
			}
			return result.filePaths[0];
		}
	);
}
