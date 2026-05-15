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
	return {
		title: typeof safe.title === "string" ? safe.title : "Select File",
		filters: Array.isArray(safe.filters) ? safe.filters : undefined,
	};
}

async function handleOpenFile(options: unknown): Promise<string | null> {
	const { title, filters } = normalizeOpenFileOptions(options);
	const result = await dialog.showOpenDialog({ title, filters, properties: ["openFile"] });
	// Stryker disable next-line ConditionalExpression: equivalent mutant — replacing `result.filePaths.length === 0` with `false` leaves the fall-through path returning `result.filePaths[0] ?? null`, and when filePaths is empty `undefined ?? null` is also `null`, so the observable return value is identical for the inputs that reach this branch.
	if (result.canceled || result.filePaths.length === 0) {
		return null;
	}
	return result.filePaths[0] ?? null;
}

export function setupDialogHandlers(): void {
	ipcMain.handle("dialog:open-file", (_event, options: unknown) => handleOpenFile(options));
}
