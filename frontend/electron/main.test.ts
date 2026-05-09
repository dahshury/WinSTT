import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// ── Source-level smoke test for the Electron main process bootstrap ──
// Importing main.ts at test time is impractical: it pulls in electron,
// electron-store, uiohook-napi, pngjs, and a long chain of IPC handlers
// — each running side effects on import. Instead, we read the source
// and assert it contains the expected setup calls and structural shape.

const SOURCE_PATH = `${import.meta.dirname}/main.ts`;

const source = readFileSync(SOURCE_PATH, "utf8");

describe("electron/main.ts (source-level smoke test)", () => {
	test("source file is non-empty", () => {
		expect(source.length).toBeGreaterThan(0);
	});

	test("imports the SttClient from the ws module", () => {
		expect(source).toContain('from "./ws/stt-client"');
		expect(source).toMatch(/new SttClient\(/);
	});

	test("uses single-instance lock to gate startup", () => {
		expect(source).toContain("requestSingleInstanceLock");
		// Both branches of the lock should be handled
		expect(source).toMatch(/gotTheLock/);
	});

	test("registers app.whenReady handler for first-window setup", () => {
		expect(source).toContain("app");
		expect(source).toContain("whenReady");
	});

	test("declares a global IPC setup function that wires every handler", () => {
		expect(source).toContain("setupGlobalIpcHandlers");
		// All the ipc handler setup calls must be present
		expect(source).toContain("setupSettingsHandlers");
		expect(source).toContain("setupSttProcessHandlers");
		expect(source).toContain("setupAutostartHandlers");
		expect(source).toContain("setupAudioMuteHandlers");
		expect(source).toContain("setupSttCommandHandlers");
		expect(source).toContain("setupLoopbackHandlers");
		expect(source).toContain("setupDialogHandlers");
		expect(source).toContain("setupOverlayHandlers");
		expect(source).toContain("setupTrayMenuHandlers");
		expect(source).toContain("setupLlm");
	});

	test("registers BrowserWindow lifecycle handlers", () => {
		expect(source).toContain("BrowserWindow");
		expect(source).toContain("window-all-closed");
		expect(source).toContain("before-quit");
		expect(source).toContain("activate");
	});

	test("uses sandboxed contextIsolated webPreferences", () => {
		expect(source).toContain("contextIsolation: true");
		expect(source).toContain("nodeIntegration: false");
		expect(source).toContain("sandbox: true");
		expect(source).toContain("preload: path.join");
	});

	test("installs a CSP hook on the default session", () => {
		expect(source).toContain("Content-Security-Policy");
		expect(source).toContain("session.defaultSession.webRequest.onHeadersReceived");
	});

	test("connects the SttClient and disconnects it during shutdown", () => {
		expect(source).toMatch(/sttClient\.connect\(/);
		expect(source).toMatch(/sttClient\.disconnect\(/);
	});

	test("registers a fatal-error handler for uncaught/unhandled errors", () => {
		expect(source).toContain("setupFatalErrorHandlers");
		expect(source).toContain("uncaughtException");
		expect(source).toContain("unhandledRejection");
	});

	test("imports the auto-updater dynamically (so dev runs don't require it)", () => {
		expect(source).toContain("electron-updater");
		// dynamic `await import(...)` keeps it out of the synchronous boot path
		expect(source).toMatch(/await import\(updaterModuleName\)/);
	});

	test("guards renderer navigation against external origins", () => {
		expect(source).toContain("protectWindowNavigation");
		expect(source).toContain("will-navigate");
		expect(source).toContain("setWindowOpenHandler");
	});
});
