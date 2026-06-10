import { readFile } from "node:fs/promises";
import path from "node:path";
import { app, ipcMain } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";
import { dbg } from "../lib/debug-log";

interface AppInfo {
	copyright: string;
	electronVersion: string;
	nodeVersion: string;
	version: string;
}

const COPYRIGHT = "© 2024-2026 WinSTT contributors";

function resolveBundledTextFile(filename: string): string {
	if (app.isPackaged) {
		return path.join(process.resourcesPath, filename);
	}
	// Dev: import.meta.dirname is `<repo>/frontend/dist-electron/`; the file
	// lives at the repo root, two levels up.
	return path.join(import.meta.dirname, "..", "..", filename);
}

async function readBundledText(filename: string): Promise<string> {
	const file = resolveBundledTextFile(filename);
	try {
		return await readFile(file, "utf8");
	} catch (err) {
		dbg("about", `failed to read ${filename}:`, err instanceof Error ? err.message : String(err));
		return `${filename} is not available in this build.`;
	}
}

function buildAppInfo(): AppInfo {
	return {
		version: app.getVersion(),
		electronVersion: process.versions.electron ?? "unknown",
		nodeVersion: process.versions.node ?? "unknown",
		copyright: COPYRIGHT,
	};
}

export function setupAboutHandlers(): () => void {
	ipcMain.removeHandler(IPC.ABOUT_GET_LICENSE);
	ipcMain.removeHandler(IPC.ABOUT_GET_NOTICES);
	ipcMain.removeHandler(IPC.ABOUT_GET_APP_INFO);
	ipcMain.handle(IPC.ABOUT_GET_LICENSE, () => readBundledText("LICENSE"));
	ipcMain.handle(IPC.ABOUT_GET_NOTICES, () => readBundledText("THIRD_PARTY_NOTICES.md"));
	ipcMain.handle(IPC.ABOUT_GET_APP_INFO, () => buildAppInfo());
	return () => {
		ipcMain.removeHandler(IPC.ABOUT_GET_LICENSE);
		ipcMain.removeHandler(IPC.ABOUT_GET_NOTICES);
		ipcMain.removeHandler(IPC.ABOUT_GET_APP_INFO);
	};
}
