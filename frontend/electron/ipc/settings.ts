import { app, BrowserWindow, ipcMain } from "electron";
import { getErrorMessage, ValidationError } from "../../src/shared/lib/errors";
import { store } from "../lib/store";
import type { SttClient } from "../ws/stt-client";
import { isSttProcessRunning, restartSttProcess } from "./stt-process";

const ALLOWED_SETTINGS_KEYS = new Set([
	"model",
	"quality",
	"audio",
	"general",
	"hotkey",
	"dictionary",
	"snippets",
]);

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
	"audio.inputDeviceIndex",
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

/** Check if any startup-only settings changed between old and new, trigger restart if so. */
function checkForRestartNeeded(
	oldSettings: Record<string, unknown>,
	newSettings: Record<string, unknown>
) {
	let needsRestart = false;

	for (const dotPath of STARTUP_ONLY_KEYS) {
		const [section, key] = dotPath.split(".");
		if (!(section && key)) {
			continue;
		}
		const oldSection = oldSettings[section];
		const newSection = newSettings[section];
		const oldVal =
			oldSection != null && typeof oldSection === "object"
				? (oldSection as Record<string, unknown>)[key]
				: undefined;
		const newVal =
			newSection != null && typeof newSection === "object"
				? (newSection as Record<string, unknown>)[key]
				: undefined;
		if (oldVal !== newVal) {
			needsRestart = true;
			console.log(
				`[settings] Startup-only key changed: ${dotPath} (${String(oldVal)} → ${String(newVal)})`
			);
			break;
		}
	}

	if (!needsRestart) {
		return;
	}

	const managed = isSttProcessRunning();
	const connected = sttClientRef?.isConnected ?? false;

	if (!(managed || connected)) {
		return;
	}
	if (isShuttingDown) {
		return;
	}

	// Debounce restart so rapid changes don't cause multiple restarts
	clearRestartTimer();
	restartTimer = setTimeout(() => {
		restartTimer = null;
		if (isShuttingDown) {
			return;
		}
		if (isSttProcessRunning()) {
			// Electron-managed server — kill and respawn with updated CLI args
			console.log("[settings] Restarting Electron-managed STT server");
			restartSttProcess();
		} else {
			// External server — cannot restart from Electron. These settings
			// will take effect on the next manual server restart.
			console.log(
				"[settings] Startup-only setting changed but server is not managed by Electron." +
					" Restart the server manually to apply the change."
			);
		}
	}, 500);
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
	settingsSaveListener = (event, { settings }: { settings: Record<string, unknown> }) => {
		try {
			// Validate settings object
			if (!settings || typeof settings !== "object") {
				throw new ValidationError("Invalid settings object", "settings");
			}

			// Snapshot old values before applying changes
			const oldSettings: Record<string, unknown> = {};
			for (const key of ALLOWED_SETTINGS_KEYS) {
				oldSettings[key] = store.get(key);
			}

			for (const [key, value] of Object.entries(settings)) {
				if (ALLOWED_SETTINGS_KEYS.has(key)) {
					store.set(key, value);
				}
			}

			// Check if startup-only settings changed → auto-restart server
			checkForRestartNeeded(oldSettings, settings);

			// Forward updated settings to all OTHER windows so their stores stay in sync
			const allWindows = BrowserWindow.getAllWindows();
			for (const win of allWindows) {
				if (win.webContents.id !== event.sender.id) {
					win.webContents.send("settings:changed", { settings });
				}
			}
		} catch (error) {
			console.error("[settings] Failed to save settings:", getErrorMessage(error));
			// Settings save is fire-and-forget (ipcMain.on), can't return error to renderer
			// Emit error event for renderer to handle
			event.sender.send("settings:save-error", {
				error: getErrorMessage(error),
			});
		}
	};
	ipcMain.on("settings:save", settingsSaveListener);
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
