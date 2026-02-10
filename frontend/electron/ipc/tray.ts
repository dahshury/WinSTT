import path from "node:path";
import {
	app,
	BrowserWindow,
	type BrowserWindow as BrowserWindowType,
	Menu,
	nativeImage,
	Tray,
} from "electron";
import { store } from "../lib/store";
import type { SttClient } from "../ws/stt-client";

const MODE_LABELS: Record<string, string> = {
	ptt: "Push-to-Talk",
	toggle: "Toggle",
	listen: "Listen",
};

const MODE_ORDER = ["ptt", "toggle", "listen"] as const;

export function setupTray(
	win: BrowserWindowType,
	onOpenSettings?: () => void,
	sttClient?: SttClient
): { tray: Tray; rebuildTrayMenu: () => void } {
	const iconPath = path.join(import.meta.dirname, "..", "build", "icon.ico");
	const icon = nativeImage.createFromPath(iconPath);
	const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);

	function rebuildTrayMenu() {
		const currentMode = (store.get("general.recordingMode") as string) ?? "ptt";

		const contextMenu = Menu.buildFromTemplate([
			{
				label: "Show",
				click: () => win.show(),
			},
			{ type: "separator" },
			...MODE_ORDER.map((mode) => ({
				label: MODE_LABELS[mode] as string,
				type: "radio" as const,
				checked: currentMode === mode,
				click: () => {
					store.set("general.recordingMode", mode);
					// Send silence_timing directly to the STT server so we
					// don't rely on the renderer broadcast path (which would
					// cause duplicate sends from multiple windows).
					if (sttClient?.isConnected) {
						sttClient.setParameter("silence_timing", mode === "toggle" || mode === "listen");
					}
					// Broadcast to all renderer windows so Zustand stores stay in sync
					const settings = store.store as Record<string, unknown>;
					for (const w of BrowserWindow.getAllWindows()) {
						w.webContents.send("settings:changed", { settings });
					}
					rebuildTrayMenu();
				},
			})),
			{ type: "separator" as const },
			{
				label: "Settings",
				click: () => onOpenSettings?.(),
			},
			{ type: "separator" as const },
			{
				label: "Quit",
				click: () => {
					app.quit();
				},
			},
		]);

		tray.setContextMenu(contextMenu);
	}

	tray.setToolTip("WinSTT");
	rebuildTrayMenu();

	tray.on("click", () => {
		win.show();
	});

	return { tray, rebuildTrayMenu };
}
