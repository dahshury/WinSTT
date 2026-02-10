import { contextBridge, ipcRenderer, webUtils } from "electron";

type IpcCallback = (...args: unknown[]) => void;

/** Channels the renderer may fire-and-forget to the main process */
const ALLOWED_SEND_CHANNELS = [
	"stt:set-parameter",
	"stt:call-method",
	"hotkey:unregister",
	"hotkey:stop-recording",
	"autostart:set",
	"audio:set-mute",
	"settings:save",
	"window:minimize",
	"window:maximize",
	"window:close",
	"window:open-settings",
	"window:close-self",
	"loopback:start",
	"loopback:stop",
] as const;

/** Channels the renderer may invoke (request-response) on the main process */
const ALLOWED_INVOKE_CHANNELS = [
	"stt:get-parameter",
	"stt:is-connected",
	"hotkey:register",
	"hotkey:start-recording",
	"autostart:get",
	"audio:get-devices",
	"gpu:get-info",
	"settings:load",
	"stt-server:spawn",
	"stt-server:kill",
	"stt-server:status",
	"dialog:open-file",
	"file:transcribe",
	"stt:get-model-catalog",
	"stt:get-server-ready",
	"loopback:list-devices",
	"stt:cancel-download",
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
	"stt:model-download-start",
	"stt:model-download-progress",
	"stt:model-download-complete",
	"stt:audio-level",
	"stt:model-catalog",
	"hotkey:pressed",
	"hotkey:released",
	"hotkey:recording-update",
	"hotkey:recording-done",
	"settings:changed",
	"file:transcription-progress",
	"file:transcription-complete",
	"file:transcription-error",
	"stt:loopback-started",
	"stt:loopback-stopped",
] as const;

contextBridge.exposeInMainWorld("electronAPI", {
	getPathForFile(file: File) {
		return webUtils.getPathForFile(file);
	},
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
