import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import {
	app,
	BrowserWindow,
	clipboard,
	type IpcMainInvokeEvent,
	ipcMain,
	Menu,
	type MenuItemConstructorOptions,
	session,
	shell,
	type Tray,
} from "electron";
import log from "electron-log/main";
import { IPC } from "../src/shared/api/ipc-channels";
import { registerAppMenuIpcHandlers } from "./ipc/app-menu-ipc";
import type { AppMenuBuiltItem } from "./ipc/app-menu-template";
import { flushMutePending, unmuteSystemAudio } from "./ipc/audio-mute";
import { setupAutostartHandlers } from "./ipc/autostart";
import { createClipboardHandler } from "./ipc/clipboard";
import {
	createContextMenuIpcHandler,
	registerContextMenuIpcHandler,
} from "./ipc/context-menu-handler";
import { setupDiagBundleHandler } from "./ipc/diag-bundle";
import { setupDialogHandlers } from "./ipc/dialog";
import { setupFileTranscribeHandlers } from "./ipc/file-transcribe";
import { type HotkeyComboAction, setupHotkeyHandlers } from "./ipc/hotkey";
import {
	decryptIpcPayload,
	type EncryptedIpcPayload,
	encryptIpcPayload,
	generateIpcPayloadKey,
} from "./ipc/ipc-payload-crypto";
import { setupLlm, setupLlmWarmup } from "./ipc/llm";
import { setupLoopbackHandlers } from "./ipc/loopback";
import { setupOllamaRegistry } from "./ipc/ollama-registry";
import { hideOverlay, setOverlayWindow, setupOverlayHandlers, showOverlay } from "./ipc/overlay";
import { setupRelay } from "./ipc/relay";
import {
	applyMainProcessSettingsPatch,
	cleanupSettingsHandlers,
	setupSettingsHandlers,
} from "./ipc/settings";
import { handleAbortOperation, setupSttCommandHandlers } from "./ipc/stt-commands";
import { killSttProcess, setupSttProcessHandlers, tryAutoSpawnServer } from "./ipc/stt-process";
import { setupSystemLocaleHandler } from "./ipc/system-locale";
import { setupTransformHotkeys } from "./ipc/transform-hotkeys";
import { setupTransforms } from "./ipc/transforms";
import { setupTray } from "./ipc/tray";
import { setupTrayMenuHandlers } from "./ipc/tray-menu-window";
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
let overlayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let cleanupRelay: (() => void) | null = null;
let cleanupHotkeys: (() => void) | null = null;
let cleanupFileTranscribe: (() => void) | null = null;
let cleanupLlm: (() => void) | null = null;
let cleanupLlmWarmup: (() => void) | null = null;
let cleanupOllamaRegistry: (() => void) | null = null;
let cleanupTransforms: (() => void) | null = null;
let cleanupTransformHotkeys: (() => void) | null = null;
let cleanupTts: (() => void) | null = null;
let cleanupTtsHotkey: (() => void) | null = null;
let cleanupTrayMenu: (() => void) | null = null;
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
let cleanupSoundLibrary: (() => void) | null = null;
let autoUpdateCheckTimer: ReturnType<typeof setInterval> | null = null;
let rendererServerProcess: ChildProcess | null = null;
let rendererBaseUrl = process.env.WINSTT_RENDERER_BASE_URL ?? "http://localhost:3000";
const TRAILING_SLASHES_REGEX = /\/+$/;
const secureIpcKey = generateIpcPayloadKey();
const updaterStatusHistory = createUpdaterStatusHistory({ maxEntries: 200 });
const sttClient = new SttClient();
const isDev = !app.isPackaged;

/** Shared webPreferences for all BrowserWindows (sandbox + context isolation). */
const sharedWebPreferences: Electron.WebPreferences = {
	preload: path.join(import.meta.dirname, "preload.cjs"),
	contextIsolation: true,
	nodeIntegration: false,
	sandbox: true,
};

/** Set to true during app.quit() so the main window close handler allows actual destruction. */
let isQuitting = false;
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

function setRendererBaseUrl(baseUrl: string): void {
	rendererBaseUrl = baseUrl.replace(TRAILING_SLASHES_REGEX, "");
	process.env.WINSTT_RENDERER_BASE_URL = rendererBaseUrl;
}

function getRendererBaseUrl(): string {
	return rendererBaseUrl;
}

function getRendererRouteUrl(route: string): string {
	const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
	return new URL(normalizedRoute, `${getRendererBaseUrl()}/`).toString();
}

function isRendererOrigin(url: string): boolean {
	try {
		return new URL(url).origin === new URL(getRendererBaseUrl()).origin;
	} catch {
		return false;
	}
}

function getStandaloneServerEntryPath(): string {
	const appRoot = app.isPackaged
		? path.join(process.resourcesPath, "app.asar.unpacked")
		: path.join(import.meta.dirname, "..");
	return path.join(appRoot, "out", "standalone", "server.js");
}

function getAvailablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Failed to allocate a local TCP port"));
				return;
			}
			server.close((closeError) => {
				if (closeError) {
					reject(closeError);
					return;
				}
				resolve(address.port);
			});
		});
	});
}

