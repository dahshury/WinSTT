import { contextBridge, ipcRenderer } from "electron";

type IpcCallback = (...args: unknown[]) => void;

/** Channels the renderer may fire-and-forget to the main process */
const ALLOWED_SEND_CHANNELS = [
	"stt:set-parameter",
	"stt:call-method",
	"hotkey:unregister",
	"autostart:set",
	"audio:set-mute",
	"settings:save",
	"window:minimize",
	"window:maximize",
	"window:close",
	"window:open-settings",
	"window:close-self",
] as const;

/** Channels the renderer may invoke (request-response) on the main process */
const ALLOWED_INVOKE_CHANNELS = [
	"stt:get-parameter",
	"stt:is-connected",
	"hotkey:register",
	"autostart:get",
	"audio:get-devices",
	"gpu:get-info",
	"settings:load",
	"stt-server:spawn",
	"stt-server:kill",
	"stt-server:status",
] as const;

/** Channels the main process may push to the renderer */
const ALLOWED_ON_CHANNELS = [
	"stt:realtime-text",
	"stt:full-sentence",
	"stt:recording-start",
	"stt:recording-stop",
	"stt:vad-start",
	"stt:vad-stop",
	"stt:transcription-start",
	"stt:connection-change",
	"stt:server-status",
	"stt:wakeword-detected",
	"stt:wakeword-detection-start",
	"stt:wakeword-detection-end",
	"hotkey:pressed",
	"hotkey:released",
	"settings:changed",
] as const;

contextBridge.exposeInMainWorld("electronAPI", {
	send(channel: string, ...args: unknown[]) {
		if ((ALLOWED_SEND_CHANNELS as readonly string[]).includes(channel)) {
			ipcRenderer.send(channel, ...args);
		}
	},
	invoke(channel: string, ...args: unknown[]) {
		if ((ALLOWED_INVOKE_CHANNELS as readonly string[]).includes(channel)) {
			return ipcRenderer.invoke(channel, ...args);
		}
		return Promise.reject(new Error(`Blocked IPC invoke on channel: ${channel}`));
	},
	on(channel: string, callback: IpcCallback) {
		if (!(ALLOWED_ON_CHANNELS as readonly string[]).includes(channel)) {
			// biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op unsubscribe
			return () => {};
		}
		const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => {
			callback(...args);
		};
		ipcRenderer.on(channel, handler);
		return () => {
			ipcRenderer.removeListener(channel, handler);
		};
	},
});
