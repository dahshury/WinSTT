import { app, BrowserWindow, ipcMain } from "electron";
import { appSettingsSchema } from "../../src/shared/config/settings-schema";
import { getErrorMessage, ValidationError } from "../../src/shared/lib/errors";
import { store } from "../lib/store";
import type { SttClient } from "../ws/stt-client";
import { isSttProcessRunning, restartSttProcess } from "./stt-process-deps";

// Derived from the Zod schema so new top-level sections automatically participate
// in save/load without needing to update a second list.
const ALLOWED_SETTINGS_KEYS: ReadonlySet<string> = new Set(Object.keys(appSettingsSchema.shape));

/**
 * Settings keys that require a server restart when changed.
 * These are passed as CLI args and cannot be hot-reloaded.
 */
const STARTUP_ONLY_KEYS = new Set([
	// model.model is NOT here — it's hot-reloaded via sttSetParameter("model") which triggers
	// an in-place model swap on the server. Including it here would kill the recorder mid-swap.
	"model.realtimeModel",
	"model.computeType",
	"model.device",
	"model.backend",
	"model.onnxQuantization",
	"model.beamSize",
	"model.beamSizeRealtime",
	"model.initialPrompt",
	"model.initialPromptRealtime",
	// audio.inputDeviceIndex is hot-swapped via sttSetParameter("input_device_index")
	// in use-sync-settings.ts — do NOT include it here or device picks would
	// trigger a full server restart and lose the loaded models.
	"audio.webrtcSensitivity",
	"audio.minLengthOfRecording",
	"audio.sileroDeactivityDetection",
	"quality.enableRealtimeTranscription",
	"quality.useMainModelForRealtime",
	"quality.realtimeProcessingPause",
	"quality.earlyTranscriptionOnSilence",
	"quality.initRealtimeAfterSeconds",
	"quality.batchSize",
	"quality.realtimeBatchSize",
]);

let restartTimer: ReturnType<typeof setTimeout> | null = null;
let sttClientRef: SttClient | null = null;
let isShuttingDown = false;
let settingsSaveListener:
	| ((event: Electron.IpcMainEvent, payload: { settings: Record<string, unknown> }) => void)
	| null = null;

function clearRestartTimer(): void {
	if (restartTimer) {
		clearTimeout(restartTimer);
		restartTimer = null;
	}
}

function handleBeforeQuit(): void {
	isShuttingDown = true;
	clearRestartTimer();
}

function readNestedValue(settings: Record<string, unknown>, section: string, key: string): unknown {
	const sectionVal = settings[section];
	if (sectionVal == null || typeof sectionVal !== "object") {
		return;
	}
	return (sectionVal as Record<string, unknown>)[key];
}

function parseDotPath(dotPath: string): [string, string] | null {
	const [section, key] = dotPath.split(".");
	return section && key ? [section, key] : null;
}

function checkOneStartupKey(
	dotPath: string,
	oldSettings: Record<string, unknown>,
	newSettings: Record<string, unknown>
): boolean {
	const parts = parseDotPath(dotPath);
	if (!parts) {
		return false;
	}
	const [section, key] = parts;
	const oldVal = readNestedValue(oldSettings, section, key);
	const newVal = readNestedValue(newSettings, section, key);
	if (oldVal === newVal) {
		return false;
	}
	console.log(
		`[settings] Startup-only key changed: ${dotPath} (${String(oldVal)} → ${String(newVal)})`
	);
	return true;
}

function findChangedStartupKey(
	oldSettings: Record<string, unknown>,
	newSettings: Record<string, unknown>
): string | null {
	for (const dotPath of STARTUP_ONLY_KEYS) {
		if (checkOneStartupKey(dotPath, oldSettings, newSettings)) {
			return dotPath;
		}
	}
	return null;
}

function hasServerToRestart(): boolean {
	const managed = isSttProcessRunning();
	const connected = sttClientRef?.isConnected ?? false;
	return managed || connected;
}

function isRestartActionable(): boolean {
	if (isShuttingDown) {
		return false;
	}
	return hasServerToRestart();
}

function performRestart(): void {
	restartTimer = null;
	if (isShuttingDown) {
		return;
	}
	if (isSttProcessRunning()) {
		// Electron-managed server — kill and respawn with updated CLI args
		console.log("[settings] Restarting Electron-managed STT server");
		restartSttProcess();
		return;
	}
	// External server — cannot restart from Electron. These settings
	// will take effect on the next manual server restart.
	console.log(
		"[settings] Startup-only setting changed but server is not managed by Electron." +
			" Restart the server manually to apply the change."
	);
}

/** Check if any startup-only settings changed between old and new, trigger restart if so. */
function checkForRestartNeeded(
	oldSettings: Record<string, unknown>,
	newSettings: Record<string, unknown>
): void {
	if (!findChangedStartupKey(oldSettings, newSettings)) {
		return;
	}
	if (!isRestartActionable()) {
		return;
	}
	// Debounce restart so rapid changes don't cause multiple restarts
	clearRestartTimer();
	restartTimer = setTimeout(performRestart, 500);
}

export function setupSettingsHandlers(sttClient?: SttClient): void {
	isShuttingDown = false;
	sttClientRef = sttClient ?? null;
	app.off("before-quit", handleBeforeQuit);
	app.on("before-quit", handleBeforeQuit);
	ipcMain.removeHandler("settings:load");
	ipcMain.handle("settings:load", () => {
		try {
			return store.store;
		} catch (error) {
			console.error("[settings] Failed to load settings:", getErrorMessage(error));
			throw new ValidationError("Failed to load settings", undefined, {
				originalError: error,
			});
		}
	});

	if (settingsSaveListener) {
		ipcMain.off("settings:save", settingsSaveListener);
	}
	settingsSaveListener = settingsSaveImpl;
	ipcMain.on("settings:save", settingsSaveListener);
}

function snapshotSettings(): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of ALLOWED_SETTINGS_KEYS) {
		out[key] = store.get(key);
	}
	return out;
}

function applySettings(settings: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(settings)) {
		if (ALLOWED_SETTINGS_KEYS.has(key)) {
			store.set(key, value);
		}
	}
}

function broadcastSettingsToOtherWindows(
	senderId: number,
	settings: Record<string, unknown>
): void {
	for (const win of BrowserWindow.getAllWindows()) {
		if (win.webContents.id !== senderId) {
			win.webContents.send("settings:changed", { settings });
		}
	}
}

function validateSettingsObject(settings: unknown): void {
	if (!settings || typeof settings !== "object") {
		throw new ValidationError("Invalid settings object", "settings");
	}
}

function settingsSaveImpl(
	event: Electron.IpcMainEvent,
	{ settings }: { settings: Record<string, unknown> }
): void {
	try {
		validateSettingsObject(settings);
		const oldSettings = snapshotSettings();
		applySettings(settings);
		checkForRestartNeeded(oldSettings, settings);
		broadcastSettingsToOtherWindows(event.sender.id, settings);
	} catch (error) {
		console.error("[settings] Failed to save settings:", getErrorMessage(error));
		// Settings save is fire-and-forget (ipcMain.on), can't return error to renderer
		// Emit error event for renderer to handle
		event.sender.send("settings:save-error", {
			error: getErrorMessage(error),
		});
	}
}

export function cleanupSettingsHandlers(): void {
	isShuttingDown = true;
	clearRestartTimer();
	app.off("before-quit", handleBeforeQuit);
	ipcMain.removeHandler("settings:load");
	if (settingsSaveListener) {
		ipcMain.off("settings:save", settingsSaveListener);
		settingsSaveListener = null;
	}
}
