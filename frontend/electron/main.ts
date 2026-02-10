import path from "node:path";
import { app, BrowserWindow, ipcMain, session, shell, type Tray } from "electron";

import { setupAudioMuteHandlers } from "./ipc/audio-mute";
import { setupAutostartHandlers } from "./ipc/autostart";
import { setupDialogHandlers } from "./ipc/dialog";
import { setupFileTranscribeHandlers } from "./ipc/file-transcribe";
import { setupHotkeyHandlers } from "./ipc/hotkey";
import { setupLoopbackHandlers } from "./ipc/loopback";
import { setupRelay } from "./ipc/relay";
import { setupSettingsHandlers } from "./ipc/settings";
import { setupSttCommandHandlers } from "./ipc/stt-commands";
import { killSttProcess, setupSttProcessHandlers, tryAutoSpawnServer } from "./ipc/stt-process";
import { setupTray } from "./ipc/tray";
import { dbg } from "./lib/debug-log";
import { store } from "./lib/store";
import { SttClient } from "./ws/stt-client";

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let cleanupRelay: (() => void) | null = null;
let cleanupHotkeys: (() => void) | null = null;
let cleanupFileTranscribe: (() => void) | null = null;
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

// Prevent unhandled "error" events on EventEmitter from crashing the app with dialog windows.
// WebSocket connection failures during reconnection emit "error" — just log them.
sttClient.on("error", (err: unknown) => {
	const msg =
		err instanceof Error
			? err.message
			: typeof err === "object" && err !== null && "message" in err
				? String((err as { message: unknown }).message)
				: String(err);
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
	app.whenReady().then(async () => {
		// Clear stale HTTP cache (prevents cached 308 redirect loops)
		await session.defaultSession.clearCache();
		setupGlobalIpcHandlers();
		createWindow();
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
	app.on("before-quit", () => {
		isQuitting = true;
		killSttProcess();
		sttClient.disconnect();
		tray?.destroy();
		tray = null;
	});
} else {
	app.quit();
}

// ── IPC handlers (registered once, not per window) ───────────────────
function setupGlobalIpcHandlers() {
	setupSettingsHandlers(sttClient);
	setupSttProcessHandlers();
	setupAutostartHandlers();
	setupAudioMuteHandlers();
	setupSttCommandHandlers(sttClient);
	setupLoopbackHandlers(sttClient);
	setupWindowControlHandlers();
	setupDialogHandlers();
}

function setupWindowControlHandlers() {
	ipcMain.on("window:minimize", () => mainWindow?.minimize());
	ipcMain.on("window:maximize", () => {
		if (mainWindow?.isMaximized()) {
			mainWindow.unmaximize();
		} else {
			mainWindow?.maximize();
		}
	});
	ipcMain.on("window:close", () => {
		mainWindow?.close();
	});
	ipcMain.on("window:open-settings", () => openSettingsWindow());
	ipcMain.on("window:close-self", (event) => {
		BrowserWindow.fromWebContents(event.sender)?.close();
	});
}

// ── Listen mode window adjustments ──────────────────────────────────
function applyListenModeWindow(win: BrowserWindow) {
	const mode = store.get("general.recordingMode") as string;
	const isListen = mode === "listen";
	win.setResizable(isListen);
	if (!isListen) {
		win.setSize(420, 150);
	}
}

// ── Settings window (pre-created hidden for instant open) ───────────
function createSettingsWindow() {
	settingsWindow = new BrowserWindow({
		title: "WinSTT Settings",
		icon: path.join(import.meta.dirname, "..", "build", "icon.ico"),
		width: 700,
		height: 560,
		resizable: false,
		frame: false,
		show: false,
		backgroundColor: "#09090b",
		webPreferences: sharedWebPreferences,
	});

	if (isDev) {
		settingsWindow.loadURL("http://localhost:3000/settings");
	} else {
		settingsWindow.loadFile(path.join(import.meta.dirname, "../out/settings.html"));
	}

	// Hide instead of destroy on close — window is reused for instant re-open
	settingsWindow.on("close", (event) => {
		if (!isQuitting && settingsWindow) {
			event.preventDefault();
			settingsWindow.hide();
		}
	});
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
	createSettingsWindow();
	settingsWindow!.show();
}

// ── Window creation ──────────────────────────────────────────────────
function createWindow() {
	// Content Security Policy
	session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
		const csp = isDev
			? "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* http://localhost:* http://127.0.0.1:*; font-src 'self' http://localhost:* https://cdn.jsdelivr.net data:; img-src 'self' data:"
			: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; img-src 'self' data:";
		callback({
			responseHeaders: {
				...details.responseHeaders,
				"Content-Security-Policy": [csp],
			},
		});
	});

	mainWindow = new BrowserWindow({
		title: "WinSTT",
		icon: path.join(import.meta.dirname, "..", "build", "icon.ico"),
		width: 420,
		height: 150,
		resizable: false,
		frame: false,
		show: false,
		backgroundColor: "#09090b",
		webPreferences: sharedWebPreferences,
	});

	// Intercept all close attempts — hide to tray instead of destroying.
	// Only allow actual destruction during app.quit() (isQuitting flag).
	mainWindow.on("close", (event) => {
		if (!isQuitting) {
			const minimizeToTray = store.get("general.minimizeToTray") as boolean;
			if (minimizeToTray) {
				event.preventDefault();
				mainWindow?.hide();
				return;
			}
		}
	});

	mainWindow.once("ready-to-show", () => {
		dbg("window", "ready-to-show");
		const startMinimized = store.get("general.startMinimized") as boolean;
		if (!startMinimized) {
			mainWindow?.show();
		}
	});

	// Navigation protection — prevent renderer from navigating to untrusted URLs
	mainWindow.webContents.on("will-navigate", (event, url) => {
		const parsed = new URL(url);
		if (isDev && parsed.origin === "http://localhost:3000") {
			return;
		}
		if (parsed.protocol === "file:") {
			return;
		}
		event.preventDefault();
	});

	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		// Open external links in the default browser
		if (url.startsWith("https://") || url.startsWith("http://")) {
			shell.openExternal(url);
		}
		return { action: "deny" };
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
	mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
		const tag = level <= 0 ? "renderer:log" : level === 1 ? "renderer:warn" : "renderer:error";
		const src = sourceId ? ` (${sourceId}:${line})` : "";
		dbg(tag, message + src);
	});

	// Load content
	dbg("window", "Loading content, isDev=", isDev);
	if (isDev) {
		mainWindow.loadURL("http://localhost:3000");
		mainWindow.webContents.openDevTools({ mode: "detach" });
	} else {
		mainWindow.loadFile(path.join(import.meta.dirname, "../out/index.html"));
	}

	// Window-specific setup (per window, cleaned up on close)
	cleanupHotkeys = setupHotkeyHandlers(mainWindow);
	let rebuildTrayMenu: (() => void) | undefined;
	({ tray, rebuildTrayMenu } = setupTray(mainWindow, openSettingsWindow, sttClient));
	cleanupRelay = setupRelay(mainWindow, sttClient);
	cleanupFileTranscribe = setupFileTranscribeHandlers(mainWindow, sttClient);

	// Toggle window resizable when recording mode changes to/from listen
	applyListenModeWindow(mainWindow);
	store.onDidChange("general" as never, () => {
		if (mainWindow) {
			applyListenModeWindow(mainWindow);
		}
		rebuildTrayMenu?.();
	});

	// Auto-spawn the STT server (production: bundled exe, dev: requires STT_SERVER_DIR env var)
	tryAutoSpawnServer();

	// Auto-connect to STT server (reconnects with exponential backoff if not yet running)
	dbg("stt-client", "Connecting to STT server...");
	sttClient.connect().catch(() => {
		dbg("stt-client", "Initial connect failed — will retry via reconnection");
	});

	mainWindow.on("closed", () => {
		cleanupHotkeys?.();
		cleanupRelay?.();
		cleanupFileTranscribe?.();
		cleanupHotkeys = null;
		cleanupRelay = null;
		cleanupFileTranscribe = null;
		mainWindow = null;
		// Main window destroyed (not hidden to tray) — quit the app.
		// This triggers before-quit → isQuitting=true → settings window close passes through.
		if (!isQuitting) {
			app.quit();
		}
	});

	// Pre-create hidden settings window so opening it is instant
	createSettingsWindow();
}
