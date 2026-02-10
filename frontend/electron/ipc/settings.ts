import { BrowserWindow, ipcMain } from "electron";
import { store } from "../lib/store";
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
	"model.model",
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

/** Check if any startup-only settings changed between old and new, trigger restart if so. */
function checkForRestartNeeded(
	oldSettings: Record<string, unknown>,
	newSettings: Record<string, unknown>
) {
	let needsRestart = false;

	for (const dotPath of STARTUP_ONLY_KEYS) {
		const parts = dotPath.split(".");
		const section = parts[0] as string;
		const key = parts[1] as string;
		const oldVal = (oldSettings[section] as Record<string, unknown> | undefined)?.[key];
		const newVal = (newSettings[section] as Record<string, unknown> | undefined)?.[key];
		if (oldVal !== newVal) {
			needsRestart = true;
			console.log(
				`[settings] Startup-only key changed: ${dotPath} (${String(oldVal)} → ${String(newVal)})`
			);
			break;
		}
	}

	if (needsRestart && isSttProcessRunning()) {
		// Debounce restart so rapid changes don't cause multiple restarts
		if (restartTimer) {
			clearTimeout(restartTimer);
		}
		restartTimer = setTimeout(() => {
			restartTimer = null;
			console.log("[settings] Restarting STT server due to startup-only setting change");
			restartSttProcess();
		}, 500);
	}
}

export function setupSettingsHandlers() {
	ipcMain.handle("settings:load", () => {
		return store.store;
	});

	ipcMain.on("settings:save", (event, { settings }: { settings: Record<string, unknown> }) => {
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
	});
}
