/**
 * Gap-free Web Audio playback queue for TTS chunks.
 *
 * Each TTS chunk arrives as raw float32 PCM at a known sample rate. We
 * decode it into an ``AudioBuffer`` and schedule it via
 * ``AudioBufferSourceNode.start(when)`` at the running playhead time. As
 * long as decodes outpace playback, chunks queue back-to-back with no
 * audible gap.
 *
 * Cancellation: ``stop()`` calls ``source.stop()`` on every scheduled
 * node and resets the playhead. Subsequent chunks (which may still
 * arrive from the server before its cooperative cancel takes effect)
 * are dropped via the ``activeRequestId`` guard.
 */

export interface ChunkInput {
	channels: number;
	/** ``f32le`` only for now — extend if other formats are added. */
	format: string;
	pcm: ArrayBuffer;
	requestId: string;
	sampleRate: number;
}

/**
 * Float32Array variant accepted by Web Audio's ``copyToChannel`` — the
 * narrow ``ArrayBuffer`` (not ``ArrayBufferLike``) form. Without this
 * pinning, helpers further down the chain widen to ``ArrayBufferLike``
 * (which permits ``SharedArrayBuffer``) and TS rejects the call.
 */
type AudioSamples = Float32Array<ArrayBuffer>;

/**
 * Validate ``chunk`` and return a Float32Array view over its PCM bytes,
 * or ``null`` if the chunk is in an unsupported format or empty. The
 * server emits little-endian float32. On every supported platform
 * (Windows x64, macOS arm64/x64) JS ``Float32Array`` is also LE, so we
 * can wrap the bytes directly without endianness conversion.
 */
export function parseFloat32Samples(chunk: ChunkInput): AudioSamples | null {
	if (chunk.format !== "f32le") {
		return null;
	}
	const samples = new Float32Array(chunk.pcm);
	if (samples.length === 0) {
		return null;
	}
	return samples;
}

/**
 * Extract a single channel ``ch`` (0-indexed) from interleaved
 * ``samples`` into a freshly-allocated owned ``Float32Array``. Missing
 * trailing samples are zero-filled (the buffer starts zeroed).
 */
function extractChannelPlane(
	samples: Float32Array,
	channels: number,
	frames: number,
	ch: number
): AudioSamples {
	const out = new Float32Array(new ArrayBuffer(frames * Float32Array.BYTES_PER_ELEMENT));
	const stride = channels;
	for (let i = 0; i < frames; i++) {
		const v = samples[i * stride + ch];
		out[i] = v === undefined ? 0 : v;
	}
	return out;
}

/**
 * Deinterleave interleaved PCM samples into one Float32Array per channel.
 * Always uses the planar path even for mono so the caller has a uniform
 * iteration shape — callers that hot-path mono should call
 * ``buffer.copyToChannel`` directly instead.
 */
export function deinterleaveSamples(
	samples: Float32Array,
	channels: number,
	frames: number
): AudioSamples[] {
	const planes: AudioSamples[] = [];
	for (let ch = 0; ch < channels; ch++) {
		planes.push(extractChannelPlane(samples, channels, frames, ch));
	}
	return planes;
}

/**
 * Copy each plane into its matching channel on ``buffer``. Skips any
 * plane that is ``undefined`` (defensive — ``deinterleaveSamples``
 * always returns ``channels`` planes, so this is just a TS narrow).
 */
export function copyPlanesToBuffer(buffer: AudioBuffer, planes: AudioSamples[]): void {
	for (let ch = 0; ch < planes.length; ch++) {
		const plane = planes[ch];
		if (plane) {
			buffer.copyToChannel(plane, ch);
		}
	}
}

/**
 * Fill ``buffer`` from interleaved float32 ``samples``. Handles the
 * mono fast path inline and delegates multi-channel deinterleaving to
 * ``deinterleaveSamples``.
 */
