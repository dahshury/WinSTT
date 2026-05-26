// biome-ignore-all assist/source/organizeImports: ./portable-boot MUST stay
// as the FIRST import — it overrides app.setPath("userData", …) before any
// downstream module (electron-store, electron-log, sentry-electron, our
// ./lib/store) caches the OS default. Re-sorting it later in the import
// block would break portable mode by letting those modules cache the wrong
// path. See ./portable-boot.ts for the full rationale.
import { portableState } from "./portable-boot";

import path from "node:path";
import {
	app,
	BrowserWindow,
	clipboard,
	type IpcMainInvokeEvent,
	ipcMain,
	Menu,
	type MenuItemConstructorOptions,
	screen,
	session,
	shell,
	type Tray,
} from "electron";
import log from "electron-log/main";
import { IPC } from "../src/shared/api/ipc-channels";
import { setupAboutHandlers } from "./ipc/about";
import { registerAppMenuIpcHandlers } from "./ipc/app-menu-ipc";
import type { AppMenuBuiltItem } from "./ipc/app-menu-template";
import { flushMutePending, unmuteSystemAudio } from "./ipc/audio-mute";
import { setupAutostartHandlers } from "./ipc/autostart";
import { createClipboardHandler } from "./ipc/clipboard";
import {
	createContextMenuIpcHandler,
	registerContextMenuIpcHandler,
} from "./ipc/context-menu-handler";
import { setupCredentials } from "./ipc/credentials";
import { setupDevicePickerHandlers } from "./ipc/device-picker-window";
import { setupDiagBundleHandler } from "./ipc/diag-bundle";
import { setupDialogHandlers } from "./ipc/dialog";
import { setupFileTranscribeHandlers } from "./ipc/file-transcribe";
import { setupHistoryIpc } from "./ipc/history";
import { type HotkeyComboAction, setupHotkeyHandlers } from "./ipc/hotkey";
import {
	decryptIpcPayload,
	type EncryptedIpcPayload,
	encryptIpcPayload,
	generateIpcPayloadKey,
} from "./ipc/ipc-payload-crypto";
import { setupLlm, setupLlmWarmup } from "./ipc/llm";
import { setupLoopbackHandlers } from "./ipc/loopback";
import { setupModelPickerHandlers } from "./ipc/model-picker-window";
import { setupOllamaRegistry } from "./ipc/ollama-registry";
import { createOnboardingWindow, setupOnboardingHandlers } from "./ipc/onboarding-window";
import {
	hideOverlay,
	setMainWindow,
	setOverlayWindow,
	setupOverlayHandlers,
	showOverlay,
	syncOverlayToMainWindow,
} from "./ipc/overlay";
import { setupRelay } from "./ipc/relay";
import { setupRepasteHotkey } from "./ipc/repaste-hotkey";
import {
	applyMainProcessSettingsPatch,
	cleanupSettingsHandlers,
	setupSettingsHandlers,
} from "./ipc/settings";
import { setupCloudStt } from "./ipc/stt-cloud";
import { handleAbortOperation, setupSttCommandHandlers } from "./ipc/stt-commands";
import { killSttProcess, setupSttProcessHandlers, tryAutoSpawnServer } from "./ipc/stt-process";
import { setupSystemLocaleHandler } from "./ipc/system-locale";
import { setupTransformHotkeys } from "./ipc/transform-hotkeys";
import { setupTransforms } from "./ipc/transforms";
import { setupTray } from "./ipc/tray";
import { setupTrayMenuHandlers } from "./ipc/tray-menu-window";
import {
	detachTray,
	onTrayIdle,
	onTrayRecordingStart,
	onTrayTranscriptionStart,
} from "./ipc/tray-state";
import { setupTts } from "./ipc/tts";
import { setupTtsHotkey } from "./ipc/tts-hotkey";
import {
	createUpdaterStatusHistory,
	type UpdaterStatusEntry,
	type UpdaterStatusEntryInput,
} from "./ipc/updater-status-history";
import { registerWindowTelemetry } from "./ipc/window-telemetry";
import { dbg } from "./lib/debug-log";
import { shutdownPsHost } from "./lib/ps-host";
import { cleanupRecordingIndicator, initRecordingIndicator } from "./lib/recording-indicator";
import { isAllowedRendererUrl, loadRendererPage } from "./lib/renderer-url";
import { captureMainException, initSentryMain } from "./lib/sentry-main";
import { cleanupSound, initSound } from "./lib/sound";
import { initSoundLibrary } from "./lib/sound-library";
import { getStoreValue, migrateSecretsAtRest, store } from "./lib/store";
import { SttClient } from "./ws/stt-client";

// Route every console.* call in the main process and all IPC handlers through
// electron-log so they land in debug.log under a `[console]` scope. Must run
// before any handler/side-effect code below executes a console.* call. Renderer
// console.* is captured separately via the webContents `console-message`
// listener registered in createWindow(). Note: `log.scope("console")` already
// returns the LogFunctions record (error/warn/info/log/verbose/debug/silly) —
// no `.functions` accessor needed (that property lives only on the parent Logger).
Object.assign(console, log.scope("console"));

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let settingsFadeTimer: ReturnType<typeof setInterval> | null = null;
let overlayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let cleanupRelay: (() => void) | null = null;
let cleanupRepasteHotkey: (() => void) | null = null;
let cleanupHotkeys: (() => void) | null = null;
let cleanupFileTranscribe: (() => void) | null = null;
let cleanupLlm: (() => void) | null = null;
let cleanupCredentials: (() => void) | null = null;
let cleanupCloudStt: (() => void) | null = null;
let cleanupLlmWarmup: (() => void) | null = null;
let cleanupOllamaRegistry: (() => void) | null = null;
let cleanupTransforms: (() => void) | null = null;
let cleanupTransformHotkeys: (() => void) | null = null;
let cleanupTts: (() => void) | null = null;
let cleanupTtsHotkey: (() => void) | null = null;
let cleanupTrayMenu: (() => void) | null = null;
let cleanupModelPicker: (() => void) | null = null;
let cleanupDevicePicker: (() => void) | null = null;
let cleanupOnboarding: (() => void) | null = null;
let cleanupAppMenu: (() => void) | null = null;
let cleanupContextMenu: (() => void) | null = null;
let cleanupWindowTelemetry: (() => void) | null = null;
let cleanupClipboard: (() => void) | null = null;
let cleanupUpdaterStatus: (() => void) | null = null;
let cleanupSecureInvoke: (() => void) | null = null;
let cleanupWindowControls: (() => void) | null = null;
let cleanupOverlay: (() => void) | null = null;
let cleanupSystemLocale: (() => void) | null = null;
let cleanupDiagBundle: (() => void) | null = null;
let cleanupAbout: (() => void) | null = null;
let cleanupSoundLibrary: (() => void) | null = null;
let cleanupHistory: (() => void) | null = null;
let autoUpdateCheckTimer: ReturnType<typeof setInterval> | null = null;
const secureIpcKey = generateIpcPayloadKey();
const updaterStatusHistory = createUpdaterStatusHistory({ maxEntries: 200 });
const sttClient = new SttClient();
const isDev = !app.isPackaged;

/**
 * Live handle to the `electron-updater` autoUpdater singleton, populated by
 * `initAutoUpdater()` once the bundled ESM/CJS module is dynamically loaded.
 * Lifted to module scope so:
 *   1. The "Check for updates now" IPC handler can call into it on demand.
 *   2. The `general` store watcher can flip `allowPrerelease` live when the
 *      user toggles "Receive pre-release updates" — no restart required.
 * Stays `null` in dev / when auto-updates are disabled by env var.
 */
interface DownloadProgressPayload {
	bytesPerSecond?: number;
	percent?: number;
	total?: number;
	transferred?: number;
}

interface AutoUpdaterHandle {
	allowPrerelease: boolean;
	autoDownload: boolean;
	checkForUpdatesAndNotify: () => Promise<unknown>;
	on: (event: string, listener: (...args: unknown[]) => void) => void;
	/**
	 * Restart the app to apply a downloaded update.
	 *  - `isSilent`: pass `true` only for NSIS; portable & macOS ignore it.
	 *  - `isForceRunAfter`: relaunch after install (the user expects this).
	 * Idempotent if there is no downloaded update — electron-updater logs
	 * and no-ops, so we don't need to gate the IPC handler on state.
	 */
	quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
}
let autoUpdaterRef: AutoUpdaterHandle | null = null;
let disposeUpdaterSettingsWatcher: (() => void) | null = null;