async function waitForRendererServer(baseUrl: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;

	while (Date.now() < deadline) {
		try {
			// react-doctor-disable-next-line async-await-in-loop
			const response = await fetch(`${baseUrl}/settings`);
			if (response.ok) {
				return;
			}
			lastError = new Error(`status=${response.status}`);
		} catch (error) {
			lastError = error;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 200));
	}

	throw new Error(
		`Timed out waiting for bundled renderer server at ${baseUrl} (${toErrorMessage(lastError)})`
	);
}

async function startBundledRendererServer(): Promise<string> {
	const serverEntryPath = getStandaloneServerEntryPath();
	if (!existsSync(serverEntryPath)) {
		throw new Error(`Bundled renderer server not found: ${serverEntryPath}`);
	}

	const host = "127.0.0.1";
	const port = await getAvailablePort();
	const baseUrl = `http://${host}:${port}`;

	const child = spawn(process.execPath, [serverEntryPath], {
		cwd: path.dirname(serverEntryPath),
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			HOSTNAME: host,
			NODE_ENV: "production",
			PORT: String(port),
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});

	rendererServerProcess = child;
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		const message = chunk.trim();
		if (message) {
			dbg("renderer-server", message);
		}
	});
	child.stderr?.on("data", (chunk: string) => {
		const message = chunk.trim();
		if (message) {
			dbg("renderer-server", message);
		}
	});
	child.once("exit", (code, signal) => {
		dbg("renderer-server", `Exited (code=${String(code)}, signal=${String(signal)})`);
		if (rendererServerProcess === child) {
			rendererServerProcess = null;
		}
	});

	try {
		await waitForRendererServer(baseUrl);
		return baseUrl;
	} catch (error) {
		child.kill();
		if (rendererServerProcess === child) {
			rendererServerProcess = null;
		}
		throw error;
	}
}

function isAllowedNavigation(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (isRendererOrigin(url)) {
			return true;
		}
		return parsed.protocol === "file:";
	} catch {
		return false;
	}
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
		// `sentry-ipc:` is the custom protocol that @sentry/electron's renderer SDK
		// uses to talk to the main-process SDK (scope sync, event forwarding). The
		// scheme is registered as a privileged protocol handler in main; it never
		// touches the network. Must be in connect-src for both dev and prod, even
		// when SENTRY_DSN is unset, because the renderer init runs unconditionally.
		const csp = isDev
			? "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' sentry-ipc: ws://localhost:* http://localhost:* http://127.0.0.1:*; font-src 'self' http://localhost:* https://cdn.jsdelivr.net data:; img-src 'self' data:"
			: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' sentry-ipc:; font-src 'self'; img-src 'self' data:";
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
		const updaterModule = (await import("electron-updater")) as {
			autoUpdater: {
				autoDownload: boolean;
				on: (event: string, listener: (...args: unknown[]) => void) => void;
				checkForUpdatesAndNotify: () => Promise<unknown>;
			};
		};
		const { autoUpdater } = updaterModule;

		const getUpdateVersion = (payload: unknown): string => {
			if (typeof payload === "object" && payload !== null && "version" in payload) {
				return String((payload as { version: unknown }).version);
			}
			return "unknown";
		};

		autoUpdater.autoDownload = true;
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
// false, `initSentryMain` is a no-op and the renderer skips its own init too
// (the flag is forwarded via the renderer URL query string, see
// `getRendererRouteUrl`).
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

