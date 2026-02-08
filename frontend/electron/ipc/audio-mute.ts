import { ipcMain } from "electron";

export function setupAudioMuteHandlers() {
	ipcMain.on("audio:set-mute", (_event, { muted }: { muted: boolean }) => {
		// Windows system audio muting - requires native module or PowerShell
		// Placeholder: will integrate with Windows audio API
		console.log(`Audio mute ${muted ? "enabled" : "disabled"}`);
	});
}