/** Pre-release semver versions carry a `-` separator (e.g. `0.1.0-alpha.0`). */
function isPrereleaseVersion(version: string): boolean {
	return version.includes("-");
}

/**
 * Effective `allowPrerelease` flag for electron-updater. Honors the user's
 * persisted setting OR forces it on when this build itself is a pre-release —
 * an alpha install must always be able to update to the next alpha, even if
 * the persisted toggle is off (e.g. fresh install where the user hasn't
 * touched settings).
 */
function shouldAllowPrerelease(): boolean {
	const userOptIn = getStoreValue("general.receivePrereleaseUpdates") === true;
	return userOptIn || isPrereleaseVersion(app.getVersion());
}

/** Shared webPreferences for all BrowserWindows (sandbox + context isolation). */
const sharedWebPreferences: Electron.WebPreferences = {
	preload: path.join(import.meta.dirname, "preload.cjs"),
	contextIsolation: true,
	nodeIntegration: false,
	sandbox: true,
};

/** Set to true during app.quit() so the main window close handler allows actual destruction. */
let isQuitting = false;

// Tracks whether the stt-server has signalled `server-ready` since process
// start. Needed because we kick the WS connect off in parallel with the
// renderer (Vite dev server / loadFile) boot — the event can fire BEFORE
// the main window's `ready-to-show` handler runs, in which case a fresh
// `once("server-ready")` listener registered there would never see it.
// Set once and stay true until process exit; a server restart raises a
// fresh ready event but the initial-show gate only cares about the first.
let serverReadyFiredOnce = false;
sttClient.on("server-ready", () => {
	serverReadyFiredOnce = true;
});
// Last `runtime_info` payload from the server. Tracked at the module level so
// it survives the gap between the SttClient firing the event and the relay
// (set up inside createWindow) registering its own listener. Without this,
// the first-run onboarding wizard delay would let the event fire into the
// void, leaving the GPU/CPU chip stuck on "Connecting" once the main window
// finally mounts and queries STT_GET_RUNTIME_INFO.
let lastRuntimeInfo: unknown = null;
sttClient.on("runtime-info", (info: unknown) => {
	lastRuntimeInfo = info;
});

// Drive the state-driven tray icon (idle / recording / transcribing) from
// raw server events. We subscribe directly on the SttClient so the tray
// state stays correct even if the relay isn't wired yet (onboarding delay)
// or fails — the tray is non-critical UI, but it shouldn't lie about state.
// See `electron/ipc/tray-state.ts` for the controller; transitions here
// match the relay's recording lifecycle (handleRecordingStart, the
// `transcription_start` simple-relay branch, and handleRecordingStop /
// fullSentence / no_audio_detected as terminal idle signals).
//
// Defer idle/transcribing transitions via a microtask so the relay's
// data-event listener (which runs the recording-indicator's revertIcons()
// on recording_stop) lands first; without that ordering, the indicator
// would overwrite our theme-aware idle icon with the legacy build asset.
function dispatchTrayStateFromEvent(type: string): void {
	if (type === "recording_start") {
		onTrayRecordingStart();
		return;
	}
	queueMicrotask(() => {
		if (type === "transcription_start") {
			onTrayTranscriptionStart();
			return;
		}
		if (type === "recording_stop" || type === "fullSentence" || type === "no_audio_detected") {
			onTrayIdle();
		}
	});
}
sttClient.on("data-event", (event: unknown) => {
	const ev = event as { type?: unknown } | null;
	const type = ev && typeof ev.type === "string" ? ev.type : null;
	if (!type) {
		return;
	}
	dispatchTrayStateFromEvent(type);
});
sttClient.on("disconnected", () => {
	// A reconnect storm or a server crash mid-recording shouldn't leave the
	// tray stuck on the "Recording…" red dot. Reset to idle whenever we
	// lose the server.
	onTrayIdle();
});

let hasFlushedAudioOnQuit = false;
let cspHookInstalled = false;
let disposeGeneralSettingsWatcher: (() => void) | null = null;

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

/**
 * Cycle order for the `hotkey + ArrowUp` mode-cycling combo. Matches the
 * order of the recording-mode switcher in Settings → General so users see
 * the same sequence in both places.
 */
const MODE_CYCLE = ["ptt", "toggle", "listen", "wakeword"] as const;
type RecordingMode = (typeof MODE_CYCLE)[number];

function nextRecordingMode(current: RecordingMode): RecordingMode {
	const idx = MODE_CYCLE.indexOf(current);
	// Falls through to MODE_CYCLE[0] when current isn't in the list (corrupt
	// store value — defensive). `% length` wraps the end back to the start.
	return MODE_CYCLE[(Math.max(idx, 0) + 1) % MODE_CYCLE.length] ?? MODE_CYCLE[0];
}

/**
 * Dispatch for the second-key combos detected in `hotkey.ts` while the
 * global hotkey is held.
 *
 *   - cancel        → abort the in-flight transcription + LLM pass
 *   - cycle-mode    → advance to the next recording mode AND abort, since
 *                     the recording that the press just kicked off would
 *                     otherwise paste into the user's window under the new
 *                     mode's semantics
 *
 * Mode switches are persisted via `applyMainProcessSettingsPatch` which
 * mirrors the renderer-side save path: it updates the store, fires the
 * restart-needed check (entering / leaving wakeword), and broadcasts a
 * fresh full snapshot to every renderer so the settings panel, tray
 * indicator, and visualizer accent color all flip in lock-step.
 */
function handleHotkeyCombo(action: HotkeyComboAction, sttClient: SttClient): void {
	if (action === "cancel") {
		handleAbortOperation(sttClient);
		return;
	}
	// action === "cycle-mode"
	const current = getStoreValue("general.recordingMode") as RecordingMode;
	const next = nextRecordingMode(current);
	// Drop the in-flight recording first — the user's intent is "I want to
	// change mode", not "transcribe this audio into the new mode's flow".
	handleAbortOperation(sttClient);
	applyMainProcessSettingsPatch({ "general.recordingMode": next });
}

type SecureInvokeChannel =
	| typeof IPC.CLIPBOARD_OPERATE
	| typeof IPC.UPDATER_GET_STATUS_HISTORY
	| typeof IPC.UPDATER_CLEAR_STATUS_HISTORY;

interface SecureInvokeRequest {
	channel: SecureInvokeChannel;
	payload?: unknown;
}

interface SecureInvokeSuccess {
	ok: true;
	result: unknown;
}

interface SecureInvokeFailure {
	error: string;
	ok: false;
}

type SecureInvokeResponse = SecureInvokeSuccess | SecureInvokeFailure;

function broadcastToAllWindows(channel: string, payload: unknown): void {
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) {
			win.webContents.send(channel, payload);
		}
	}
}

function recordUpdaterStatus(entry: UpdaterStatusEntryInput): UpdaterStatusEntry {
	const value = updaterStatusHistory.record(entry);
	broadcastToAllWindows(IPC.UPDATER_STATUS, value);
	return value;
}

function setupFatalErrorHandlers(): void {
	process.on("uncaughtException", (error) => {
		dbg("crash", "Uncaught exception:", toErrorMessage(error));
		captureMainException(error, { source: "uncaughtException" });
	});
	process.on("unhandledRejection", (reason) => {
		dbg("crash", "Unhandled rejection:", toErrorMessage(reason));
		captureMainException(reason, { source: "unhandledRejection" });
	});
}

function getWindowIconPath(): string | undefined {
	if (process.platform === "win32") {
		return path.join(import.meta.dirname, "..", "build", "icon.ico");
	}
	return;
}

// Renderer is a Vite-built static SPA loaded directly via file:// in
// production and via http://localhost:3000 in dev. See
// electron/lib/renderer-url.ts for the loadRendererPage helper.

function isAllowedNavigation(url: string): boolean {
	return isAllowedRendererUrl(url);
}

function protectWindowNavigation(win: BrowserWindow): void {
	win.webContents.on("will-navigate", (event, url) => {
		if (isAllowedNavigation(url)) {
			return;
		}
		event.preventDefault();
	});

	win.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("https://") || url.startsWith("http://")) {
			shell.openExternal(url).catch((error) => {
				dbg("window", "Failed to open external URL:", toErrorMessage(error));
			});
		}
		return { action: "deny" };
	});
}

