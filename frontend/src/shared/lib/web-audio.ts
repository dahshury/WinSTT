/**
 * Domain-agnostic Web Audio helpers. These primitives know nothing about
 * any specific feature — they wrap raw Web Audio API operations (buffer
 * slicing, decode, resume-if-suspended, one-shot playback) so any slice
 * that needs them imports them from here.
 *
 * The feature-specific hook that wires these into the recording lifecycle
 * (subscribing to `sound:play` IPC events, decoding the recording-start
 * WAV once at mount) lives in features/recording-sound — that hook owns
 * the business context; the primitives below do not.
 */

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

type AudioContextWithSinkId = AudioContext & {
	setSinkId?: (id: string | { type: "none" }) => Promise<void>;
};

/**
 * Construct an AudioContext routed to a specific output device, falling
 * back to the system default when `deviceId` is empty / the browser is
 * older than M114 (no `sinkId` constructor option). Pairs with
 * :func:`routeContextToSink` for runtime device switches.
 */
export function createOutputContext(deviceId: string): AudioContext {
	if (!deviceId) {
		return new AudioContext();
	}
	try {
		// `sinkId` option lives on `AudioContextOptions` in Chromium M114+; the
		// TS lib hasn't caught up everywhere, so cast at the call site.
		return new AudioContext({ sinkId: deviceId } as unknown as AudioContextOptions);
	} catch {
		return new AudioContext();
	}
}

/**
 * Switch a live AudioContext to a new output device. Best-effort: if the
 * runtime lacks `setSinkId` (older Chromium) or the device is unreachable,
 * the call is silently dropped — playback continues on the previous sink.
 */
export async function routeContextToSink(ctx: AudioContext, deviceId: string): Promise<void> {
	const withSinkId = ctx as AudioContextWithSinkId;
	if (!withSinkId.setSinkId) {
		return;
	}
	try {
		await withSinkId.setSinkId(deviceId || { type: "none" });
	} catch {
		// device unavailable — system default takes over
	}
}
