import { app, ipcMain } from "electron";

function supportsLoginItems(): boolean {
	return process.platform === "win32" || process.platform === "darwin";
}

function extractEnabled(payload: unknown): boolean | null {
	if (payload && typeof (payload as { enabled: unknown }).enabled === "boolean") {
		return (payload as { enabled: boolean }).enabled;
	}
	return null;
}

/**
 * Args passed to the OS auto-start hook so login-launches behave like a
 * "warm-keep" daemon: the app boots invisibly, the stt-server spawns in
 * parallel with window creation (per main.ts:tryAutoSpawnServer), warmup()
 * compiles the ONNX kernels (per RecorderService.warmup), and by the time
 * the user presses their PTT hotkey the model is already loaded — no
 * first-press cold-start tax. The tray icon stays visible so the user can
 * surface the main window on demand.
 *
 * `--no-tray` is intentionally NOT set; users who autostart and want zero
 * UI can do that themselves via the OS Task Scheduler.
 */
const AUTOSTART_ARGS: readonly string[] = ["--start-hidden"];

export function setupAutostartHandlers(): void {
	ipcMain.handle("autostart:get", () => {
		if (!supportsLoginItems()) {
			return false;
		}
		return app.getLoginItemSettings().openAtLogin;
	});

	ipcMain.on("autostart:set", (_event, payload: unknown) => {
		if (!supportsLoginItems()) {
			return;
		}
		const enabled = extractEnabled(payload);
		if (enabled === null) {
			return;
		}
		// Pass `--start-hidden` as an OS login-item arg so the warm-keep
		// pattern applies: app boots invisibly at login, server warms in
		// the background, first hotkey press is cheap. On macOS, `args`
		// is supported by setLoginItemSettings; on Windows, electron-builder
		// writes the registry Run entry with the launch arguments included.
		app.setLoginItemSettings({
			openAtLogin: enabled,
			...(enabled ? { args: [...AUTOSTART_ARGS] } : {}),
		});
	});
}