function installCspHook(): void {
	if (cspHookInstalled) {
		return;
	}
	session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
		// `sentry-ipc:` is the custom protocol that @sentry/electron's renderer
		// SDK uses to talk to the main-process SDK (scope sync, event forwarding).
		// Stays in connect-src for both dev and prod, even when SENTRY_DSN is
		// unset, because the renderer init runs unconditionally.
		//
		// Dev: Vite serves the renderer from http://localhost:3000 with an HMR
		// WebSocket on ws://localhost:3000 — both must be reachable from the
		// renderer (which loads from that same origin, so `'self'` covers
		// fetches but the HMR socket needs an explicit ws://localhost:*).
		// 'unsafe-eval' is for React-refresh's eval-driven HMR.
		//
		// Prod: the renderer loads from `file://` (no scheme is "self" for
		// file: URLs; we treat file: assets as same-origin via the directive
		// list below). Vite emits external `<script type="module" src="..."/>`,
		// so we no longer need `'unsafe-inline'` for scripts — only for styles
		// (Base UI / Tailwind insert inline style tags at runtime). No
		// localhost / 127.0.0.1 endpoints to whitelist — there is no longer
		// a bundled Node renderer-server in this process.
		const csp = isDev
			? "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' sentry-ipc: ws://localhost:* http://localhost:*; font-src 'self' data:; img-src 'self' data:"
			: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' sentry-ipc:; font-src 'self' data:; img-src 'self' data:";
		callback({
			responseHeaders: {
				...details.responseHeaders,
				"Content-Security-Policy": [csp],
			},
		});
	});
	cspHookInstalled = true;
}

async function initAutoUpdater(): Promise<void> {
	if (isDev || !app.isPackaged) {
		recordUpdaterStatus({
			status: "idle",
			message: "Auto-updates are disabled in development mode.",
		});
		return;
	}
	if (process.env.WINSTT_ENABLE_AUTO_UPDATES === "0") {
		recordUpdaterStatus({
			status: "idle",
			message: "Auto-updates disabled by WINSTT_ENABLE_AUTO_UPDATES=0.",
		});
		return;
	}

	try {
		// electron-updater is bundled into main.js via tsup (no node_modules at
		// runtime). The bundled-ESM shape sometimes exposes named exports at
		// `module.<name>` and sometimes at `module.default.<name>` depending on
		// how esbuild wraps the original CJS module — accept both.
		const updaterModule = (await import("electron-updater")) as {
			autoUpdater?: AutoUpdaterHandle;
			default?: { autoUpdater?: AutoUpdaterHandle };
		};
		const autoUpdater = updaterModule.autoUpdater ?? updaterModule.default?.autoUpdater;
		if (!autoUpdater) {
			throw new Error("electron-updater: autoUpdater export not found on module");
		}
		autoUpdaterRef = autoUpdater;

		const getUpdateVersion = (payload: unknown): string => {
			if (typeof payload === "object" && payload !== null && "version" in payload) {
				return String((payload as { version: unknown }).version);
			}
			return "unknown";
		};

		autoUpdater.autoDownload = true;
		// Sourced from the user's persisted "Receive pre-release updates"
		// toggle, OR-ed with "is this build itself a pre-release". The OR
		// guarantees alpha→alpha self-updates work without forcing every
		// stable user onto the alpha train. Live-updated below via the
		// general-settings watcher.
		autoUpdater.allowPrerelease = shouldAllowPrerelease();
		autoUpdater.on("checking-for-update", () => {
			dbg("updater", "Checking for updates");
			recordUpdaterStatus({ status: "checking" });
		});
		autoUpdater.on("update-available", (info: unknown) => {
			const version = getUpdateVersion(info);
			dbg("updater", "Update available:", version);
			recordUpdaterStatus({ status: "available", version });
		});
		autoUpdater.on("update-not-available", () => {
			dbg("updater", "No updates available");
			recordUpdaterStatus({ status: "not-available" });
		});
		autoUpdater.on("error", (error: unknown) => {
			const message = toErrorMessage(error);
			dbg("updater", "Auto-update error:", message);
			recordUpdaterStatus({ status: "error", message });
		});
		autoUpdater.on("update-downloaded", (info: unknown) => {
			const version = getUpdateVersion(info);
			dbg("updater", "Update downloaded:", version);
			recordUpdaterStatus({ status: "downloaded", version });
		});
		// `download-progress` fires every ~250ms while the new artifact streams
		// in. Pass-through; the renderer formats the bytes / rate for display.
		// Note: the payload's `percent` is a float 0–100, not 0–1.
		autoUpdater.on("download-progress", (payload: unknown) => {
			const progress = (payload ?? {}) as DownloadProgressPayload;
			recordUpdaterStatus({
				status: "downloading",
				...(typeof progress.percent === "number" ? { percent: progress.percent } : {}),
				...(typeof progress.transferred === "number" ? { transferred: progress.transferred } : {}),
				...(typeof progress.total === "number" ? { total: progress.total } : {}),
				...(typeof progress.bytesPerSecond === "number"
					? { bytesPerSecond: progress.bytesPerSecond }
					: {}),
			});
		});

		// Live-update `allowPrerelease` whenever the user toggles "Receive
		// pre-release updates" in Settings — no restart needed. We watch the
		// whole `general` section (matching the pattern used for the listen-
		// mode resize handler above) and re-derive on every change since the
		// toggle's value is cheap to read and the comparison is idempotent.
		const updateAllowPrerelease = (): void => {
			const next = shouldAllowPrerelease();
			if (autoUpdater.allowPrerelease !== next) {
				autoUpdater.allowPrerelease = next;
				dbg("updater", `allowPrerelease → ${next}`);
				// Re-check immediately so a user who flipped the toggle on
				// sees the prerelease they were waiting for without having
				// to wait for the next 4h tick.
				autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => {
					const message = toErrorMessage(error);
					dbg("updater", "Post-toggle re-check failed:", message);
					recordUpdaterStatus({ status: "error", message });
				});
			}
		};
		disposeUpdaterSettingsWatcher = store.onDidChange("general", updateAllowPrerelease);

		await autoUpdater.checkForUpdatesAndNotify();
		autoUpdateCheckTimer = setInterval(
			() => {
				autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => {
					const message = toErrorMessage(error);
					dbg("updater", "Periodic update check failed:", message);
					recordUpdaterStatus({ status: "error", message });
				});
			},
			1000 * 60 * 60 * 4
		);
	} catch (error) {
		const message = toErrorMessage(error);
		dbg("updater", "Auto-updater init failed:", message);
		recordUpdaterStatus({ status: "error", message });
	}
}

// Sentry main-process init MUST run before setupFatalErrorHandlers() so the
// SDK's own uncaughtException handler is installed first; ours then captures
// to Sentry too (Sentry dedupes by error identity, so the double-capture is safe).
// The `general.sendCrashReports` setting is the user-facing opt-out — when
// false, `initSentryMain` is a no-op and the renderer skips its own init too.
const sendCrashReports = getStoreValue("general.sendCrashReports") ?? true;
initSentryMain({ enabled: sendCrashReports });
setupFatalErrorHandlers();

// Prevent unhandled "error" events on EventEmitter from crashing the app with dialog windows.
// WebSocket connection failures during reconnection emit "error" — just log them.
sttClient.on("error", (err: unknown) => {
	let msg: string;
	if (err instanceof Error) {
		msg = err.message;
	} else if (typeof err === "object" && err !== null && "message" in err) {
		msg = String((err as { message: unknown }).message);
	} else {
		msg = String(err);
	}
	dbg("stt-client", "Connection error:", msg);
});

// Suppress Electron's CSP security warning in dev (Vite HMR + React Fast Refresh require unsafe-eval)
if (isDev) {
	process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
}

// Suppress DevTools "Autofill.enable" / "Autofill.setAddresses" protocol errors
app.commandLine.appendSwitch(
	"disable-features",
	"AutofillServerCommunication,Autofill,AutofillCreditCardAuthentication"
);

// Allow Web Audio API playback without user gesture (hotkey is detected via
// native uIOhook, not a DOM event, so Chromium won't recognise it as user input)
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// E2E runs need their own userData path so they don't fight a parallel
// dev session for the single-instance lock (and so settings don't leak
// between test runs). Portable mode wins if both are active — E2E is a
// dev-only path and clobbering the portable Data/ dir would defeat the
// whole point of an isolated USB-stick install.
if (process.env.WINSTT_E2E === "1" && !portableState.isPortable) {
	const e2eUserData = path.join(app.getPath("temp"), `winstt-e2e-${process.pid}`);
	app.setPath("userData", e2eUserData);
}

// Surface the portable-mode outcome through dbg() now that the logger is
// fully wired. The initial decision was already logged via electron-log's
// `portable` scope in portable-boot.ts; this gives a single line in the
// canonical `debug-log` tag so a quick grep finds it.
if (portableState.isPortable) {
	dbg("portable", `active — data dir: ${portableState.dataDir}`);
} else {
	dbg("portable", "inactive (no valid marker found next to exe)");
}

