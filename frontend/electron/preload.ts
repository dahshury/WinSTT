import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC } from "../src/shared/api/ipc-channels";
import {
	decryptIpcPayload,
	type EncryptedIpcPayload,
	encryptIpcPayload,
	type JsonValue,
} from "./ipc/ipc-payload-crypto";

type IpcCallback = (...args: unknown[]) => void;
type SecureInvokeChannel =
	| typeof IPC.CLIPBOARD_OPERATE
	| typeof IPC.UPDATER_GET_STATUS_HISTORY
	| typeof IPC.UPDATER_CLEAR_STATUS_HISTORY;

interface SecureInvokeResponse {
	error?: string;
	ok: boolean;
	result?: unknown;
}

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
	"window:show",
	"window:quit",
	"tray-menu:close",
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
	"sound:get-data",
	"llm:scan-models",
	"llm:process-text",
	"llm:detect-ollama",
	"llm:start-ollama",
	"llm:scan-openrouter-models",
	"llm:pull-model",
	"llm:cancel-pull-model",
	"llm:delete-model",
	"app-menu:set-template",
	"app-menu:reset",
	"context-menu:show",
	"clipboard:operate",
	"updater:get-status-history",
	"updater:clear-status-history",
] as const;

/** Channels the main process may push to the renderer */
const ALLOWED_ON_CHANNELS = [
	"stt:realtime-text",
	"stt:full-sentence",
	"stt:no-audio-detected",
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
	"settings:save-error",
	"file:transcription-progress",
	"file:transcription-complete",
	"file:transcription-error",
	"stt:loopback-started",
	"stt:loopback-stopped",
	"sound:play",
	"llm:catalog",
	"llm:pull-progress",
	"updater:status",
	"window:telemetry",
] as const;

const ALLOWED_SECURE_INVOKE_CHANNELS: readonly SecureInvokeChannel[] = [
	IPC.CLIPBOARD_OPERATE,
	IPC.UPDATER_GET_STATUS_HISTORY,
	IPC.UPDATER_CLEAR_STATUS_HISTORY,
] as const;

let secureIpcKeyPromise: Promise<Uint8Array> | null = null;

function getSecureIpcKey(): Promise<Uint8Array> {
	if (!secureIpcKeyPromise) {
		secureIpcKeyPromise = ipcRenderer
			.invoke(IPC.SECURE_GET_KEY)
			.then((value) => {
				if (typeof value !== "string") {
					throw new Error("Main process returned invalid secure IPC key");
				}
				return Buffer.from(value, "base64url");
			})
			.catch((error) => {
				secureIpcKeyPromise = null;
				throw error;
			});
	}
	return secureIpcKeyPromise;
}

async function secureInvoke(channel: SecureInvokeChannel, payload?: JsonValue): Promise<unknown> {
	if (!ALLOWED_SECURE_INVOKE_CHANNELS.includes(channel)) {
		throw new Error(`Blocked secure invoke on channel: ${channel}`);
	}

	const key = await getSecureIpcKey();
	const encryptedRequest = await encryptIpcPayload({ channel, payload }, key);
	const encryptedResponse = (await ipcRenderer.invoke(
		IPC.SECURE_INVOKE,
		encryptedRequest
	)) as EncryptedIpcPayload;
	const response = await decryptIpcPayload<SecureInvokeResponse>(encryptedResponse, key);

	if (!response.ok) {
		throw new Error(response.error ?? "Secure IPC request failed");
	}
	return response.result;
}

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
	secureInvoke(channel: SecureInvokeChannel, payload?: JsonValue) {
		return secureInvoke(channel, payload);
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
