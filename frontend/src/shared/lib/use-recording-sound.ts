"use client";

import { useEffect, useRef } from "react";
import { ipcInvoke, ipcOn } from "@/shared/api/ipc-client";

/**
 * Fetches the recording-start WAV from the main process on mount,
 * decodes it into an AudioBuffer, and plays it via Web Audio API
 * whenever the main process sends `sound:play`.
 *
 * Latency: ~1-3ms (pre-decoded PCM played straight to hardware),
 * vs ~150-200ms with the old PowerShell approach.
 */
export function useRecordingSound() {
	const ctxRef = useRef<AudioContext | null>(null);
	const bufRef = useRef<AudioBuffer | null>(null);

	useEffect(() => {
		let disposed = false;

		// Fetch WAV bytes from main process and decode into AudioBuffer
		ipcInvoke<Uint8Array | null>("sound:get-data").then(async (data) => {
			if (disposed || !data) {
				return;
			}
			const ctx = new AudioContext();
			ctxRef.current = ctx;
			try {
				// Electron IPC delivers Buffer as Uint8Array — extract a clean ArrayBuffer
				const ab = data.buffer.slice(
					data.byteOffset,
					data.byteOffset + data.byteLength
				) as ArrayBuffer;
				bufRef.current = await ctx.decodeAudioData(ab);
			} catch {
				console.warn("[sound] Failed to decode audio data");
			}
		});

		// Play the cached buffer whenever main process triggers
		const unsub = ipcOn("sound:play", () => {
			const ctx = ctxRef.current;
			const buf = bufRef.current;
			if (!(ctx && buf)) {
				return;
			}
			if (ctx.state === "suspended") {
				ctx.resume();
			}
			const source = ctx.createBufferSource();
			source.buffer = buf;
			source.connect(ctx.destination);
			source.start();
		});

		return () => {
			disposed = true;
			unsub();
			ctxRef.current?.close();
			ctxRef.current = null;
			bufRef.current = null;
		};
	}, []);
}