// ── Single-instance lock ─────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();

if (gotTheLock) {
	app.on("second-instance", () => {
		if (mainWindow) {
			if (mainWindow.isMinimized()) {
				mainWindow.restore();
			}
			mainWindow.show();
			mainWindow.focus();
		}
	});

	// ── Register IPC handlers once at app level (not per window) ──────
	// Startup-phase timing: each milestone logs a delta from process
	// start so the debug.log makes it trivial to see where the launch
	// budget is going. Useful when tuning the parallel-warmup ordering
	// or chasing regressions in the bundled stt-server cold path.
	const startupT0 = Date.now();
	const phase = (name: string): void => {
		dbg("startup", `[+${String(Date.now() - startupT0).padStart(5)} ms] ${name}`);
	};
	phase("app.whenReady gate entered");
	app
		.whenReady()
		.then(() => {
			// Encrypt any legacy plaintext secrets persisted before this version.
			// Must run before any IPC handler that ships settings to the renderer.
			migrateSecretsAtRest();
			phase("secrets migrated");

			// Kick off the stt-server child process AND the WS client
			// connection BEFORE creating any window. The server takes
			// ~5–8 s on a cold start to load Whisper/Silero ONNX sessions;
			// the renderer (Vite file:// load) is ready in well under a
			// second. Running these in parallel means by the time the
			// window is asked to show, the WS handshake has typically
			// already completed and `server_ready` fires right around the
			// same moment as `ready-to-show` — the user never sees the
			// offline chip during cold launch.
			//
			// Both calls are non-blocking and self-recovering: spawn errors
			// surface via `(stt-spawn)` log + IPC status; connect failures
			// retry via the 250 ms → 2 s exponential backoff in stt-client.
			setupGlobalIpcHandlers();
			phase("IPC handlers registered");
			if (process.env.WINSTT_E2E_SKIP_STT !== "1") {
				tryAutoSpawnServer();
				phase("stt-server spawn dispatched");
			}
			dbg("stt-client", "Connecting to STT server (pre-window)...");
			sttClient.connect().catch(() => {
				dbg("stt-client", "Initial connect failed — will retry via reconnection");
			});
			sttClient.once("connected", () => phase("stt-client WS connected"));
			sttClient.once("server-ready", () => phase("stt-server READY (recorder initialized)"));

			// No more startBundledRendererServer() — Vite static files load
			// directly via file:// in production, and from the running Vite
			// dev server in dev (bun electron:start waits on tcp:3000 first,
			// so by the time we get here the dev server is already listening).
			//
			// First-run gate: when `general.onboarded` is false, show the
			// onboarding wizard before the main window. The main window only
			// opens once the wizard finishes (either via the Finish button or
			// the user closing/skipping). All the background services we just
			// kicked off (stt-server, WS client, IPC handlers) keep running in
			// the meantime — by the time the user lands in the main window,
			// the server is already warm.
			// Diagnostic override: `WINSTT_FORCE_ONBOARDING=1` always shows the
			// wizard on launch, regardless of the persisted flag. Lets us re-run
			// setup to debug wizard flows without hand-editing
			// `winstt-settings.json`. The wizard's normal finish still flips
			// `general.onboarded` to true on disk; the override only suppresses
			// the *read* of that flag for this run.
			const forceOnboarding = process.env.WINSTT_FORCE_ONBOARDING === "1";
			const isOnboarded = !forceOnboarding && getStoreValue("general.onboarded") === true;
			if (forceOnboarding) {
				phase("WINSTT_FORCE_ONBOARDING=1 — forcing wizard regardless of stored flag");
			}
			if (isOnboarded) {
				createWindow();
				phase("createWindow returned (window created hidden)");
			} else {
				cleanupOnboarding = setupOnboardingHandlers({
					onFinish: () => {
						phase("onboarding finished — creating main window");
						createWindow();
					},
				});
				createOnboardingWindow();
				phase("onboarding window created");
			}
			initAutoUpdater().catch((error) => {
				dbg("updater", "Auto-updater init task failed:", toErrorMessage(error));
			});

			// Clear stale HTTP cache without delaying first window render.
			session.defaultSession.clearCache().catch((error) => {
				dbg("cache", "Failed to clear cache:", toErrorMessage(error));
			});
		})
		.catch((error) => {
			dbg("startup", "App startup failed:", toErrorMessage(error));
			app.exit(1);
		});

	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") {
			app.quit();
		}
	});

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});

	// ── Cleanup on quit ───────────────────────────────────────────────
	app.on("before-quit", (event) => {
		isQuitting = true;
		// If we ducked the master volume for dictation, schedule a restore
		// and defer quit until the PS host has confirmed it (or timed out).
		// Without this the user can be left at DUCK_LEVEL volume after a
		// hotkey-triggered quit mid-recording.
		if (!hasFlushedAudioOnQuit) {
			hasFlushedAudioOnQuit = true;
			unmuteSystemAudio();
			const flushDeadline = new Promise<void>((resolve) => setTimeout(resolve, 1500));
			event.preventDefault();
			Promise.race([flushMutePending(), flushDeadline]).finally(() => {
				shutdownPsHost();
				app.quit();
			});
			return;
		}
		shutdownPsHost();
		cleanupSound();
		cleanupRecordingIndicator();
		cleanupTrayMenu?.();
		cleanupTrayMenu = null;
		cleanupModelPicker?.();
		cleanupModelPicker = null;
		cleanupDevicePicker?.();
		cleanupDevicePicker = null;
		cleanupOnboarding?.();
		cleanupOnboarding = null;
		cleanupLlm?.();
		cleanupLlm = null;
		cleanupCredentials?.();
		cleanupCredentials = null;
		cleanupCloudStt?.();
		cleanupCloudStt = null;
		cleanupLlmWarmup?.();
		cleanupLlmWarmup = null;
		cleanupOllamaRegistry?.();
		cleanupOllamaRegistry = null;
		cleanupTransforms?.();
		cleanupTransforms = null;
		cleanupTransformHotkeys?.();
		cleanupTransformHotkeys = null;
		cleanupTts?.();
		cleanupTts = null;
		cleanupTtsHotkey?.();
		cleanupTtsHotkey = null;
		cleanupRepasteHotkey?.();
		cleanupRepasteHotkey = null;
		cleanupAppMenu?.();
		cleanupAppMenu = null;
		cleanupContextMenu?.();
		cleanupContextMenu = null;
		cleanupWindowTelemetry?.();
		cleanupWindowTelemetry = null;
		cleanupClipboard?.();
		cleanupClipboard = null;
		cleanupUpdaterStatus?.();
		cleanupUpdaterStatus = null;
		cleanupSecureInvoke?.();
		cleanupSecureInvoke = null;
		cleanupWindowControls?.();
		cleanupWindowControls = null;
		cleanupOverlay?.();
		cleanupOverlay = null;
		cleanupSystemLocale?.();
		cleanupSystemLocale = null;
		cleanupDiagBundle?.();
		cleanupDiagBundle = null;
		cleanupAbout?.();
		cleanupAbout = null;
		cleanupSoundLibrary?.();
		cleanupSoundLibrary = null;
		cleanupHistory?.();
		cleanupHistory = null;
		disposeGeneralSettingsWatcher?.();
		disposeGeneralSettingsWatcher = null;
		cleanupSettingsHandlers();
		disposeUpdaterSettingsWatcher?.();
		disposeUpdaterSettingsWatcher = null;
		if (autoUpdateCheckTimer) {
			clearInterval(autoUpdateCheckTimer);
			autoUpdateCheckTimer = null;
		}
		killSttProcess();
		sttClient.disconnect();
		detachTray();
		tray?.destroy();
		tray = null;
		if (overlayWindow && !overlayWindow.isDestroyed()) {
			overlayWindow.removeAllListeners();
			overlayWindow.destroy();
		}
		overlayWindow = null;
		clearSettingsFadeTimer();
		if (settingsWindow && !settingsWindow.isDestroyed()) {
			settingsWindow.removeAllListeners();
			settingsWindow.destroy();
		}
		settingsWindow = null;
	});
} else {
	app.quit();
}

