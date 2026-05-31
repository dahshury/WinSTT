import { useEffect, useRef } from "react";
import { useSettingsStore } from "@/entities/setting";
import { ipcInvoke, ipcOn } from "@/shared/api/ipc-client";
import {
	createOutputContext,
	decodeWav,
	playBuffer,
	routeContextToSink,
} from "@/shared/lib/web-audio";

/**
 * Fetches the recording-start WAV from the main process on mount,
 * decodes it into an AudioBuffer, and plays it via Web Audio API
 * whenever the main process sends `sound:play`.
 *
 * Latency: ~1-3ms (pre-decoded PCM played straight to hardware),
 * vs ~150-200ms with the old PowerShell approach.
 *
 * Routes through the user-configured output device
 * (`general.outputDeviceId`) via Web Audio's `setSinkId`. Falls back to
 * the system default when no device is selected or the chosen device is
 * unavailable.
 */
export function useRecordingSound(): void {
	const outputDeviceId = useSettingsStore((s) => s.settings.general.outputDeviceId);
	const ctxRef = useRef<AudioContext | null>(null);
	const bufRef = useRef<AudioBuffer | null>(null);
	const initialDeviceRef = useRef(outputDeviceId);

	useEffect(() => {
		const lifecycle = { disposed: false };

		const load = async (data: Uint8Array | null): Promise<void> => {
			if (lifecycle.disposed || !data) {
				return;
			}
			const ctx = createOutputContext(initialDeviceRef.current);
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

	useEffect(() => {
		const ctx = ctxRef.current;
		if (!ctx) {
			return;
		}
		routeContextToSink(ctx, outputDeviceId);
	}, [outputDeviceId]);
}
