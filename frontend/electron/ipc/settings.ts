import { app, BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";
import { appSettingsSchema } from "../../src/shared/config/settings-schema";
import { getErrorMessage, ValidationError } from "../../src/shared/lib/errors";
import {
	isRealtimeEnabled,
	type LiveTranscriptionDisplay,
} from "../../src/shared/lib/realtime-enabled";
import { decryptSecret, encryptSecret, SECRET_DOT_PATHS } from "../lib/secret-storage";
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
	"quality.useMainModelForRealtime",
	"quality.realtimeProcessingPause",
	"quality.earlyTranscriptionOnSilence",
	"quality.initRealtimeAfterSeconds",
	"quality.batchSize",
	"quality.realtimeBatchSize",
	// NOTE: general.speakerDiarization is intentionally NOT here — it is
	// toggled at runtime via the `request_diarization_toggle` control
	// command (see use-sync-settings), so it must never trigger a restart.
]);

/**
 * Wake-word-mode-specific restart predicate.
 *
 * The wake-word detector is built at server bootstrap from CLI args
 * (`--wakeword_backend` / `--wake_words` / `--openwakeword_model_paths`).
 * Anything that changes those args needs a full restart:
 *   - switching INTO wakeword mode (no detector → need one)
 *   - switching OUT OF wakeword mode (detector exists → tear it down)
 *   - changing the wake word while in wakeword mode (rebuild with new keyword)
 *   - changing the backend while in wakeword mode (tear down Porcupine,
 *     spin up openWakeWord — or vice versa)
 *
 * Plain ptt↔toggle↔listen swaps do NOT touch any CLI flag and must NOT
 * trigger a restart (would kill the loaded ASR model for no gain).
 */
/** Did the recordingMode cross the wakeword boundary (in or out)? */
function modeCrossesWakeword(oldMode: unknown, newMode: unknown): boolean {
	return (oldMode === "wakeword") !== (newMode === "wakeword");
}

// Wake-word config fields that travel as CLI args at server bootstrap. Any
// change to one of these while staying in wakeword mode requires a restart
// because the detector is built once from these values — there's no live-
// reconfigure path on the server side.
const WAKEWORD_CONFIG_FIELDS = ["wakeWord", "wakeWordSensitivity", "wakeWordTimeout"] as const;

/** Did any wake-word CLI param change while staying in wakeword mode? */
function wakeConfigChangedWhileInWakeword(
	oldMode: unknown,
	newMode: unknown,
	oldSettings: Record<string, unknown>,
	newSettings: Record<string, unknown>
): boolean {
	const staysInWakeword = oldMode === "wakeword" && newMode === "wakeword";
	if (!staysInWakeword) {
		return false;
	}
	for (const field of WAKEWORD_CONFIG_FIELDS) {
		const oldVal = readNestedValue(oldSettings, "general", field);
		const newVal = readNestedValue(newSettings, "general", field);
		if (oldVal !== newVal) {
			return true;
		}
	}
	return false;
}

function wakeWordRestartNeeded(
	oldSettings: Record<string, unknown>,
	newSettings: Record<string, unknown>
): boolean {
	const oldMode = readNestedValue(oldSettings, "general", "recordingMode");
	const newMode = readNestedValue(newSettings, "general", "recordingMode");
	return (
		modeCrossesWakeword(oldMode, newMode) ||
		wakeConfigChangedWhileInWakeword(oldMode, newMode, oldSettings, newSettings)
	);
}

function readDisplayMode(value: unknown): LiveTranscriptionDisplay {
	if (value === "none" || value === "in-app" || value === "in-pill" || value === "both") {
		return value;
	}
	return "both";
}

function effectiveRealtime(settings: Record<string, unknown>): boolean {
	return isRealtimeEnabled({
		showRecordingOverlay: readNestedValue(settings, "general", "showRecordingOverlay") !== false,
		liveTranscriptionDisplay: readDisplayMode(
			readNestedValue(settings, "general", "liveTranscriptionDisplay")
		),
	});
}

/**
 * Realtime is fully derived from `general.liveTranscriptionDisplay` (plus
 * `general.showRecordingOverlay` when the display is pill-only). Neither of
 * those is in STARTUP_ONLY_KEYS, so a change to either could flip the CLI
 * flag the server was spawned with — this predicate catches that so we
 * schedule a restart to bring the server in line.
 */
function realtimeEffectiveChanged(
	oldSettings: Record<string, unknown>,
	newSettings: Record<string, unknown>
): boolean {
	return effectiveRealtime(oldSettings) !== effectiveRealtime(newSettings);
}

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

function broadcastRestartRequired(setting: string): void {
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) {
			try {
				win.webContents.send(IPC.STT_RESTART_REQUIRED, { setting, kind: "unmanaged" });
			} catch {
				// A single hung renderer must not block the others.
			}
		}
	}
}

function performRestart(changedKey: string | null): void {
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
	// External server — cannot restart from Electron. Surface this instead
	// of only logging: a startup-only setting silently never applying (and
	// any UI gating on the never-arriving restart, e.g. a spinner) is
	// indistinguishable from a bug. The renderer shows a "restart the STT
	// server" notice.
	console.log(
		"[settings] Startup-only setting changed but server is not managed by Electron." +
			" Restart the server manually to apply the change."
	);
	broadcastRestartRequired(changedKey ?? "a setting");
}