// ── IPC handlers (registered once, not per window) ───────────────────
function setupGlobalIpcHandlers() {
	setupSettingsHandlers(sttClient);
	setupSttProcessHandlers();
	setupAutostartHandlers();
	setupSttCommandHandlers(sttClient);
	setupLoopbackHandlers(sttClient);
	cleanupWindowControls = setupWindowControlHandlers();
	setupDialogHandlers();
	cleanupOverlay = setupOverlayHandlers();
	cleanupTrayMenu = setupTrayMenuHandlers();
	cleanupModelPicker = setupModelPickerHandlers();
	cleanupDevicePicker = setupDevicePickerHandlers();
	cleanupLlm = setupLlm();
	cleanupCredentials = setupCredentials();
	cleanupCloudStt = setupCloudStt(sttClient);
	// Keep Ollama dictation/transforms models hot so the first dictation
	// after launch doesn't pay the cold-start penalty (~30s for a 7B model).
	cleanupLlmWarmup = setupLlmWarmup();
	cleanupOllamaRegistry = setupOllamaRegistry();
	cleanupTransforms = setupTransforms();
	cleanupTransformHotkeys = setupTransformHotkeys().dispose;
	cleanupTts = setupTts(sttClient);
	cleanupTtsHotkey = setupTtsHotkey(sttClient).dispose;
	cleanupRepasteHotkey = setupRepasteHotkey().dispose;
	cleanupAppMenu = setupAppMenuHandlers();
	cleanupContextMenu = setupContextMenuHandlers();
	cleanupClipboard = setupClipboardHandlers();
	cleanupUpdaterStatus = setupUpdaterStatusHandlers();
	cleanupSecureInvoke = setupSecureInvokeHandlers();
	cleanupSystemLocale = setupSystemLocaleHandler();
	cleanupDiagBundle = setupDiagBundleHandler();
	cleanupAbout = setupAboutHandlers();
	cleanupSoundLibrary = initSoundLibrary();
	// SQLite-backed transcription history (history.db + recordings/ under
	// userData). Honours the user's retention setting on an hourly sweeper
	// + at startup. Disposed in app.before-quit so the WAL flushes cleanly.
	cleanupHistory = setupHistoryIpc({
		getRetention: () => {
			const fromNewKey = getStoreValue("general.recordingRetentionPeriod");
			const period =
				typeof fromNewKey === "string" ? fromNewKey : getStoreValue("general.recordingRetention");
			if (
				period === "never" ||
				period === "preserveLimit" ||
				period === "cap" ||
				period === "days3" ||
				period === "weeks2" ||
				period === "months3"
			) {
				return period;
			}
			return "preserveLimit";
		},
		getLimit: () => {
			const fromNewKey = Number(getStoreValue("general.historyLimit"));
			if (Number.isFinite(fromNewKey) && fromNewKey > 0) {
				return Math.floor(fromNewKey);
			}
			const legacy = Number(getStoreValue("general.historyMaxEntries"));
			if (Number.isFinite(legacy) && legacy > 0) {
				return Math.floor(legacy);
			}
			return 5;
		},
	}).dispose;
}

function setupAppMenuHandlers(): () => void {
	const initialMenu = Menu.getApplicationMenu();
	return registerAppMenuIpcHandlers({
		ipcMain,
		menuController: {
			applyTemplate(template: AppMenuBuiltItem[]) {
				const menu = Menu.buildFromTemplate(template as MenuItemConstructorOptions[]);
				Menu.setApplicationMenu(menu);
			},
			reset() {
				Menu.setApplicationMenu(initialMenu ?? null);
			},
		},
		actionHandlers: {
			"show-main-window": () => {
				mainWindow?.show();
				mainWindow?.focus();
			},
			"hide-main-window": () => {
				mainWindow?.hide();
			},
			"open-settings": () => {
				openSettingsWindow();
			},
			"quit-app": () => {
				app.quit();
			},
		},
	});
}

function setupContextMenuHandlers(): () => void {
	const handler = createContextMenuIpcHandler({
		popup: ({ template, x, y, onClose }) => {
			const menu = Menu.buildFromTemplate(template);
			const targetWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
			const opts: Electron.PopupOptions = { callback: onClose };
			if (targetWindow) {
				opts.window = targetWindow;
			}
			if (x !== undefined) {
				opts.x = x;
			}
			if (y !== undefined) {
				opts.y = y;
			}
			menu.popup(opts);
		},
	});
	return registerContextMenuIpcHandler(ipcMain, IPC.CONTEXT_MENU_SHOW, handler);
}

function setupClipboardHandlers(): () => void {
	ipcMain.removeHandler(IPC.CLIPBOARD_OPERATE);
	ipcMain.handle(IPC.CLIPBOARD_OPERATE, createClipboardHandler(clipboard));
	return () => {
		ipcMain.removeHandler(IPC.CLIPBOARD_OPERATE);
	};
}

function setupUpdaterStatusHandlers(): () => void {
	ipcMain.removeHandler(IPC.UPDATER_GET_STATUS_HISTORY);
	ipcMain.removeHandler(IPC.UPDATER_CLEAR_STATUS_HISTORY);
	ipcMain.removeHandler(IPC.UPDATER_CHECK_NOW);
	ipcMain.removeHandler(IPC.UPDATER_QUIT_AND_INSTALL);

	ipcMain.handle(IPC.UPDATER_GET_STATUS_HISTORY, () => updaterStatusHistory.getHistory());
	ipcMain.handle(IPC.UPDATER_CLEAR_STATUS_HISTORY, () => {
		updaterStatusHistory.clear();
		return { cleared: true };
	});
	// On-demand check. Returns `{ triggered: boolean, reason?: string }` so the
	// renderer button can flip back to "Checked" after the user clicks; the
	// real status payload arrives asynchronously over `IPC.UPDATER_STATUS`
	// like every other update event.
	ipcMain.handle(IPC.UPDATER_CHECK_NOW, async () => {
		if (!autoUpdaterRef) {
			return { triggered: false, reason: "updater-unavailable" };
		}
		try {
			await autoUpdaterRef.checkForUpdatesAndNotify();
			return { triggered: true };
		} catch (error) {
			const message = toErrorMessage(error);
			dbg("updater", "Manual update check failed:", message);
			recordUpdaterStatus({ status: "error", message });
			return { triggered: false, reason: message };
		}
	});
	// Restart-to-install: defer the actual quit a tick so the IPC reply
	// reaches the renderer before Electron tears the BrowserWindow down.
	// Otherwise the renderer never sees the "triggered" ack and the button
	// stays spinning right up until the app dies.
	ipcMain.handle(IPC.UPDATER_QUIT_AND_INSTALL, () => {
		if (!autoUpdaterRef) {
			return { triggered: false, reason: "updater-unavailable" };
		}
		setImmediate(() => {
			try {
				// isSilent=false: NSIS shows its UI (no-op for portable target).
				// isForceRunAfter=true: relaunch after the swap completes.
				autoUpdaterRef?.quitAndInstall(false, true);
			} catch (error) {
				const message = toErrorMessage(error);
				dbg("updater", "quitAndInstall failed:", message);
				recordUpdaterStatus({ status: "error", message });
			}
		});
		return { triggered: true };
	});

	return () => {
		ipcMain.removeHandler(IPC.UPDATER_GET_STATUS_HISTORY);
		ipcMain.removeHandler(IPC.UPDATER_CLEAR_STATUS_HISTORY);
		ipcMain.removeHandler(IPC.UPDATER_CHECK_NOW);
		ipcMain.removeHandler(IPC.UPDATER_QUIT_AND_INSTALL);
	};
}

