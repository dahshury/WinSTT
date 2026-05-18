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
 * Convert a raw float32 PCM blob into an ``AudioBuffer``.
 *
 * The server emits little-endian float32. On every supported platform
 * (Windows x64, macOS arm64/x64) JS ``Float32Array`` is also LE, so we
 * can wrap the bytes directly without endianness conversion.
 */
function decodeFloat32(ctx: AudioContext, chunk: ChunkInput): AudioBuffer | null {
	if (chunk.format !== "f32le") {
		return null;
	}
	const samples = new Float32Array(chunk.pcm);
	if (samples.length === 0) {
		return null;
	}
	const frames = Math.floor(samples.length / chunk.channels);
	if (frames === 0) {
		return null;
	}
	const buffer = ctx.createBuffer(chunk.channels, frames, chunk.sampleRate);
	if (chunk.channels === 1) {
		buffer.copyToChannel(samples, 0);
		return buffer;
	}
	// Interleaved → planar: deinterleave per channel.
	for (let ch = 0; ch < chunk.channels; ch++) {
		const out = new Float32Array(frames);
		for (let i = 0; i < frames; i++) {
			out[i] = samples[i * chunk.channels + ch] ?? 0;
		}
		buffer.copyToChannel(out, ch);
	}
	return buffer;
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

	get isPlaying(): boolean {
		return this.activeRequestId !== null;
	}

	get currentRequestId(): string | null {
		return this.activeRequestId;
	}

	private ensureCtx(): AudioContext {
		if (this.ctx == null || this.ctx.state === "closed") {
			this.ctx = new AudioContext();
		}
		if (this.ctx.state === "suspended") {
			// Best-effort resume; the user-gesture rule means this only
			// succeeds if the queue is started from a click/key event.
			this.ctx.resume().catch(() => {
				/* ignored — playback will simply not start */
			});
		}
		return this.ctx;
	}

	/**
	 * Schedule ``chunk``. Drops the chunk if its ``requestId`` doesn't
	 * match the active request (i.e. the user cancelled in flight).
	 */
	enqueue(chunk: ChunkInput): void {
		if (this.activeRequestId == null) {
			this.activeRequestId = chunk.requestId;
		} else if (this.activeRequestId !== chunk.requestId) {
			// Drop stale chunks from a previous request that was cancelled.
			return;
		}
		const ctx = this.ensureCtx();
		const buffer = decodeFloat32(ctx, chunk);
		if (buffer == null) {
			return;
		}
		const source = ctx.createBufferSource();
		source.buffer = buffer;
		source.connect(ctx.destination);
		const now = ctx.currentTime;
		const startAt = Math.max(this.playhead, now);
		source.start(startAt);
		this.playhead = startAt + buffer.duration;
		this.scheduled.push(source);
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
			try {
				source.stop();
				source.disconnect();
			} catch {
				/* node may have already ended */
			}
		}
		this.scheduled = [];
		this.activeRequestId = null;
		// Reset the playhead so the next request starts at "now" rather
		// than continuing from the abandoned schedule.
		if (this.ctx) {
			this.playhead = this.ctx.currentTime;
		} else {
			this.playhead = 0;
		}
		this.fireEnd();
	}

	private maybeFinish(): void {
		if (this.scheduled.length > 0) {
			return;
		}
		this.activeRequestId = null;
		this.fireEnd();
	}

	private fireEnd(): void {
		const callbacks = this.endCallbacks.slice();
		this.endCallbacks = [];
		for (const cb of callbacks) {
			try {
				cb();
			} catch {
				/* ignored */
			}
		}
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
	}
}
