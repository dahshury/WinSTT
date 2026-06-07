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
 * Slice binary IPC data into a clean ArrayBuffer.
 * the reference delivered Buffer as Uint8Array; Tauri serializes Rust `Vec<u8>` as a
 * plain `number[]` (no `.buffer`). Accept both (plus ArrayBuffer) so binary
 * commands like `sound:get-data` don't throw `undefined.slice` and crash the page.
 */
export function toArrayBuffer(data: Uint8Array | number[] | ArrayBuffer): ArrayBuffer {
	if (data instanceof ArrayBuffer) {
		return data;
	}
	if (Array.isArray(data)) {
		return Uint8Array.from(data).buffer;
	}
	return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/**
 * Decode WAV bytes via the supplied AudioContext. Returns null on failure
 * (after logging) so the caller can simply assign the result. CC=1.
 */
export function decodeWav(
	ctx: AudioContext,
	data: Uint8Array | number[] | ArrayBuffer,
): Promise<AudioBuffer | null> {
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
 * Construct an AudioContext routed to a specific output device, falling
 * back to the system default when `deviceId` is empty / the browser is
 * older than M114 (no `sinkId` constructor option). Pairs with
 * :func:`routeContextToSink` for runtime device switches.
 *
 * `sinkId` is declared on `AudioContextOptions` via `src/dom-augment.d.ts`
 * (Chromium M114+), so no cast is needed here.
 */
export function createOutputContext(deviceId: string): AudioContext {
	if (!deviceId) {
		return new AudioContext();
	}
	try {
		return new AudioContext({ sinkId: deviceId });
	} catch {
		return new AudioContext();
	}
}

/**
 * Switch a live AudioContext to a new output device. Best-effort: if the
 * runtime lacks `setSinkId` (older Chromium) or the device is unreachable,
 * the call is silently dropped — playback continues on the previous sink.
 *
 * `setSinkId` is declared as optional on `AudioContext` via
 * `src/dom-augment.d.ts`, so the older-Chromium guard stays type-safe.
 */
export async function routeContextToSink(ctx: AudioContext, deviceId: string): Promise<void> {
	if (!ctx.setSinkId) {
		return;
	}
	try {
		await ctx.setSinkId(deviceId);
	} catch (err) {
		// Device unavailable — the system default takes over (behaviour
		// unchanged). Warn for observability so a failed device switch is
		// diagnosable rather than silent, matching `decodeWav`'s idiom.
		console.warn("[sound] setSinkId failed; falling back to the system default", err);
	}
}
