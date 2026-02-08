import path from "node:path";
import { app, BrowserWindow, ipcMain, session, shell, type Tray } from "electron";

import { setupAudioMuteHandlers } from "./ipc/audio-mute";
import { setupAutostartHandlers } from "./ipc/autostart";
import { setupHotkeyHandlers } from "./ipc/hotkey";
import { setupRelay } from "./ipc/relay";
import { setupSettingsHandlers } from "./ipc/settings";
import { killSttProcess, setupSttProcessHandlers } from "./ipc/stt-process";
import { setupTray } from "./ipc/tray";
import { store } from "./lib/store";
import { SttClient } from "./ws/stt-client";

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let cleanupRelay: (() => void) | null = null;
let cleanupHotkeys: (() => void) | null = null;
const sttClient = new SttClient();
const isDev = !app.isPackaged;

// Prevent unhandled "error" events on EventEmitter from crashing the app with dialog windows.
// WebSocket connection failures during reconnection emit "error" — just log them.
sttClient.on("error", (err: unknown) => {
	console.warn("[stt-client] Connection error (server may be offline):", String(err));
});

// Suppress Electron's CSP security warning in dev (Next.js HMR requires unsafe-eval)
if (isDev) {
	process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
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
	app.whenReady().then(() => {
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
	setupSettingsHandlers();
	setupSttProcessHandlers();
	setupAutostartHandlers();
	setupAudioMuteHandlers();
	setupSttCommandHandlers();
	setupWindowControlHandlers();
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
		if (!mainWindow) {
			return;
		}
		const minimizeToTray = store.get("general.minimizeToTray") as boolean;
		if (minimizeToTray) {
			mainWindow.hide();
		} else {
			mainWindow.close();
		}
	});
	ipcMain.on("window:open-settings", () => openSettingsWindow());
	ipcMain.on("window:close-self", (event) => {
		BrowserWindow.fromWebContents(event.sender)?.close();
	});
}

/** Proxy STT commands from renderer to the WebSocket control channel */
function setupSttCommandHandlers() {
	ipcMain.on("stt:set-parameter", (_event, payload: { parameter: string; value: unknown }) => {
		if (!sttClient.isConnected) {
			return;
		}
		sttClient.setParameter(payload.parameter, payload.value);
	});

	ipcMain.handle("stt:is-connected", () => sttClient.isConnected);

	ipcMain.handle("stt:get-parameter", (_event, payload: { parameter: string }) => {
		if (!sttClient.isConnected) {
			return Promise.reject(new Error("STT client is not connected"));
		}
		return sttClient.getParameter(payload.parameter);
	});

	ipcMain.on("stt:call-method", (_event, payload: { method: string; args?: unknown[] }) => {
		if (!sttClient.isConnected) {
			return;
		}
		sttClient.callMethod(payload.method, payload.args);
	});

	ipcMain.handle("gpu:get-info", async () => {
		try {
			const { execSync } = await import("node:child_process");
			const output = execSync("nvidia-smi --query-gpu=name --format=csv,noheader,nounits", {
				encoding: "utf8",
				timeout: 5000,
				windowsHide: true,
			}).trim();
			const name = output.split("\n")[0]?.trim() ?? "NVIDIA GPU";
			return { name, available: true };
		} catch {
			return { name: "No NVIDIA GPU", available: false };
		}
	});

	ipcMain.handle("audio:get-devices", () => {
		return [];
	});
}

// ── Settings window ─────────────────────────────────────────────────
function openSettingsWindow() {
	if (settingsWindow) {
		settingsWindow.focus();
		return;
	}

	settingsWindow = new BrowserWindow({
		title: "WinSTT Settings",
		icon: path.join(import.meta.dirname, "..", "build", "icon.ico"),
		parent: mainWindow ?? undefined,
		width: 700,
		height: 560,
		minWidth: 560,
		minHeight: 420,
		frame: false,
		backgroundColor: "#09090b",
		webPreferences: {
			preload: path.join(import.meta.dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	if (isDev) {
		settingsWindow.loadURL("http://localhost:3000/settings/");
	} else {
		settingsWindow.loadFile(path.join(import.meta.dirname, "../out/settings/index.html"));
	}

	settingsWindow.on("closed", () => {
		settingsWindow = null;
	});
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
		alwaysOnTop: true,
		webPreferences: {
			preload: path.join(import.meta.dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	mainWindow.once("ready-to-show", () => {
		mainWindow?.show();
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

	// Load content
	if (isDev) {
		mainWindow.loadURL("http://localhost:3000");
		mainWindow.webContents.openDevTools({ mode: "detach" });
	} else {
		mainWindow.loadFile(path.join(import.meta.dirname, "../out/index.html"));
	}

	// Window-specific setup (per window, cleaned up on close)
	cleanupHotkeys = setupHotkeyHandlers(mainWindow);
	tray = setupTray(mainWindow);
	cleanupRelay = setupRelay(mainWindow, sttClient);

	// Auto-connect to STT server (reconnects with exponential backoff if not yet running)
	sttClient.connect();

	mainWindow.on("closed", () => {
		cleanupHotkeys?.();
		cleanupRelay?.();
		cleanupHotkeys = null;
		cleanupRelay = null;
		mainWindow = null;
	});
}
