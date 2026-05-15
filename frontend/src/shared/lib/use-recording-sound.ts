"use client";

import { useEffect, useRef } from "react";
import { ipcInvoke, ipcOn } from "@/shared/api/ipc-client";

/**
 * Decode-failed sentinel. Logging is split out so `decodeWav` stays at CC=1
 * (no try/catch branch contributing to complexity).
 */
function warnDecodeFailure(): null {
	console.warn("[sound] Failed to decode audio data");
	return null;
}

/**
 * Slice a Uint8Array's view of its underlying buffer into a clean ArrayBuffer.
 * Electron IPC delivers Buffer as Uint8Array; the raw `data.buffer` may include
 * unrelated bytes (offset/extra capacity), so we slice the relevant window.
 */
export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/**
 * Decode WAV bytes via the supplied AudioContext. Returns null on failure
 * (after logging) so the caller can simply assign the result. CC=1.
 */
export function decodeWav(ctx: AudioContext, data: Uint8Array): Promise<AudioBuffer | null> {
	return ctx.decodeAudioData(toArrayBuffer(data)).catch(warnDecodeFailure);
}

/**
 * Resume the AudioContext if it's suspended (browser auto-play policies may
 * suspend it after the user interacts elsewhere). CC=2.
 */
export function ensureRunning(ctx: AudioContext): void {
	if (ctx.state === "suspended") {
		ctx.resume();
	}
}

/**
 * Play the cached buffer once on the supplied context. CC=1.
 */
export function playBuffer(ctx: AudioContext, buf: AudioBuffer): void {
	ensureRunning(ctx);
	const source = ctx.createBufferSource();
	source.buffer = buf;
	source.connect(ctx.destination);
	source.start();
}

/**
 * Fetches the recording-start WAV from the main process on mount,
 * decodes it into an AudioBuffer, and plays it via Web Audio API
 * whenever the main process sends `sound:play`.
 *
 * Latency: ~1-3ms (pre-decoded PCM played straight to hardware),
 * vs ~150-200ms with the old PowerShell approach.
 */
export function useRecordingSound(): void {
	const ctxRef = useRef<AudioContext | null>(null);
	const bufRef = useRef<AudioBuffer | null>(null);

	useEffect(() => {
		const lifecycle = { disposed: false };

		const load = async (data: Uint8Array | null): Promise<void> => {
			if (lifecycle.disposed || !data) {
				return;
			}
			const ctx = new AudioContext();
			ctxRef.current = ctx;
			bufRef.current = await decodeWav(ctx, data);
		};

		ipcInvoke<Uint8Array | null>("sound:get-data").then(load);

		const tryPlay = (): void => {
			const ctx = ctxRef.current;
			const buf = bufRef.current;
			if (ctx && buf) {
				playBuffer(ctx, buf);
			}
		};
		const unsub = ipcOn("sound:play", tryPlay);

		return () => {
			lifecycle.disposed = true;
			unsub();
			ctxRef.current?.close();
			ctxRef.current = null;
			bufRef.current = null;
		};
	}, []);
}
