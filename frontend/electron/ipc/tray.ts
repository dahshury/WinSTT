import fs from "node:fs";
import path from "node:path";
import {
	app,
	type BrowserWindow as BrowserWindowType,
	type NativeImage,
	nativeImage,
	Tray,
} from "electron";
import { showTrayMenuAt } from "./tray-menu-window";
import { attachTray, getCurrentTrayTheme, loadIdleIcon } from "./tray-state";

function resolveLegacyIconFilename(): string {
	return process.platform === "win32" ? "icon.ico" : "icon.png";
}

function resolveLegacyTrayIconPath(): string {
	const name = resolveLegacyIconFilename();
	if (app.isPackaged) {
		return path.join(process.resourcesPath, "renderer", name);
	}
	return path.join(import.meta.dirname, "..", "build", name);
}

/**
 * Initial icon used during Tray construction. Prefers the theme-aware
 * idle icon from `electron/resources/tray/`; falls back to the legacy
 * brand icon under `build/` if the new resources haven't been generated
 * yet (mostly relevant for tests, not for shipped builds — CI runs
 * `bun run icon:tray:generate` before bundling).
 */
function loadInitialTrayIcon(): NativeImage {
	// Reuse the crisp multi-size idle loader (largest bitmap → Windows
	// downscales) so the very first paint isn't the blurry 16px base.
	const idle = loadIdleIcon(getCurrentTrayTheme());
	if (!idle.isEmpty()) {
		return idle;
	}
	const legacy = resolveLegacyTrayIconPath();
	if (!fs.existsSync(legacy)) {
		return nativeImage.createEmpty();
	}
	const icon = nativeImage.createFromPath(legacy);
	return icon.isEmpty() ? nativeImage.createEmpty() : icon;
}

export interface SetupTrayOptions {
	/**
	 * Optional callback invoked from the native context menu's "Settings"
	 * item. Wired in main.ts to the same `openSettingsWindow` helper the
	 * custom tray-menu BrowserWindow already uses. When omitted, the
	 * "Settings" entry falls back to showing the main window.
	 */
	openSettings?: () => void;
}

export function setupTray(win: BrowserWindowType, options: SetupTrayOptions = {}): Tray {
	const tray = new Tray(loadInitialTrayIcon());

	tray.setToolTip("WinSTT - Speech to Text");

	// Show main window on left click
	tray.on("click", () => {
		win.show();
	});

	// Show custom menu on right click — keeps the rich, BrowserWindow-based
	// menu that the existing app uses for hover affordances. The native
	// context menu maintained by tray-state is shown by some platforms
	// automatically (Linux indicators) and is also the default fallback if
	// the custom menu window isn't reachable.
	tray.on("right-click", (_event, bounds) => {
		showTrayMenuAt(bounds.x, bounds.y + bounds.height);
	});

	// Wire up the state-driven controller: theme detection, icon refresh,
	// recording/transcribing/idle transitions, history-submenu slot.
	attachTray(tray, {
		onOpenMainWindow: () => {
			win.show();
		},
		onOpenSettings: () => {
			if (options.openSettings) {
				options.openSettings();
				return;
			}
			win.show();
		},
		onQuit: () => {
			app.quit();
		},
	});

	return tray;
}
