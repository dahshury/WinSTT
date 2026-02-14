import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { store } from "./store";

const DEFAULT_SOUND_PATH = path.join(import.meta.dirname, "..", "build", "splash.wav");

let win: BrowserWindow | null = null;

function getSoundPath(): string | null {
	const enabled = store.get("general.recordingSound") as boolean | undefined;
	if (enabled === false) {
		return null;
	}
	const custom = store.get("general.recordingSoundPath") as string | undefined;
	return custom && custom.length > 0 ? custom : DEFAULT_SOUND_PATH;
}

/**
 * Register the IPC handler that serves WAV data to the renderer.
 * The renderer calls `invoke("sound:get-data")` on mount, decodes the
 * buffer into an AudioBuffer, and plays it via Web Audio API when
 * `sound:play` fires — giving ~1-3ms playback latency instead of
 * the ~150ms PowerShell overhead.
 */
export function initSound(mainWindow: BrowserWindow): void {
	win = mainWindow;

	ipcMain.handle("sound:get-data", () => {
		const soundPath = getSoundPath();
		if (!soundPath) {
			return null;
		}
		try {
			return fs.readFileSync(soundPath);
		} catch {
			return null;
		}
	});
}

/** Tell the renderer to play the preloaded sound. */
export function playRecordingSound(): void {
	if (!win || win.isDestroyed()) {
		return;
	}
	if (!getSoundPath()) {
		return;
	}
	win.webContents.send("sound:play");
}

export function cleanupSound(): void {
	win = null;
	ipcMain.removeHandler("sound:get-data");
}
