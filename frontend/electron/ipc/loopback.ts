import { ipcMain } from "electron";
import type { SttClient } from "../ws/stt-client";

function isValidDeviceIndex(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

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
		const idx = payload?.deviceIndex;
		if (sttClient.isConnected && isValidDeviceIndex(idx)) {
			sttClient.startLoopback(idx);
		}
	});

	ipcMain.on("loopback:stop", () => {
		if (sttClient.isConnected) {
			sttClient.stopLoopback();
		}
	});
}