// Suppress Electron's CSP security warning in dev (Next.js HMR requires unsafe-eval)
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
// between test runs).
if (process.env.WINSTT_E2E === "1") {
	const e2eUserData = path.join(app.getPath("temp"), `winstt-e2e-${process.pid}`);
	app.setPath("userData", e2eUserData);
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
	app
		.whenReady()
		.then(async () => {
			// Encrypt any legacy plaintext secrets persisted before this version.
			// Must run before any IPC handler that ships settings to the renderer.
			migrateSecretsAtRest();
			const baseUrl = isDev
				? (process.env.WINSTT_RENDERER_BASE_URL ?? "http://localhost:3000")
				: await startBundledRendererServer();
			setRendererBaseUrl(baseUrl);
			setupGlobalIpcHandlers();
			createWindow();
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
		cleanupLlm?.();
		cleanupLlm = null;
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
		cleanupSoundLibrary?.();
		cleanupSoundLibrary = null;
		disposeGeneralSettingsWatcher?.();
		disposeGeneralSettingsWatcher = null;
		cleanupSettingsHandlers();
		if (autoUpdateCheckTimer) {
			clearInterval(autoUpdateCheckTimer);
			autoUpdateCheckTimer = null;
		}
		rendererServerProcess?.kill();
		rendererServerProcess = null;
		killSttProcess();
		sttClient.disconnect();
		tray?.destroy();
		tray = null;
		if (overlayWindow && !overlayWindow.isDestroyed()) {
			overlayWindow.removeAllListeners();
			overlayWindow.destroy();
		}
		overlayWindow = null;
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
	cleanupLlm = setupLlm();
	// Keep Ollama dictation/transforms models hot so the first dictation
	// after launch doesn't pay the cold-start penalty (~30s for a 7B model).
	cleanupLlmWarmup = setupLlmWarmup();
	cleanupOllamaRegistry = setupOllamaRegistry();
	cleanupTransforms = setupTransforms();
	cleanupTransformHotkeys = setupTransformHotkeys().dispose;
	cleanupTts = setupTts(sttClient);
	cleanupTtsHotkey = setupTtsHotkey(sttClient).dispose;
	cleanupAppMenu = setupAppMenuHandlers();
	cleanupContextMenu = setupContextMenuHandlers();
	cleanupClipboard = setupClipboardHandlers();
	cleanupUpdaterStatus = setupUpdaterStatusHandlers();
	cleanupSecureInvoke = setupSecureInvokeHandlers();
	cleanupSystemLocale = setupSystemLocaleHandler();
	cleanupDiagBundle = setupDiagBundleHandler();
	cleanupSoundLibrary = initSoundLibrary();
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
			menu.popup({
				window: targetWindow,
				x,
				y,
				callback: onClose,
			});
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

	ipcMain.handle(IPC.UPDATER_GET_STATUS_HISTORY, () => updaterStatusHistory.getHistory());
	ipcMain.handle(IPC.UPDATER_CLEAR_STATUS_HISTORY, () => {
		updaterStatusHistory.clear();
		return { cleared: true };
	});

	return () => {
		ipcMain.removeHandler(IPC.UPDATER_GET_STATUS_HISTORY);
		ipcMain.removeHandler(IPC.UPDATER_CLEAR_STATUS_HISTORY);
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
	if (!isListen) {
		win.setSize(420, 150);
	}
}

// ── Settings window (pre-created hidden for instant open) ───────────
function createSettingsWindow(): BrowserWindow {
	const iconPath = getWindowIconPath();
	settingsWindow = new BrowserWindow({
		title: "WinSTT Settings",
		...(iconPath ? { icon: iconPath } : {}),
		...(mainWindow ? { parent: mainWindow, modal: true } : {}),
		width: 700,
		height: 560,
		resizable: false,
		frame: false,
		show: false,
		backgroundColor: "#09090b",
		webPreferences: sharedWebPreferences,
	});
	protectWindowNavigation(settingsWindow);

	const loadSettingsPromise = settingsWindow.loadURL(getRendererRouteUrl("/settings"));
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
			settingsWindow.hide();
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
		settingsWindow.show();
		settingsWindow.focus();
		return;
	}
	// Fallback: recreate if somehow destroyed
	const newSettingsWindow = createSettingsWindow();
	newSettingsWindow.show();
}

// ── Overlay window (pre-created hidden for instant show during recording) ───
function createOverlayWindow() {
	overlayWindow = new BrowserWindow({
		width: 520,
		height: 240,
		transparent: true,
		frame: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		show: false,
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

	const loadOverlayPromise = overlayWindow.loadURL(getRendererRouteUrl("/overlay"));
	loadOverlayPromise.catch((error) => {
		dbg("window", "Failed to load overlay window:", toErrorMessage(error));
		if (overlayWindow && !overlayWindow.isDestroyed()) {
			overlayWindow.destroy();
		}
		overlayWindow = null;
	});

	// Make window click-through (user can interact with apps beneath it)
	overlayWindow.setIgnoreMouseEvents(true);

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

	// Intercept all close attempts — hide to tray instead of destroying.
	// Only allow actual destruction during app.quit() (isQuitting flag).
	mainWindow.on("close", (event) => {
		if (!isQuitting) {
			const minimizeToTray = getStoreValue("general.minimizeToTray");
			if (minimizeToTray) {
				event.preventDefault();
				if (settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.isVisible()) {
					settingsWindow.hide();
				}
				mainWindow?.hide();
				return;
			}
		}
	});

	mainWindow.once("ready-to-show", () => {
		dbg("window", "ready-to-show");
		const startMinimized = getStoreValue("general.startMinimized");
		if (!startMinimized) {
			mainWindow?.show();
		}
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
	const loadMainPromise = mainWindow.loadURL(getRendererRouteUrl("/"));
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

	// Setup tray with custom menu window
	const newTray = setupTray(mainWindow);
	tray = newTray;
	cleanupRelay = setupRelay(mainWindow, sttClient);

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

	// Auto-spawn the STT server (production: bundled exe, dev: requires STT_SERVER_DIR env var).
	// Skipped for E2E runs that only test pure-IPC behaviours like the overlay pill —
	// avoids a slow / fragile dependency on the Python server during Playwright tests.
	if (process.env.WINSTT_E2E_SKIP_STT !== "1") {
		tryAutoSpawnServer();
	}

	// Auto-connect to STT server (reconnects with exponential backoff if not yet running)
	dbg("stt-client", "Connecting to STT server...");
	sttClient.connect().catch(() => {
		dbg("stt-client", "Initial connect failed — will retry via reconnection");
	});

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
		};
	}
}