export function fillAudioBuffer(
	buffer: AudioBuffer,
	samples: AudioSamples,
	channels: number,
	frames: number
): void {
	if (channels === 1) {
		buffer.copyToChannel(samples, 0);
		return;
	}
	copyPlanesToBuffer(buffer, deinterleaveSamples(samples, channels, frames));
}

/**
 * Convert a raw float32 PCM blob into an ``AudioBuffer``. Returns
 * ``null`` if the chunk's format is unsupported, its PCM payload is
 * empty, or it contains fewer than one full frame.
 */
function decodeFloat32(ctx: AudioContext, chunk: ChunkInput): AudioBuffer | null {
	const samples = parseFloat32Samples(chunk);
	if (samples == null) {
		return null;
	}
	const frames = Math.floor(samples.length / chunk.channels);
	if (frames === 0) {
		return null;
	}
	const buffer = ctx.createBuffer(chunk.channels, frames, chunk.sampleRate);
	fillAudioBuffer(buffer, samples, chunk.channels, frames);
	return buffer;
}

/**
 * Invoke every callback in ``callbacks`` swallowing per-callback errors
 * so one bad listener can't take down the rest of the chain. Callers
 * snapshot the array before calling so an unsubscribe fired from inside
 * a callback can't mutate the list mid-iteration.
 */
function invokeCallbacks(callbacks: ReadonlyArray<() => void>): void {
	for (const cb of callbacks) {
		try {
			cb();
		} catch {
			/* ignored */
		}
	}
}

/**
 * Lazily-constructed playback queue. ``AudioContext`` creation is
 * deferred until the first chunk because Chrome / Electron require a
 * user-gesture for the context to start out of the ``suspended`` state.
 */
export class TtsPlaybackQueue {
	private ctx: AudioContext | null = null;
	private playhead = 0;
	private activeRequestId: string | null = null;
	private scheduled: AudioBufferSourceNode[] = [];
	private endCallbacks: Array<() => void> = [];
	private startCallbacks: Array<() => void> = [];
	/** Request id we've already fired `onStart` for — once per request. */
	private startedFor: string | null = null;

	get isPlaying(): boolean {
		return this.activeRequestId !== null;
	}

	get currentRequestId(): string | null {
		return this.activeRequestId;
	}

	private ensureCtx(): AudioContext {
		const ctx = this.createOrReuseCtx();
		maybeResume(ctx);
		return ctx;
	}

	private createOrReuseCtx(): AudioContext {
		if (this.ctx == null || this.ctx.state === "closed") {
			this.ctx = new AudioContext();
		}
		return this.ctx;
	}

	/**
	 * Claim ``chunk`` for the active request, or signal that it must be
	 * dropped. Returns ``true`` if scheduling should proceed, ``false``
	 * if the chunk is stale from a cancelled request.
	 */
	private claimRequestId(chunk: ChunkInput): boolean {
		if (this.activeRequestId == null) {
			this.activeRequestId = chunk.requestId;
			return true;
		}
		return this.activeRequestId === chunk.requestId;
	}

	/**
	 * Wire ``buffer`` into a new gap-free source, schedule it at the
	 * running playhead, and advance the playhead by its duration.
	 */
	private scheduleSource(ctx: AudioContext, buffer: AudioBuffer): AudioBufferSourceNode {
		const source = ctx.createBufferSource();
		source.buffer = buffer;
		source.connect(ctx.destination);
		const startAt = Math.max(this.playhead, ctx.currentTime);
		source.start(startAt);
		this.playhead = startAt + buffer.duration;
		this.scheduled.push(source);
		return source;
	}

	/**
	 * First audible source for this request — synthesis latency is over,
	 * audio is now scheduled to play. Fire once per request so a UI in
	 * another window can flip its "loading" state to "playing".
	 */
	private maybeFireStart(): void {
		if (this.startedFor === this.activeRequestId) {
			return;
		}
		this.startedFor = this.activeRequestId;
		this.fireStart();
	}

