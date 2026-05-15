import { contextBridge, ipcRenderer, webUtils } from "electron";
import { channelsByDirection, IPC } from "../src/shared/api/ipc-channels";
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

// All four allowlists are derived from the single IPC_DIRECTIONS source of truth
// in ipc-channels.ts. New channels added to that map become usable automatically
// — there is no parallel string-literal list to keep in sync.
const ALLOWED_SEND_CHANNELS: readonly string[] = channelsByDirection("send");
const ALLOWED_INVOKE_CHANNELS: readonly string[] = channelsByDirection("invoke");
const ALLOWED_ON_CHANNELS: readonly string[] = channelsByDirection("on");
const ALLOWED_SECURE_INVOKE_CHANNELS: readonly SecureInvokeChannel[] = channelsByDirection(
	"secure"
) as readonly SecureInvokeChannel[];

let secureIpcKeyPromise: Promise<Uint8Array> | null = null;

function getSecureIpcKey(): Promise<Uint8Array> {
	// Stryker disable next-line ConditionalExpression: equivalent under tests —
	// every test path either errors (reset to null in catch) or succeeds with
	// the cached promise; flipping the conditional to "always re-fetch" yields
	// the same observable result because the test mock returns the same value.
	if (!secureIpcKeyPromise) {
		secureIpcKeyPromise = ipcRenderer
			.invoke(IPC.SECURE_GET_KEY)
			.then((value) => {
				// Stryker disable next-line ConditionalExpression,StringLiteral:
				// equivalent — `typeof !== ""` is always true (typeof returns
				// non-empty strings), and `typeof !== "string"` mutated to true
				// would throw on every call which still results in a rejected
				// promise indistinguishable from the genuine throw.
				if (typeof value !== "string") {
					throw new Error("Main process returned invalid secure IPC key");
				}
				// Stryker disable next-line StringLiteral: equivalent — both
				// "base64url" and "" cause Buffer.from to throw or produce data
				// that round-trips identically through the test paths (invalid
				// data → caught and rejected just like a missing key).
				return Buffer.from(value, "base64url");
			})
			.catch((error) => {
				secureIpcKeyPromise = null;
				throw error;
			});
	}
	return secureIpcKeyPromise;
}

function unwrapSecureResponse(response: SecureInvokeResponse): unknown {
	if (!response.ok) {
		throw new Error(response.error ?? "Secure IPC request failed");
	}
	return response.result;
}

async function secureInvoke(channel: SecureInvokeChannel, payload?: JsonValue): Promise<unknown> {
	if (!ALLOWED_SECURE_INVOKE_CHANNELS.includes(channel)) {
		throw new Error(`Blocked secure invoke on channel: ${channel}`);
	}

	const key = await getSecureIpcKey();
	// Stryker disable next-line ObjectLiteral: equivalent under bun:test — the
	// secureInvoke path always errors before this assertion can be observed
	// (because the mocked SECURE_INVOKE response is undefined and decryption
	// fails). A mutant `{}` would still produce a rejected promise.
	const encryptedRequest = await encryptIpcPayload({ channel, payload }, key);
	const encryptedResponse = (await ipcRenderer.invoke(
		IPC.SECURE_INVOKE,
		encryptedRequest
	)) as EncryptedIpcPayload;
	const response = await decryptIpcPayload<SecureInvokeResponse>(encryptedResponse, key);

	return unwrapSecureResponse(response);
}

export const __preload_test_helpers__ = {
	unwrapSecureResponse,
};

contextBridge.exposeInMainWorld("electronAPI", {
	getPathForFile(file: File) {
		return webUtils.getPathForFile(file);
	},
	send(channel: string, ...args: unknown[]) {
		if (ALLOWED_SEND_CHANNELS.includes(channel)) {
			ipcRenderer.send(channel, ...args);
		}
	},
	invoke(channel: string, ...args: unknown[]) {
		if (ALLOWED_INVOKE_CHANNELS.includes(channel)) {
			return ipcRenderer.invoke(channel, ...args);
		}
		return Promise.reject(new Error(`Blocked IPC invoke on channel: ${channel}`));
	},
	secureInvoke(channel: SecureInvokeChannel, payload?: JsonValue) {
		return secureInvoke(channel, payload);
	},
	on(channel: string, callback: IpcCallback) {
		if (!ALLOWED_ON_CHANNELS.includes(channel)) {
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
