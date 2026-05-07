import { ipcMain } from "electron";
import type { SttClient } from "../ws/stt-client";

export function setupLoopbackHandlers(sttClient: SttClient): void {
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
		if (!sttClient.isConnected) {
			return;
		}
		if (!Number.isInteger(payload?.deviceIndex) || payload.deviceIndex < 0) {
			return;
		}
		sttClient.startLoopback(payload.deviceIndex);
	});

	ipcMain.on("loopback:stop", () => {
		if (sttClient.isConnected) {
			sttClient.stopLoopback();
		}
	});
}