	/**
	 * Schedule ``chunk``. Drops the chunk if its ``requestId`` doesn't
	 * match the active request (i.e. the user cancelled in flight).
	 */
	enqueue(chunk: ChunkInput): void {
		if (!this.claimRequestId(chunk)) {
			return;
		}
		const ctx = this.ensureCtx();
		const buffer = decodeFloat32(ctx, chunk);
		if (buffer == null) {
			return;
		}
		const source = this.scheduleSource(ctx, buffer);
		this.maybeFireStart();
		source.onended = () => {
			// Remove from the live list; if this was the last scheduled
			// source for the active request and a "final" chunk has been
			// consumed, fire the end callbacks.
			this.scheduled = this.scheduled.filter((s) => s !== source);
			this.maybeFinish();
		};
	}

	/**
	 * Signal that the server has emitted a ``tts_complete`` for the
	 * active request. The queue keeps playing any scheduled-but-unplayed
	 * audio; ``maybeFinish`` fires the end callbacks once the last
	 * source completes.
	 */
	markComplete(requestId: string): void {
		if (this.activeRequestId !== requestId) {
			return;
		}
		this.maybeFinish();
	}

	/** Abort playback immediately. Any in-flight scheduled sources are stopped. */
	stop(): void {
		for (const source of this.scheduled) {
			stopAndDisconnect(source);
		}
		this.scheduled = [];
		this.activeRequestId = null;
		this.startedFor = null;
		this.resetPlayhead();
		this.fireEnd();
	}

	/**
	 * Reset the playhead so the next request starts at "now" rather
	 * than continuing from the abandoned schedule.
	 */
	private resetPlayhead(): void {
		this.playhead = this.ctx ? this.ctx.currentTime : 0;
	}

	private maybeFinish(): void {
		if (this.scheduled.length > 0) {
			return;
		}
		this.activeRequestId = null;
		this.startedFor = null;
		this.fireEnd();
	}

	private fireStart(): void {
		// Same no-clear snapshot contract as `fireEnd` — the long-lived
		// `useTtsPlayback` subscriber must be notified for every request.
		invokeCallbacks(this.startCallbacks.slice());
	}

	/** Fires when the first audible source of a request is scheduled. */
	onStart(cb: () => void): () => void {
		this.startCallbacks.push(cb);
		return () => {
			this.startCallbacks = this.startCallbacks.filter((c) => c !== cb);
		};
	}

	private fireEnd(): void {
		// Snapshot so an unsubscribe fired from within a callback can't
		// mutate the list mid-iteration. Crucially we do NOT clear
		// `endCallbacks` here — a single long-lived subscriber (the global
		// `useTtsPlayback` hook) must keep being notified for every
		// playback, not just the first one.
		invokeCallbacks(this.endCallbacks.slice());
	}

	onEnd(cb: () => void): () => void {
		this.endCallbacks.push(cb);
		return () => {
			this.endCallbacks = this.endCallbacks.filter((c) => c !== cb);
		};
	}

	dispose(): void {
		this.stop();
		if (this.ctx && this.ctx.state !== "closed") {
			this.ctx.close().catch(() => {
				/* ignored */
			});
		}
		this.ctx = null;
		this.endCallbacks = [];
		this.startCallbacks = [];
	}
}

/**
 * Best-effort resume of a suspended context. The user-gesture rule
 * means this only succeeds when the queue is started from a click /
 * key event — otherwise playback simply won't start.
 */
function maybeResume(ctx: AudioContext): void {
	if (ctx.state !== "suspended") {
		return;
	}
	ctx.resume().catch(() => {
		/* ignored — playback will simply not start */
	});
}

/**
 * Stop and disconnect a scheduled source. The node may have already
 * ended naturally — Web Audio throws synchronously in that case, which
 * we swallow.
 */
function stopAndDisconnect(source: AudioBufferSourceNode): void {
	try {
		source.stop();
		source.disconnect();
	} catch {
		/* node may have already ended */
	}
}