function setupSecureInvokeHandlers(): () => void {
	const secureHandlers: Record<
		SecureInvokeChannel,
		(event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown> | unknown
	> = {
		[IPC.CLIPBOARD_OPERATE]: (event, payload) => createClipboardHandler(clipboard)(event, payload),
		[IPC.UPDATER_GET_STATUS_HISTORY]: () => updaterStatusHistory.getHistory(),
		[IPC.UPDATER_CLEAR_STATUS_HISTORY]: () => {
			updaterStatusHistory.clear();
			return { cleared: true };
		},
	};

	ipcMain.removeHandler(IPC.SECURE_GET_KEY);
	ipcMain.handle(IPC.SECURE_GET_KEY, () => secureIpcKey.toString("base64url"));

	ipcMain.removeHandler(IPC.SECURE_INVOKE);
	ipcMain.handle(
		IPC.SECURE_INVOKE,
		async (event, encryptedRequest: EncryptedIpcPayload): Promise<EncryptedIpcPayload> => {
			try {
				const request = await decryptIpcPayload<SecureInvokeRequest>(
					encryptedRequest,
					secureIpcKey
				);
				const secureHandler = secureHandlers[request.channel];
				if (!secureHandler) {
					throw new Error(`Unsupported secure IPC channel: ${request.channel}`);
				}
				const result = await secureHandler(event, request.payload);
				const response: SecureInvokeResponse = { ok: true, result };
				return await encryptIpcPayload(response, secureIpcKey);
			} catch (error) {
				const response: SecureInvokeResponse = { ok: false, error: toErrorMessage(error) };
				return await encryptIpcPayload(response, secureIpcKey);
			}
		}
	);

	return () => {
		ipcMain.removeHandler(IPC.SECURE_GET_KEY);
		ipcMain.removeHandler(IPC.SECURE_INVOKE);
	};
}

function setupWindowControlHandlers(): () => void {
	const handleMinimize = () => mainWindow?.minimize();
	const handleMaximize = () => {
		if (mainWindow?.isMaximized()) {
			mainWindow.unmaximize();
		} else {
			mainWindow?.maximize();
		}
	};
	const handleClose = () => {
		mainWindow?.close();
	};
	const handleOpenSettings = () => openSettingsWindow();
	const handleCloseSelf = (event: Electron.IpcMainEvent) => {
		BrowserWindow.fromWebContents(event.sender)?.close();
	};
	const handleShow = () => {
		mainWindow?.show();
	};
	const handleQuit = () => {
		app.quit();
	};

	ipcMain.on("window:minimize", handleMinimize);
	ipcMain.on("window:maximize", handleMaximize);
	ipcMain.on("window:close", handleClose);
	ipcMain.on("window:open-settings", handleOpenSettings);
	ipcMain.on("window:close-self", handleCloseSelf);
	ipcMain.on("window:show", handleShow);
	ipcMain.on("window:quit", handleQuit);

	return () => {
		ipcMain.off("window:minimize", handleMinimize);
		ipcMain.off("window:maximize", handleMaximize);
		ipcMain.off("window:close", handleClose);
		ipcMain.off("window:open-settings", handleOpenSettings);
		ipcMain.off("window:close-self", handleCloseSelf);
		ipcMain.off("window:show", handleShow);
		ipcMain.off("window:quit", handleQuit);
	};
}

// ── Listen mode window adjustments ──────────────────────────────────
function applyListenModeWindow(win: BrowserWindow) {
	const mode = getStoreValue("general.recordingMode");
	const isListen = mode === "listen";
	win.setResizable(isListen);
	// Listen mode is a passive monitor the user reads while working in
	// another app, so pin the main window above other windows. Cleared
	// again when switching to any other mode (the main window is not
	// otherwise always-on-top — only the recording overlay pill is).
	win.setAlwaysOnTop(isListen);
	if (!isListen) {
		win.setSize(420, 150);
	}
}

// Minimum slice of the (resizable) main window kept on-screen after a
// drag — enough to grab the 32px titlebar and reach its window buttons.
const MAIN_WINDOW_MIN_VISIBLE_PX = 120;

// ── Keep a frameless window's draggable header reachable ───────────
// A frameless window can only be moved by its custom titlebar. If the
// user drags it so the header leaves the screen (e.g. above the top
// edge), there is no grab area left and the window is stranded. After
// each drag we snap it back into the work area of the display it mostly
// sits on, so the header stays reachable again.
//
// `minVisible` controls how aggressive the snap is:
//  - undefined → clamp the whole window inside the work area (good for
//    fixed-size modals like Settings).
//  - a number  → only guarantee that many pixels stay on-screen
//    horizontally, and that the top edge never goes above the work area
//    (good for resizable windows the user may want partly off-screen).
function keepWindowOnScreen(win: BrowserWindow, minVisible?: number): void {
	if (win.isDestroyed()) {
		return;
	}
	const { x, y, width, height } = win.getBounds();
	const { workArea } = screen.getDisplayMatching({ x, y, width, height });

	const visibleX = minVisible === undefined ? width : Math.min(minVisible, width);
	const visibleY = minVisible === undefined ? height : Math.min(minVisible, height);

	const minX = workArea.x - (width - visibleX);
	const maxX = workArea.x + workArea.width - visibleX;
	// The titlebar is at the top of the window, so the top edge must never
	// rise above the work area — that is the case that strands the window.
	const minY = workArea.y;
	const maxY = workArea.y + workArea.height - visibleY;

	const clampedX = Math.round(Math.min(Math.max(x, minX), maxX));
	const clampedY = Math.round(Math.min(Math.max(y, minY), maxY));

	if (clampedX !== x || clampedY !== y) {
		win.setPosition(clampedX, clampedY);
	}
}

// ── Settings window fade ───────────────────────────────────────────
// The window is pre-created hidden and reused, so a bare `show()` pops it
// in with no motion while the close (a real destroy request the OS dresses
// up) reads as animated. Mirror the model-picker pair: ease-out fade-in on
// open, ease-in fade-out before hide on close. Cubic so neither leg is the
// flagged "linear motion". The main process has no rAF, so opacity is
// tweened in ~16ms ticks.
const SETTINGS_FADE_MS = 150;
const SETTINGS_FADE_TICK_MS = 16;

const settingsEaseOut = (t: number): number => 1 - (1 - t) ** 3;
const settingsEaseIn = (t: number): number => t ** 3;

function clearSettingsFadeTimer(): void {
	if (settingsFadeTimer) {
		clearInterval(settingsFadeTimer);
	}
	settingsFadeTimer = null;
}

/** Time-based opacity tween. Cancels any in-flight fade first so a reopen
 *  mid-close (or vice-versa) picks up from the current opacity instead of
 *  snapping. `onComplete` only fires if the tween runs to the end — a
 *  superseding fade clears the timer and its callback never runs, so a
 *  reopen mid-close cancels the pending hide. */
function animateSettingsOpacity(
	win: BrowserWindow,
	to: number,
	easing: (t: number) => number,
	onComplete?: () => void
): void {
	clearSettingsFadeTimer();
	const from = win.getOpacity();
	if (from === to) {
		win.setOpacity(to);
		onComplete?.();
		return;
	}
	const start = Date.now();
	settingsFadeTimer = setInterval(() => {
		if (win.isDestroyed()) {
			clearSettingsFadeTimer();
			return;
		}
		const p = Math.min(1, (Date.now() - start) / SETTINGS_FADE_MS);
		win.setOpacity(from + (to - from) * easing(p));
		if (p >= 1) {
			win.setOpacity(to);
			clearSettingsFadeTimer();
			onComplete?.();
		}
	}, SETTINGS_FADE_TICK_MS);
}

// Blur-to-dismiss: a click anywhere outside settings (main window, desktop,
// another app) closes the panel — modal-style. Two guards keep it usable:
//  - `settingsSuppressBlurUntil` swallows the initial post-show blur race
//    (the click that *opened* settings sometimes trails after the show).
//  - The deferred re-check ignores blur when focus moved to one of our own
//    popup windows (model-picker, device-picker, tray-menu, …); those are
//    conceptually part of the settings UI and would otherwise dismiss it
//    the moment they steal focus.
const SETTINGS_BLUR_GUARD_MS = 200;
const SETTINGS_BLUR_SETTLE_MS = 50;
let settingsSuppressBlurUntil = 0;

function dismissSettingsWindow(): void {
	if (!settingsWindow || settingsWindow.isDestroyed() || !settingsWindow.isVisible()) {
		return;
	}
	const win = settingsWindow;
	animateSettingsOpacity(win, 0, settingsEaseIn, () => {
		if (!win.isDestroyed()) {
			win.hide();
		}
	});
}

function handleSettingsBlur(): void {
	if (Date.now() < settingsSuppressBlurUntil) {
		return;
	}
	// Focus transitions aren't synchronous on Windows — settle a tick before
	// asking who owns focus now.
	setTimeout(() => {
		if (!settingsWindow || settingsWindow.isDestroyed() || !settingsWindow.isVisible()) {
			return;
		}
		const focused = BrowserWindow.getFocusedWindow();
		// Focus left our app entirely (null) OR landed on the main window —
		// both mean "user clicked outside settings", so dismiss.
		// Anything else (model-picker, device-picker, tray-menu, …) is a
		// settings-adjacent popup; keep settings open under it.
		if (focused && focused !== mainWindow && focused !== settingsWindow) {
			return;
		}
		dismissSettingsWindow();
	}, SETTINGS_BLUR_SETTLE_MS);
}

// ── Settings window (pre-created hidden for instant open) ───────────
function createSettingsWindow(): BrowserWindow {
	const iconPath = getWindowIconPath();
	settingsWindow = new BrowserWindow({
		title: "WinSTT Settings",
		...(iconPath ? { icon: iconPath } : {}),
		width: 700,
		height: 560,
		resizable: false,
		frame: false,
		show: false,
		backgroundColor: "#09090b",
		webPreferences: sharedWebPreferences,
	});
	protectWindowNavigation(settingsWindow);

	const loadSettingsPromise = loadRendererPage(settingsWindow, "settings");
	loadSettingsPromise.catch((error) => {
		dbg("window", "Failed to load settings window:", toErrorMessage(error));
		if (settingsWindow && !settingsWindow.isDestroyed()) {
			settingsWindow.destroy();
		}
		settingsWindow = null;
	});

	// Hide instead of destroy on close — window is reused for instant re-open
	settingsWindow.on("close", (event) => {
		if (!isQuitting && settingsWindow) {
			event.preventDefault();
			dismissSettingsWindow();
		}
	});

	// Modal-style dismissal: clicking anywhere outside (main window, desktop,
	// another app) blurs settings → hide. See `handleSettingsBlur` for the
	// popup-window exemption.
	settingsWindow.on("blur", handleSettingsBlur);

	// If a drag left the draggable header off-screen, snap it back so the
	// titlebar (and its close/minimize buttons) stay reachable.
	settingsWindow.on("moved", () => {
		if (settingsWindow) {
			keepWindowOnScreen(settingsWindow);
		}
	});

	return settingsWindow;
}

function openSettingsWindow() {
	if (settingsWindow) {
		// Center relative to main window each time it's shown
		if (mainWindow) {
			const mainBounds = mainWindow.getBounds();
			const settingsBounds = settingsWindow.getBounds();
			settingsWindow.setPosition(
				Math.round(mainBounds.x + (mainBounds.width - settingsBounds.width) / 2),
				Math.round(mainBounds.y + (mainBounds.height - settingsBounds.height) / 2)
			);
		}
		// Start from transparent only when actually hidden — if it's still
		// visible (e.g. reopened mid close-fade) fade up from where it is so
		// there's no 0-opacity flash.
		if (!settingsWindow.isVisible()) {
			settingsWindow.setOpacity(0);
		}
		// Swallow any blur that fires during/right after show — the click
		// that opened settings can trail past show() and otherwise dismiss
		// the panel before the user sees it.
		settingsSuppressBlurUntil = Date.now() + SETTINGS_BLUR_GUARD_MS;
		settingsWindow.show();
		settingsWindow.focus();
		animateSettingsOpacity(settingsWindow, 1, settingsEaseOut);
		return;
	}
	// Fallback: recreate if somehow destroyed
	const newSettingsWindow = createSettingsWindow();
	newSettingsWindow.setOpacity(0);
	settingsSuppressBlurUntil = Date.now() + SETTINGS_BLUR_GUARD_MS;
	newSettingsWindow.show();
	animateSettingsOpacity(newSettingsWindow, 1, settingsEaseOut);
}

// ── Overlay window (pre-created hidden for instant show during recording) ───
function createOverlayWindow() {
	overlayWindow = new BrowserWindow({
		// 720×240: wide enough that the dynamic-island mode's `long` preset
		// (460px wide) still fits at the user's largest visualizerSize
		// (xl → 1.5× zoom → 690px). Floating-bottom mode is unaffected
		// — its content centers horizontally regardless of window width
		// and the window is click-through, so the extra transparent margin
		// is invisible.
		width: 720,
		height: 240,
		transparent: true,
		frame: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		show: false,
		// Critical for the dictation-paste pipeline: the pill MUST NOT accept
		// keyboard focus, or `showInactive()` lands focus on the overlay
		// BrowserWindow on some compositors and the paste goes to the pill
		// instead of the user's target app. Set at construction so the very
		// first paint of the pre-created hidden window already has the flag;
		// `setOverlayWindow` re-asserts this + the screen-saver z-order +
		// all-workspaces visibility at runtime (see overlay.ts).
		focusable: false,
		// On macOS, `type: "panel"` makes the BrowserWindow act like an
		// NSPanel (the primitive `tauri-nspanel` wraps in Handy's overlay.rs):
		// non-activating, stays above standard windows, doesn't show in
		// Mission Control or get a Dock entry. Electron 28+ added this
		// option; we require ^42.0.0 (see package.json). The option is a
		// no-op on Windows / Linux but we gate on platform for clarity.
		...(process.platform === "darwin" ? { type: "panel" as const } : {}),
		backgroundColor: "#00000000",
		// `backgroundThrottling: false` keeps the renderer painting normally
		// while the overlay BrowserWindow is hidden between PTT presses. With
		// the default (throttled to ~1fps), the renderer's post-terminal-event
		// "clear pill" paint never reaches the GPU / DWM compositor surface,
		// so DWM's cached frame for this window is whatever was last *visible*
		// — i.e. the previous session's pill with its transcription text.
		// On the next `showOverlay()`, DWM displays that cached surface for a
		// frame or two before the renderer's fresh paint replaces it, which
		// the user perceives as a brief flash of the old transcription. The
		// overlay is tiny and empty most of the time, so the extra paints are
		// cheap; the trade-off favours flash-free re-shows over CPU savings.
		webPreferences: { ...sharedWebPreferences, backgroundThrottling: false },
	});
	protectWindowNavigation(overlayWindow);

	const loadOverlayPromise = loadRendererPage(overlayWindow, "overlay");
	loadOverlayPromise.catch((error) => {
		dbg("window", "Failed to load overlay window:", toErrorMessage(error));
		if (overlayWindow && !overlayWindow.isDestroyed()) {
			overlayWindow.destroy();
		}
		overlayWindow = null;
	});

	// Click-through by default so dictation doesn't intercept clicks meant for
	// the app underneath. `forward: true` still delivers mousemove events to
	// the renderer (without consuming them) so hover-based hit detection on
	// the X cancel button works; the renderer flips ignore off via
	// `overlay:set-ignore-mouse` while the cursor sits over the button so the
	// click lands instead of falling through.
	overlayWindow.setIgnoreMouseEvents(true, { forward: true });

	// Hide instead of destroy on close — window is reused for instant re-show
	overlayWindow.on("close", (event) => {
		if (!isQuitting && overlayWindow) {
			event.preventDefault();
			overlayWindow.hide();
		}
	});

	// Store reference for overlay control module
	setOverlayWindow(overlayWindow);
}

// ── Window creation ──────────────────────────────────────────────────
function createWindow() {
	installCspHook();

	const iconPath = getWindowIconPath();
	mainWindow = new BrowserWindow({
		title: "WinSTT",
		...(iconPath ? { icon: iconPath } : {}),
		width: 420,
		height: 150,
		resizable: false,
		frame: false,
		show: false,
		backgroundColor: "#09090b",
		webPreferences: sharedWebPreferences,
	});
	protectWindowNavigation(mainWindow);

	// The pill is only a stand-in for the main window's transcription
	// surface — they must never both be on screen *while the main window is
	// focused*. Register the window so overlay.ts suppresses the pill on
	// focus, and react to focus/blur (plus hide/minimize, which also drop
	// focus) mid-session so the pill follows.
	setMainWindow(mainWindow);
	mainWindow.on("focus", syncOverlayToMainWindow);
	mainWindow.on("blur", syncOverlayToMainWindow);
	mainWindow.on("hide", syncOverlayToMainWindow);
	mainWindow.on("minimize", syncOverlayToMainWindow);

	// Intercept all close attempts — hide to tray instead of destroying.
	// Only allow actual destruction during app.quit() (isQuitting flag).
	// Settings is independent now; it dismisses itself on blur, so hiding
	// main doesn't need to cascade to it here.
	mainWindow.on("close", (event) => {
		if (!isQuitting) {
			const minimizeToTray = getStoreValue("general.minimizeToTray");
			if (minimizeToTray) {
				event.preventDefault();
				mainWindow?.hide();
				return;
			}
		}
	});

	// If a drag left the draggable header off-screen, snap it back so the
	// titlebar (and its close/minimize buttons) stay reachable. The main
	// window is resizable in listen mode, so keep only a minimum band
	// on-screen rather than forcing the whole window in.
	mainWindow.on("moved", () => {
		if (mainWindow) {
			keepWindowOnScreen(mainWindow, MAIN_WINDOW_MIN_VISIBLE_PX);
		}
	});

	// Use `did-finish-load` rather than `ready-to-show` as the renderer-ready
	// signal. In Vite dev, `ready-to-show` fires after the empty HTML shell
	// paints — before modules are compiled and React mounts — so showing then
	// surfaces a 5–10 s black window (the `backgroundColor`). `did-finish-load`
	// waits for the page + JS subresources to finish loading, which keeps the
	// window hidden until there's actually something to paint.
	mainWindow.webContents.once("did-finish-load", () => {
		dbg("window", "did-finish-load");
		const startMinimized = getStoreValue("general.startMinimized");
		if (startMinimized) {
			// User has opted in to tray-only launch: skip the show entirely
			// (no point waiting on server-ready when the window will stay hidden).
			return;
		}
		// Gate show() on the backend being fully READY (recorder initialized,
		// models loaded). The connection indicator otherwise flashes "offline"
		// for whatever portion of the 5–8 s server-warmup outlasts the
		// renderer's hydration window — users see a stale chip and assume the
		// backend is broken. Waiting until READY means the chip lands on
		// "GPU"/"CPU" on first paint.
		//
		// Hard fallback timeout: if the server fails to come up (broken
		// install, missing CUDA, etc.) we must NOT keep the window hidden
		// forever — the user would just see a blank taskbar entry. After
		// 15 s we show anyway so the user can at least see the error chip
		// and use the settings/diagnostics UI to investigate.
		const READY_TIMEOUT_MS = 15_000;
		let shown = false;
		const showOnce = (reason: string) => {
			if (shown || !mainWindow || mainWindow.isDestroyed()) {
				return;
			}
			shown = true;
			dbg("window", `showing main window (${reason})`);
			mainWindow.show();
			// Explicit focus — the onboarding window was just torn down and
			// Windows may otherwise hand focus to whichever app the user had
			// open behind it rather than to us.
			mainWindow.focus();
		};
		// Server may already be ready (parallel-warmup path) — don't wait.
		if (serverReadyFiredOnce) {
			showOnce("server-already-ready");
			return;
		}
		const onReady = () => showOnce("server-ready");
		sttClient.once("server-ready", onReady);
		const fallback = setTimeout(() => {
			sttClient.off("server-ready", onReady);
			showOnce("ready-timeout");
		}, READY_TIMEOUT_MS);
		// If the user closes the window before either fires, clear the
		// timer so we don't leak a setTimeout reference. Optional-chain
		// against the closure-captured `mainWindow` — the top-level `let`
		// can in principle be re-assigned before this callback runs.
		mainWindow?.once("closed", () => clearTimeout(fallback));
	});

	// Block DevTools in production
	if (!isDev) {
		mainWindow.webContents.on("before-input-event", (event, input) => {
			if (
				input.key === "F12" ||
				(input.control && input.shift && ["I", "J", "C"].includes(input.key))
			) {
				event.preventDefault();
			}
		});
	}

	// Capture renderer console output to debug.log
	mainWindow.webContents.on("console-message", ({ level, message, lineNumber, sourceId }) => {
		let tag: string;
		if (level === "info" || level === "debug") {
			tag = "renderer:log";
		} else if (level === "warning") {
			tag = "renderer:warn";
		} else {
			tag = "renderer:error";
		}
		const src = sourceId ? ` (${sourceId}:${lineNumber})` : "";
		dbg(tag, message + src);
	});

	// Load content
	dbg("window", "Loading content, isDev=", isDev);
	const loadMainPromise = loadRendererPage(mainWindow, "main");
	loadMainPromise.catch((error) => {
		dbg("window", "Failed to load main window:", toErrorMessage(error));
		app.quit();
	});

	// Register sound IPC (renderer fetches WAV data and plays via Web Audio API)
	initSound(mainWindow);

	// Window-specific setup (per window, cleaned up on close)
	cleanupWindowTelemetry?.();
	cleanupWindowTelemetry = registerWindowTelemetry(mainWindow, (payload) => {
		mainWindow?.webContents.send(IPC.WINDOW_TELEMETRY, payload);
	});

	cleanupHotkeys = setupHotkeyHandlers(mainWindow, sttClient, {
		onCombo: (action) => handleHotkeyCombo(action, sttClient),
	});

	// Setup file transcription
	const { cleanup: fileTranscribeCleanup } = setupFileTranscribeHandlers(mainWindow, sttClient);
	cleanupFileTranscribe = fileTranscribeCleanup;

	// Setup tray with custom menu window. The tray-state controller manages
	// the native context menu (state label + open/settings/quit + reserved
	// history submenu) — `openSettings` routes its Settings item to the
	// same pre-created BrowserWindow the renderer uses.
	const newTray = setupTray(mainWindow, {
		openSettings: () => openSettingsWindow(),
	});
	tray = newTray;
	// Pass the module-level cache of pre-window events so the relay's IPC
	// handlers (STT_GET_SERVER_READY / STT_GET_RUNTIME_INFO) answer correctly
	// even when the onboarding wizard delayed window creation past the
	// server's warm-up. See `serverReadyFiredOnce` / `lastRuntimeInfo` above.
	cleanupRelay = setupRelay(mainWindow, sttClient, {
		serverReady: serverReadyFiredOnce,
		runtimeInfo: lastRuntimeInfo,
	});

	// Initialize recording indicator (tray + taskbar overlay icons)
	if (iconPath) {
		initRecordingIndicator(newTray, mainWindow, iconPath);
	}

	// Toggle window resizable when recording mode changes to/from listen
	applyListenModeWindow(mainWindow);
	disposeGeneralSettingsWatcher?.();
	disposeGeneralSettingsWatcher = store.onDidChange("general", () => {
		if (mainWindow) {
			applyListenModeWindow(mainWindow);
		}
	});

	// STT server auto-spawn + WS client connect both happen in the
	// `app.whenReady()` block above, BEFORE this function runs. By the
	// time createWindow is reached the recorder is typically already
	// loading models in the background.

	mainWindow.on("closed", () => {
		cleanupHotkeys?.();
		cleanupRelay?.();
		cleanupFileTranscribe?.();
		cleanupWindowTelemetry?.();
		disposeGeneralSettingsWatcher?.();
		disposeGeneralSettingsWatcher = null;
		cleanupHotkeys = null;
		cleanupRelay = null;
		cleanupFileTranscribe = null;
		cleanupWindowTelemetry = null;
		setMainWindow(null);
		mainWindow = null;
		// Main window destroyed (not hidden to tray) — quit the app.
		// This triggers before-quit → isQuitting=true → settings window close passes through.
		if (!isQuitting) {
			app.quit();
		}
	});

	// Pre-create hidden settings window so opening it is instant
	createSettingsWindow();

	// Pre-create hidden overlay window for instant display during recording
	createOverlayWindow();

	// E2E test hooks. Only wired up when WINSTT_E2E=1 — the env var is set
	// by Playwright when launching the binary, and absent in normal dev /
	// production runs. Exposing showOverlay/hideOverlay lets the E2E suite
	// drive the pill directly instead of having to spin up the STT server
	// and synthesize WebSocket events.
	if (process.env.WINSTT_E2E === "1") {
		const e2e = globalThis as unknown as {
			__winsttE2E__?: {
				showOverlay: () => void;
				hideOverlay: () => void;
				isOverlayVisible: () => boolean;
				simulateHotkeyPress: () => void;
				simulateRecordingStop: () => void;
				// Focus-pass-through introspection — the overlay BrowserWindow
				// MUST NOT accept keyboard focus, or the dictation paste lands
				// in the pill instead of the user's target app. Exposing the
				// flag lets Playwright assert the NSPanel-imitation hardening
				// (see overlay.ts `applyFocusPassThroughFlags`).
				isOverlayFocusable: () => boolean;
				isOverlayAlwaysOnTop: () => boolean;
			};
		};
		// Lazy-import to avoid pulling these into the production bundle
		// when WINSTT_E2E is unset.
		const { notifyHotkeyPressed, notifyRecordingStop } = require("./lib/recording-state") as {
			notifyHotkeyPressed: () => void;
			notifyRecordingStop: () => void;
		};
		e2e.__winsttE2E__ = {
			showOverlay,
			hideOverlay,
			isOverlayVisible: () => overlayWindow?.isVisible() ?? false,
			// Simulate a hotkey press from the test harness — feeds the
			// recording-state intent flag the same way uiohook would.
			simulateHotkeyPress: () => notifyHotkeyPressed(),
			// Simulate a server `recording_stop` — clears the intent flag
			// so subsequent stray `recording_start` events get rejected.
			simulateRecordingStop: () => notifyRecordingStop(),
			isOverlayFocusable: () => overlayWindow?.isFocusable() ?? true,
			isOverlayAlwaysOnTop: () => overlayWindow?.isAlwaysOnTop() ?? false,
		};
	}
}
