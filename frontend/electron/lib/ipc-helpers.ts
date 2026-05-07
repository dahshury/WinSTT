import type { BrowserWindow } from "electron";

export type SafeSend = (channel: string, ...args: unknown[]) => void;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function createSafeSender(win: BrowserWindow): SafeSend {
	return (channel: string, ...args: unknown[]) => {
		if (win.isDestroyed()) {
			return;
		}
		win.webContents.send(channel, ...args);
	};
}
