import { dialog, ipcMain } from "electron";

interface OpenFileOptions {
	filters?: Electron.FileFilter[];
	title?: string;
}

function toSafeOptions(options: unknown): OpenFileOptions {
	return options !== null && typeof options === "object" ? (options as OpenFileOptions) : {};
}

function normalizeOpenFileOptions(options: unknown): {
	title: string;
	filters?: Electron.FileFilter[];
} {
	const safe = toSafeOptions(options);
	const title = typeof safe.title === "string" ? safe.title : "Select File";
	return Array.isArray(safe.filters) ? { title, filters: safe.filters } : { title };
}

async function handleOpenFile(options: unknown): Promise<string | null> {
	const normalized = normalizeOpenFileOptions(options);
	const result = await dialog.showOpenDialog({ ...normalized, properties: ["openFile"] });
	if (result.canceled) {
		return null;
	}
	// `filePaths[0]` is `string | undefined` under `noUncheckedIndexedAccess`;
	// coalesce so an empty `filePaths` (Electron returns `[]` when no file was
	// chosen even though `canceled === false` — observed on some Linux WMs and
	// when `dialog.showOpenDialog` is invoked without a parent window) collapses
	// to `null` instead of leaking `undefined` across the IPC boundary.
	return result.filePaths[0] ?? null;
}

export function setupDialogHandlers(): void {
	ipcMain.handle("dialog:open-file", (_event, options: unknown) => handleOpenFile(options));
}
