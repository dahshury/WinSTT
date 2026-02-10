import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, session, shell, type Tray } from "electron";

import { setupAudioMuteHandlers } from "./ipc/audio-mute";
import { setupAutostartHandlers } from "./ipc/autostart";
import { setupFileTranscribeHandlers } from "./ipc/file-transcribe";
import { setupHotkeyHandlers } from "./ipc/hotkey";
import { setupRelay } from "./ipc/relay";
import { setupSettingsHandlers } from "./ipc/settings";
import { killSttProcess, setupSttProcessHandlers } from "./ipc/stt-process";
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
	setupSettingsHandlers();
	setupSttProcessHandlers();
	setupAutostartHandlers();
	setupAudioMuteHandlers();
	setupSttCommandHandlers();
	setupLoopbackHandlers();
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

/** Proxy STT commands from renderer to the WebSocket control channel */
function setupSttCommandHandlers() {
	ipcMain.on("stt:set-parameter", (_event, payload: { parameter: string; value: unknown }) => {
		if (!sttClient.isConnected) {
			dbg("stt-cmd", "set-parameter DROPPED (not connected):", payload.parameter);
			return;
		}
		dbg("stt-cmd", "set-parameter:", payload.parameter, "=", JSON.stringify(payload.value));
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
			dbg("stt-cmd", "call-method DROPPED (not connected):", payload.method);
			return;
		}
		dbg("stt-cmd", "call-method:", payload.method, JSON.stringify(payload.args ?? []));
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

	ipcMain.handle("audio:get-devices", async () => {
		try {
			const { execFile } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const execFileAsync = promisify(execFile);

			// Use PowerShell + MMDevice COM to enumerate audio capture endpoints
			const ps = `
Add-Type -AssemblyName System.Runtime.InteropServices
$code = @'
using System;
using System.Runtime.InteropServices;

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection ppDevices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
}

[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
    int GetCount(out int pcDevices);
    int Item(int nDevice, out IMMDevice ppDevice);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    int GetState(out int pdwState);
}

[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
    int GetCount(out int cProps);
    int GetAt(int iProp, out PROPERTYKEY pkey);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
}

[StructLayout(LayoutKind.Sequential)]
struct PROPERTYKEY {
    public Guid fmtid;
    public int pid;
}

[StructLayout(LayoutKind.Sequential)]
struct PROPVARIANT {
    public ushort vt;
    public ushort wReserved1, wReserved2, wReserved3;
    public IntPtr val;
    public IntPtr val2;
}

public static class AudioDeviceLister {
    public static string List() {
        var CLSID = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
        var t = Type.GetTypeFromCLSID(CLSID);
        var enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(t);

        // Get default capture device ID
        string defaultId = "";
        IMMDevice defDev;
        if (enumerator.GetDefaultAudioEndpoint(1, 0, out defDev) == 0) {
            defDev.GetId(out defaultId);
        }

        // Enumerate capture devices (dataFlow=1=eCapture, stateMask=1=ACTIVE)
        IMMDeviceCollection col;
        enumerator.EnumAudioEndpoints(1, 1, out col);
        int count;
        col.GetCount(out count);

        var PKEY_Name = new PROPERTYKEY {
            fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"),
            pid = 14
        };

        var sb = new System.Text.StringBuilder();
        for (int i = 0; i < count; i++) {
            IMMDevice dev;
            col.Item(i, out dev);
            string id;
            dev.GetId(out id);
            IPropertyStore props;
            dev.OpenPropertyStore(0, out props);
            PROPVARIANT pv;
            props.GetValue(ref PKEY_Name, out pv);
            string name = Marshal.PtrToStringUni(pv.val) ?? "Unknown";
            bool isDef = id == defaultId;
            sb.AppendLine(i + "|" + name + "|" + (isDef ? "1" : "0"));
        }
        return sb.ToString().TrimEnd();
    }
}
'@
Add-Type -TypeDefinition $code -Language CSharp
[AudioDeviceLister]::List()
`;
			const { stdout } = await execFileAsync(
				"powershell",
				["-NoProfile", "-NonInteractive", "-Command", ps],
				{ windowsHide: true, timeout: 10_000 }
			);

			const devices: Array<{ index: number; name: string; isDefault: boolean }> = [];
			for (const line of stdout.trim().split("\n")) {
				const parts = line.trim().split("|");
				if (parts.length >= 3) {
					devices.push({
						index: Number.parseInt(parts[0] as string, 10),
						name: (parts[1] as string).trim(),
						isDefault: parts[2] === "1",
					});
				}
			}
			return devices;
		} catch (err) {
			console.warn("[audio] Failed to enumerate devices:", err);
			return [];
		}
	});
}

function setupLoopbackHandlers() {
	ipcMain.handle("loopback:list-devices", async () => {
		if (!sttClient.isConnected) {
			return [];
		}
		try {
			return await sttClient.listLoopbackDevices();
		} catch {
			return [];
		}
	});

	ipcMain.on("loopback:start", (_event, payload: { deviceIndex: number }) => {
		if (sttClient.isConnected) {
			sttClient.startLoopback(payload.deviceIndex);
		}
	});

	ipcMain.on("loopback:stop", () => {
		if (sttClient.isConnected) {
			sttClient.stopLoopback();
		}
	});
}

function setupDialogHandlers() {
	ipcMain.handle(
		"dialog:open-file",
		async (_event, options: { filters?: Electron.FileFilter[]; title?: string }) => {
			const result = await dialog.showOpenDialog({
				title: options.title ?? "Select File",
				filters: options.filters,
				properties: ["openFile"],
			});
			if (result.canceled || result.filePaths.length === 0) {
				return null;
			}
			return result.filePaths[0];
		}
	);
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
		webPreferences: {
			preload: path.join(import.meta.dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
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
		webPreferences: {
			preload: path.join(import.meta.dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
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
