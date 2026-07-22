import { listen as tauriListen } from "@tauri-apps/api/event";
import { hasTauriRuntime } from "@/shared/lib/tauri-runtime";
import { fileToTauriPath } from "./adapter/drag-drop";
import { NATIVE_EVENTS as IPC } from "./native-events";

export const noop = () => undefined;

const pendingNativeListenerRegistrations = new Set<Promise<unknown>>();

function trackNativeListenerRegistration<T>(
	registration: Promise<T>,
): Promise<T> {
	let tracked: Promise<T>;
	tracked = registration.finally(() => {
		pendingNativeListenerRegistrations.delete(tracked);
	});
	pendingNativeListenerRegistrations.add(tracked);
	return tracked;
}

/**
 * Wait until every listener registration started by the current React effect
 * flush has settled. The deadline is a crash/bridge fallback: renderer startup
 * must never remain wedged behind a listener promise that cannot resolve.
 */
export async function waitForPendingNativeListeners(
	timeoutMs = 2000,
): Promise<boolean> {
	// Let later effects in the same commit start their registrations first.
	await Promise.resolve();
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const drained = async () => {
		while (pendingNativeListenerRegistrations.size > 0) {
			await Promise.allSettled([...pendingNativeListenerRegistrations]);
			await Promise.resolve();
		}
		return true;
	};
	try {
		return await Promise.race([
			drained(),
			new Promise<false>((resolve) => {
				timeoutId = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
	}
}

export type FallbackValue<T> = T | (() => T);

function resolveFallback<T>(fallback: FallbackValue<T>): T {
	return typeof fallback === "function" ? (fallback as () => T)() : fallback;
}

/** True when generated commands and Tauri events are available. */
export function hasNativeRuntime(): boolean {
	return (
		hasTauriRuntime() ||
		(typeof window !== "undefined" && window.nativeBridge != null)
	);
}

export function hasSettingsBackend(): boolean {
	return (
		hasTauriRuntime() ||
		(typeof window !== "undefined" && window.location.port === "1420")
	);
}

/**
 * Run a generated command while preserving the renderer's intentional browser
 * preview fallback. Backend failures remain observable instead of looking like
 * a successful empty response.
 */
export async function commandOrDefault<T>(
	label: string,
	thunk: () => Promise<T>,
	fallback: FallbackValue<T>,
): Promise<T> {
	try {
		const value = await thunk();
		return value === undefined ? resolveFallback(fallback) : value;
	} catch (error) {
		console.warn(
			`[native] command "${label}" failed — returning fallback:`,
			error,
		);
		return resolveFallback(fallback);
	}
}

const CLOUD_ERROR_CODES: Readonly<Record<string, string>> = {
	[IPC.STT_CLOUD_AUTH_FAILED]: "auth_failed",
	[IPC.STT_CLOUD_NETWORK_ERROR]: "network_error",
	[IPC.STT_CLOUD_KEY_MISSING]: "key_missing",
	[IPC.STT_CLOUD_RATE_LIMITED]: "rate_limited",
	[IPC.STT_CLOUD_PROVIDER_ERROR]: "provider_error",
};

export function nativeEventName(channel: string): string {
	if (channel === IPC.STT_REALTIME_TEXT) {
		return "realtime:update";
	}
	if (channel === IPC.STT_WAKEWORD_DETECTED) {
		return "wakeword:detected";
	}
	if (channel in CLOUD_ERROR_CODES) {
		return "stt:cloud-error";
	}
	return channel;
}

function shouldDeliver(channel: string, payload: unknown): boolean {
	const expectedCode = CLOUD_ERROR_CODES[channel];
	if (expectedCode === undefined) {
		return true;
	}
	return (
		payload !== null &&
		typeof payload === "object" &&
		"code" in payload &&
		payload.code === expectedCode
	);
}

type Uint8ArrayBase64Constructor = Uint8ArrayConstructor & {
	fromBase64?: (source: string) => Uint8Array;
};

function decodeBase64ToArrayBuffer(encoded: string): ArrayBuffer {
	const fromBase64 = (Uint8Array as Uint8ArrayBase64Constructor).fromBase64;
	if (typeof fromBase64 === "function") {
		return fromBase64(encoded).buffer as ArrayBuffer;
	}
	const raw = atob(encoded);
	const bytes = new Uint8Array(raw.length);
	for (let index = 0; index < raw.length; index += 1) {
		bytes[index] = raw.charCodeAt(index);
	}
	return bytes.buffer;
}

export function reshapeNativeEvent(channel: string, payload: unknown): unknown {
	if (
		channel === IPC.STT_WAKEWORD_DETECTED &&
		payload !== null &&
		typeof payload === "object"
	) {
		const value = payload as { keyword?: string; word?: string };
		return { word: value.word ?? value.keyword ?? "" };
	}
	if (
		channel !== IPC.TTS_CHUNK ||
		payload === null ||
		typeof payload !== "object" ||
		!("pcm" in payload)
	) {
		return payload;
	}
	const pcm = payload.pcm;
	if (typeof pcm === "string") {
		return { ...payload, pcm: decodeBase64ToArrayBuffer(pcm) };
	}
	if (Array.isArray(pcm)) {
		return { ...payload, pcm: new Uint8Array(pcm).buffer };
	}
	if (ArrayBuffer.isView(pcm)) {
		return {
			...payload,
			pcm: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
		};
	}
	return payload;
}

/** Subscribe directly to a canonical Tauri event and return synchronous cleanup. */
export function on(
	channel: string,
	callback: (...args: unknown[]) => void,
): () => void {
	// Unit-test compatibility only. Production no longer installs this bridge.
	if (typeof window !== "undefined" && window.nativeBridge != null) {
		return window.nativeBridge.on(channel, callback);
	}
	if (!hasTauriRuntime()) {
		return noop;
	}
	const eventName = nativeEventName(channel);
	let active = true;
	const pending = trackNativeListenerRegistration(
		tauriListen<unknown>(eventName, (event) => {
			if (active && shouldDeliver(channel, event.payload)) {
				callback(reshapeNativeEvent(channel, event.payload));
			}
		}),
	);
	void pending.catch((error) => {
		console.warn(`[events] failed to listen for "${eventName}":`, error);
	});
	return () => {
		active = false;
		void pending.then((unlisten) => unlisten()).catch(() => undefined);
	};
}

export { on as ipcOn };

/**
 * Subscribe to a canonical Tauri event and resolve only after the native
 * listener is installed. Use this for subscribe-before-snapshot handshakes;
 * `ipcOn` intentionally returns synchronous cleanup and therefore cannot expose
 * Tauri's asynchronous listener-registration edge.
 */
export async function ipcOnReady(
	channel: string,
	callback: (...args: unknown[]) => void,
): Promise<() => void> {
	if (typeof window !== "undefined" && window.nativeBridge != null) {
		return window.nativeBridge.on(channel, callback);
	}
	if (!hasTauriRuntime()) {
		return noop;
	}
	const eventName = nativeEventName(channel);
	return trackNativeListenerRegistration(
		tauriListen<unknown>(eventName, (event) => {
			if (shouldDeliver(channel, event.payload)) {
				callback(reshapeNativeEvent(channel, event.payload));
			}
		}),
	);
}

export function onTyped<T, V>(
	channel: string,
	extract: (data: T) => V,
	callback: (value: V) => void,
): () => void {
	return on(channel, (data) => callback(extract(data as T)));
}

export function onCast<T>(
	channel: string,
	callback: (value: T) => void,
): () => void {
	return on(channel, (data) => callback(data as T));
}

/** Resolve a dropped DOM File to the path captured by Tauri drag/drop. */
export function getFilePath(file: File): string {
	if (window.nativeBridge != null) {
		return window.nativeBridge.getPathForFile(file);
	}
	return fileToTauriPath(file);
}