/**
 * Should a settings change actually schedule a restart? True only when a
 * restart-relevant setting changed AND the server is in a state where a
 * restart can take effect. Extracted so `checkForRestartNeeded` carries a
 * single guard branch instead of two sequential early-returns.
 */
function shouldScheduleRestart(
	oldSettings: Record<string, unknown>,
	newSettings: Record<string, unknown>
): boolean {
	const startupKeyChanged = findChangedStartupKey(oldSettings, newSettings) !== null;
	const restartRelevantChange =
		startupKeyChanged ||
		wakeWordRestartNeeded(oldSettings, newSettings) ||
		realtimeEffectiveChanged(oldSettings, newSettings);
	return restartRelevantChange && isRestartActionable();
}

/** Check if any startup-only settings changed between old and new, trigger restart if so. */
function checkForRestartNeeded(
	oldSettings: Record<string, unknown>,
	newSettings: Record<string, unknown>
): void {
	if (!shouldScheduleRestart(oldSettings, newSettings)) {
		return;
	}
	// Capture which key forced the restart so the manual-restart notice
	// can name it. Falls back to the wake-word group when the change was
	// a wake-word param (those route through wakeWordRestartNeeded, which
	// findChangedStartupKey doesn't cover), and to the realtime-gate group
	// when the change came from the overlay/pill flipping effective realtime.
	const changedKey =
		findChangedStartupKey(oldSettings, newSettings) ??
		(wakeWordRestartNeeded(oldSettings, newSettings) ? "general.wakeWord" : null) ??
		(realtimeEffectiveChanged(oldSettings, newSettings)
			? "general.liveTranscriptionDisplay"
			: null);
	// Debounce restart so rapid changes don't cause multiple restarts
	clearRestartTimer();
	restartTimer = setTimeout(() => performRestart(changedKey), 500);
}

export function setupSettingsHandlers(sttClient?: SttClient): void {
	isShuttingDown = false;
	sttClientRef = sttClient ?? null;
	app.off("before-quit", handleBeforeQuit);
	app.on("before-quit", handleBeforeQuit);
	ipcMain.removeHandler("settings:load");
	ipcMain.handle("settings:load", () => {
		try {
			return decryptSecretsForRenderer(store.store);
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
	// Restart-detection compares this snapshot against the renderer-supplied
	// settings (plaintext). Decrypt secrets here so the diff is on like-for-like
	// values; otherwise the key field would always look "changed".
	return decryptSecretsForRenderer(out);
}

function applySettings(settings: Record<string, unknown>): void {
	const toPersist = encryptSecretsForDisk(settings);
	for (const [key, value] of Object.entries(toPersist)) {
		if (ALLOWED_SETTINGS_KEYS.has(key)) {
			store.set(key, value);
		}
	}
}

function walkSecretField(
	settings: Record<string, unknown>,
	dotPath: string,
	transform: (v: unknown) => unknown
): void {
	const [section, field] = dotPath.split(".");
	if (!(section && field)) {
		return;
	}
	const sectionVal = settings[section];
	if (!sectionVal || typeof sectionVal !== "object" || Array.isArray(sectionVal)) {
		return;
	}
	const obj = sectionVal as Record<string, unknown>;
	if (!(field in obj)) {
		return;
	}
	obj[field] = transform(obj[field]);
}

/**
 * Return a defensive deep-copy of `settings` with every secret-at-rest field
 * decrypted to plaintext. Safe to send to the renderer over IPC.
 */
function decryptSecretsForRenderer(settings: Record<string, unknown>): Record<string, unknown> {
	const clone = structuredClone(settings) as Record<string, unknown>;
	for (const dotPath of SECRET_DOT_PATHS) {
		walkSecretField(clone, dotPath, (v) => decryptSecret(v));
	}
	return clone;
}

/**
 * Return a defensive deep-copy of `settings` with every secret-at-rest field
 * encrypted into its on-disk envelope. The renderer always sends plaintext;
 * this is the boundary where it gets sealed.
 */
function encryptSecretsForDisk(settings: Record<string, unknown>): Record<string, unknown> {
	const clone = structuredClone(settings) as Record<string, unknown>;
	for (const dotPath of SECRET_DOT_PATHS) {
		walkSecretField(clone, dotPath, (v) => (typeof v === "string" ? encryptSecret(v) : v));
	}
	return clone;
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

/**
 * Apply a dot-pathed settings patch from the main process (e.g. from a global
 * hotkey combo) and broadcast the resulting full snapshot to every renderer
 * so all open windows re-hydrate their Zustand store.
 *
 *   applyMainProcessSettingsPatch({ "general.recordingMode": "ptt" });
 *
 * The store treats dot paths as nested writes, so `general.recordingMode`
 * updates the nested key without clobbering the rest of the section. The
 * broadcast goes to *every* window (no sender to exclude — this update did
 * not originate from a renderer) so the settings panel, status bar, and
 * tray-menu refresh in lock-step. Also triggers the same restart-needed
 * check as the save path so e.g. a hotkey switch into wakeword mode kicks
 * the server restart that brings the wake-word detector online.
 */
export function applyMainProcessSettingsPatch(patch: Record<string, unknown>): void {
	const oldSnapshot = snapshotSettings();
	for (const [dotPath, value] of Object.entries(patch)) {
		store.set(dotPath, value);
	}
	const newSnapshot = snapshotSettings();
	checkForRestartNeeded(oldSnapshot, newSnapshot);
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) {
			win.webContents.send("settings:changed", { settings: newSnapshot });
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
