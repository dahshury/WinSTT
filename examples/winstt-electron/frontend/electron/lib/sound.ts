import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { getStoreValue } from "./store";

// Stryker disable next-line StringLiteral: path segment strings join into the bundled splash path — only used at runtime
const DEFAULT_SOUND_PATH = path.join(import.meta.dirname, "..", "build", "splash.wav");

let win: BrowserWindow | null = null;

/** Allowed audio file extensions for custom recording sounds. */
const ALLOWED_SOUND_EXTENSIONS = new Set([".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac"]);

function getSoundPath(): string | null {
	const enabled = getStoreValue("general.recordingSound");
	if (!enabled) {
		return null;
	}
	const custom = getStoreValue("general.recordingSoundPath");
	// Stryker disable next-line ConditionalExpression,EqualityOperator: empty string also flows to default path via the extension check, so always-true variants are equivalent
	if (custom && custom.length > 0) {
		// Validate custom path: must have an allowed audio extension
		const ext = path.extname(custom).toLowerCase();
		if (!ALLOWED_SOUND_EXTENSIONS.has(ext)) {
			// Stryker disable next-line StringLiteral: console.warn message is informational only
			console.warn("[sound] Custom sound path rejected (bad extension):", ext);
			return DEFAULT_SOUND_PATH;
		}
		return custom;
	}
	return DEFAULT_SOUND_PATH;
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
		} catch (err) {
			// A missing / corrupt splash.wav (or a custom path that vanished)
			// must surface — a silent null leaves the renderer with no audio and
			// no clue why. Log before returning null.
			console.warn("[sound] Failed to read sound file:", soundPath, err);
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
