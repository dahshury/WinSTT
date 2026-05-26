import { mkdir } from "node:fs/promises";
import path from "node:path";
import { app, ipcMain, shell } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";
import { dbg } from "../lib/debug-log";
import { breadcrumb } from "../lib/sentry-main";

/**
 * Resolve the per-user custom-models directory.
 *
 * Mirrors the path the Python server scans (passed via `--custom-models-dir`
 * in `stt-process.ts::applyCustomModelsDirFlag`) so both sides agree on the
 * same absolute path without re-deriving it twice.
 */
function getCustomModelsFolder(): string {
	return path.join(app.getPath("userData"), "models", "custom");
}

interface OpenFolderResult {
	error?: string;
	ok: boolean;
	path?: string;
}

/**
 * Open the custom-models directory in the OS file manager. Creates the
 * folder first if it doesn't exist — the user just clicked the button, so
 * an empty folder is expected on a first run.
 */
async function handleOpenCustomModelsFolder(): Promise<OpenFolderResult> {
	const target = getCustomModelsFolder();
	dbg("custom-models", "Open custom models folder requested:", target);
	try {
		await mkdir(target, { recursive: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		dbg("custom-models", "mkdir failed:", message);
		breadcrumb("custom-models", "mkdir failed", { path: target, error: message }, "warning");
		return { ok: false, error: message };
	}
	const errMessage = await shell.openPath(target);
	if (errMessage) {
		dbg("custom-models", "shell.openPath failed:", errMessage);
		breadcrumb("custom-models", "openPath failed", { path: target, error: errMessage }, "warning");
		return { ok: false, error: errMessage };
	}
	return { ok: true, path: target };
}

export function setupCustomModelsHandlers(): () => void {
	ipcMain.removeHandler(IPC.CUSTOM_MODELS_OPEN_FOLDER);
	ipcMain.handle(IPC.CUSTOM_MODELS_OPEN_FOLDER, () => handleOpenCustomModelsFolder());
	return () => {
		ipcMain.removeHandler(IPC.CUSTOM_MODELS_OPEN_FOLDER);
	};
}

export const __custom_models_test_helpers__ = {
	getCustomModelsFolder,
	handleOpenCustomModelsFolder,
};
