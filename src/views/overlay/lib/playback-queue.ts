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
	/** ``f32le`` = raw little-endian float32 PCM (local Kokoro fast path). Any
	 *  other value is an encoded container — e.g. ``mp3`` for cloud ElevenLabs,
	 *  whose raw-PCM formats need a paid tier — which the queue decodes via Web
	 *  Audio ``decodeAudioData``. */
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
	ch: number,
): AudioSamples {
	const out = new Float32Array(
		new ArrayBuffer(frames * Float32Array.BYTES_PER_ELEMENT),
	);
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
	frames: number,
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
export function copyPlanesToBuffer(
	buffer: AudioBuffer,
	planes: AudioSamples[],
): void {
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
	frames: number,
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
function decodeFloat32(
	ctx: AudioContext,
	chunk: ChunkInput,
): AudioBuffer | null {
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
 * deferred until the first chunk because Chrome / the reference require a
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
	/** In-flight async decodes (encoded chunks). `maybeFinish` waits on these so
	 *  a `markComplete` arriving before a decode resolves can't fire `onEnd`
	 *  before the decoded audio is even scheduled. */
	private pendingDecodes = 0;
	/** User-selected output device id (`""` = system default). */
	private outputDeviceId = "";
	/** Analyser tapping the post-mix signal so the overlay visualiser can read a
	 *  live RMS level off the *actual* spoken audio. Sits between every source and
	 *  `ctx.destination`; rebuilt whenever the context is (see `createOrReuseCtx`). */
	private analyser: AnalyserNode | null = null;
	/** Scratch buffer for `getByteTimeDomainData` (length === `analyser.fftSize`). */
	private levelData: Uint8Array<ArrayBuffer> | null = null;
	/** User-paused via `pause()` → `ctx.suspend()`. Gates the auto-resume in
	 *  `ensureCtx` so a chunk arriving mid-pause can't silently un-pause. */
	private paused = false;
	/** Volume gain node between the source fan-in and the analyser
	 *  (`source → gain → analyser → destination`). Rebuilt with the context (see
	 *  `createOrReuseCtx`); `volume`/`muted` are re-applied by `ensureGraph`, so a
	 *  sink / context swap keeps the user's level. */
	private gain: GainNode | null = null;
	/** Persisted user volume in `[0, 1]` (pre-mute). Survives a context rebuild. */
	private volume = 1;
	/** Persisted mute latch; the gain target is `muted ? 0 : volume`. */
	private muted = false;
	/** Ordered playback timeline — every decoded buffer in the order it was
	 *  scheduled, with its cumulative start offset (seconds) within the read. NOT
	 *  pruned on `onended`, so {@link seek} can re-address already-played audio.
	 *  Reset per request (`claimRequestId`) and on {@link stop}. */
	private timeline: Array<{ buffer: AudioBuffer; offset: number }> = [];
	/** Total buffered media seconds = sum of `timeline` durations. Grows while
	 *  streaming; final once `markComplete` arrives. Also the furthest seekable
	 *  point (we only retain fully-decoded buffers). */
	private bufferedDuration = 0;
	/** True once `markComplete` fired for the active request (duration is final). */
	private complete = false;
	/** Anchor mapping the ctx clock → media position: at clock `anchorCtx` the
	 *  played position was `anchorMedia`. {@link getCurrentTime} extrapolates from
	 *  here; {@link pause}/{@link resume}/{@link seek} re-anchor. */
	private anchorCtx = 0;
	private anchorMedia = 0;
	/** Set on {@link resume}; the next {@link getCurrentTime} re-anchors `anchorCtx`
	 *  to the live clock once the context is actually running again (resume is
	 *  async), so the position is exact whether or not the clock advanced while
	 *  suspended. */
	private reanchorOnResume = false;
	/** Monotonic schedule generation, bumped by {@link seek} and {@link stop}. A
	 *  source's `onended` only counts toward finishing if its captured generation
	 *  still matches — so the sources we stop mid-seek can't fire `onEnd`. */
	private generation = 0;

	/**
	 * Switch the user-selected output sink. Applied to a new AudioContext
	 * on the next utterance; an in-flight context is also re-routed via
	 * `setSinkId` so the change is heard immediately when supported.
	 *
	 * The playhead is intentionally NOT realigned here: `setSinkId` reroutes
	 * the *same* context's output, so already-scheduled sources keep their
	 * timeline and continue gap-free on the new sink — re-anchoring would
	 * introduce an audible seam mid-utterance.
	 */
	setOutputDeviceId(deviceId: string): void {
		this.outputDeviceId = deviceId;
		const ctx = this.ctx as
			| (AudioContext & {
					setSinkId?: (id: string | { type: "none" }) => Promise<void>;
			  })
			| null;
		if (ctx?.setSinkId) {
			// Observability: a rejected re-route (device unplugged / unreachable)
			// is non-fatal — playback continues on the previous sink — but it was
			// previously swallowed with no trace. Warn so a "device switch did
			// nothing" report is diagnosable instead of silent.
			ctx.setSinkId(deviceId || { type: "none" }).catch((err) => {
				console.warn(
					"[tts] setSinkId re-route failed; staying on the previous sink",
					err,
				);
			});
		}
	}

	get isPlaying(): boolean {
		return this.activeRequestId !== null;
	}

	get currentRequestId(): string | null {
		return this.activeRequestId;
	}

	get isPaused(): boolean {
		return this.paused;
	}

	/**
	 * Live playback level in ``[0, 1]`` — RMS of the analyser's time-domain
	 * window. Returns ``0`` when nothing is playing (no active request, or no
	 * analyser built yet) so the visualiser rests flat between utterances.
	 */
	getLevel(): number {
		const analyser = this.analyser;
		const data = this.levelData;
		if (analyser == null || data == null || this.activeRequestId == null) {
			return 0;
		}
		analyser.getByteTimeDomainData(data);
		let sumSquares = 0;
		for (const raw of data) {
			// Samples are centred at 128 (silence); deflection is the amplitude.
			const sample = raw - 128;
			sumSquares += sample * sample;
		}
		// 128 = full-scale deflection, so a full-scale sine reads ~0.7 (its RMS).
		return Math.sqrt(sumSquares / data.length) / 128;
	}

	/**
	 * Pause playback by suspending the audio context. The schedule and playhead
	 * survive (they're ``ctx.currentTime``-relative), so {@link resume} continues
	 * exactly where it left off. The ``paused`` flag is set even when there's no
	 * running context yet so a not-quite-started utterance stays paused.
	 */
	pause(): void {
		this.paused = true;
		const ctx = this.ctx;
		if (ctx != null && ctx.state === "running") {
			// Freeze the played position before the clock stops so the time label
			// holds steady through the pause (and resume continues from here).
			this.anchorMedia = this.getCurrentTime();
			this.anchorCtx = ctx.currentTime;
			ctx.suspend().catch(() => {
				/* ignored — best effort */
			});
		}
	}

	/** Resume a {@link pause}d context. No-op unless currently suspended. */
	resume(): void {
		this.paused = false;
		const ctx = this.ctx;
		if (ctx != null && ctx.state === "suspended") {
			// Resume is async; re-anchor to the live clock on the next read so the
			// position continues smoothly from where it paused.
			this.reanchorOnResume = true;
			ctx.resume().catch(() => {
				/* ignored — best effort */
			});
		}
	}

	/**
	 * Current played position in seconds, clamped to the buffered range. While
	 * the context is not running (paused) the clock is frozen, so this holds at
	 * `anchorMedia` regardless of whether the runtime advances `currentTime`
	 * during suspension. After a {@link resume} the first call re-anchors to the
	 * live clock (resume is async).
	 */
	getCurrentTime(): number {
		const ctx = this.ctx;
		if (ctx == null || this.timeline.length === 0) {
			return this.anchorMedia;
		}
		if (ctx.state !== "running") {
			return Math.min(this.anchorMedia, this.bufferedDuration);
		}
		if (this.reanchorOnResume) {
			this.anchorCtx = ctx.currentTime;
			this.reanchorOnResume = false;
		}
		const elapsed = ctx.currentTime - this.anchorCtx;
		const pos = this.anchorMedia + Math.max(0, elapsed);
		return Math.min(pos, this.bufferedDuration);
	}

	/** Total buffered media seconds — grows while streaming, final after
	 *  `markComplete`. */
	getDuration(): number {
		return this.bufferedDuration;
	}

	/** Furthest seekable point in seconds (== {@link getDuration}; we only retain
	 *  fully-decoded buffers). */
	getBufferedEnd(): number {
		return this.bufferedDuration;
	}

	/** True once the server signalled `tts_complete` for the active read. */
	get isComplete(): boolean {
		return this.complete;
	}

	get currentVolume(): number {
		return this.volume;
	}

	get isMuted(): boolean {
		return this.muted;
	}

	/**
	 * Set the playback volume in `[0, 1]` (pre-mute). Applied to the live gain via
	 * a short `setTargetAtTime` ramp (click-free) and persisted so it survives a
	 * context rebuild. While muted the audible level stays 0, but the stored value
	 * still updates so unmuting restores it.
	 */
	setVolume(volume: number): void {
		this.volume = Math.max(0, Math.min(1, volume));
		if (this.gain != null && !this.muted) {
			this.rampGain(this.volume);
		}
	}

	/** Mute / unmute. The gain ramps to `0` (muted) or the stored `volume`. */
	setMuted(muted: boolean): void {
		this.muted = muted;
		if (this.gain != null) {
			this.rampGain(muted ? 0 : this.volume);
		}
	}

	/** Ramp the gain to `target` with a short time constant to avoid a click. */
	private rampGain(target: number): void {
		const when = this.ctx ? this.ctx.currentTime : 0;
		this.gain?.gain.setTargetAtTime(target, when, 0.015);
	}

	/**
	 * Jump playback to `targetSeconds`, clamped to the buffered range (and kept
	 * just shy of the end while still streaming, so a zero-length tail can't fire
	 * a premature finish). Stops the live sources without firing `onEnd` (the
	 * generation bump neutralises their `onended`), then reschedules every buffer
	 * from the seek point forward gap-free via `source.start(when, offset)`.
	 * Honors the current pause state: a paused read is re-suspended so it stays
	 * parked at the new position until {@link resume}.
	 */
	seek(targetSeconds: number): void {
		const ctx = this.ctx;
		if (ctx == null || this.timeline.length === 0) {
			return;
		}
		const cap = this.complete
			? this.bufferedDuration
			: Math.max(0, this.bufferedDuration - 0.05);
		const target = Math.max(0, Math.min(targetSeconds, cap));

		// Supersede the live sources: bump first so their `onended` is a no-op,
		// then stop them.
		this.generation += 1;
		for (const source of this.scheduled) {
			stopAndDisconnect(source);
		}
		this.scheduled = [];

		// Locate the buffer covering `target` (the last buffer when target == end).
		let idx = this.timeline.findIndex(
			(t) => target < t.offset + t.buffer.duration,
		);
		if (idx === -1) {
			idx = this.timeline.length - 1;
		}
		const head = this.timeline[idx];
		const intra = head ? Math.max(0, target - head.offset) : 0;

		// Reschedule from `idx` forward, gap-free, starting "now".
		this.playhead = ctx.currentTime;
		const gen = this.generation;
		for (let i = idx; i < this.timeline.length; i++) {
			const entry = this.timeline[i];
			if (!entry) {
				continue;
			}
			const offset = i === idx ? intra : 0;
			const startAt = Math.max(this.playhead, ctx.currentTime);
			const source = ctx.createBufferSource();
			source.buffer = entry.buffer;
			source.connect(this.ensureGraph(ctx));
			source.start(startAt, offset);
			this.playhead = startAt + (entry.buffer.duration - offset);
			this.scheduled.push(source);
			source.onended = () => {
				if (gen !== this.generation) {
					return;
				}
				this.scheduled = this.scheduled.filter((s) => s !== source);
				this.maybeFinish();
			};
		}

		// At clock `ctx.currentTime`, the played position is now `target`.
		this.anchorCtx = ctx.currentTime;
		this.anchorMedia = target;
		this.reanchorOnResume = false;

		// Keep a paused read parked at the new spot.
		if (this.paused && ctx.state === "running") {
			ctx.suspend().catch(() => {
				/* ignored — best effort */
			});
		}
	}

	private ensureCtx(): AudioContext {
		const ctx = this.createOrReuseCtx();
		// Don't fight a user pause: a chunk arriving mid-pause must NOT resume the
		// context — that's the pill's job via `resume()`.
		if (!this.paused) {
			maybeResume(ctx);
		}
		return ctx;
	}

	private createOrReuseCtx(): AudioContext {
		if (this.ctx == null || !isReusableState(this.ctx.state)) {
			// `sinkId` is declared on `AudioContextOptions` via
			// `src/dom-augment.d.ts` (Chromium M114+) — no cast needed.
			const opts: AudioContextOptions | undefined = this.outputDeviceId
				? { sinkId: this.outputDeviceId }
				: undefined;
			this.ctx = opts ? new AudioContext(opts) : new AudioContext();
			// The analyser + gain belong to the *old* context — drop them so
			// `ensureGraph` rebuilds them wired into the new context's destination.
			this.analyser = null;
			this.gain = null;
		}
		return this.ctx;
	}

	/**
	 * Lazily build the playback graph for ``ctx`` — a gain node feeding an
	 * analyser feeding the destination (``source → gain → analyser →
	 * destination``) — and return the gain node every source connects through.
	 * Gain sits BEFORE the analyser so {@link getLevel} (and the overlay
	 * visualiser) reflects the audible, post-volume signal: muting calms the bars.
	 * `volume`/`muted` are re-applied here so they survive a context rebuild.
	 * Rebuilt whenever the context is.
	 */
	private ensureGraph(ctx: AudioContext): GainNode {
		if (this.analyser == null) {
			const analyser = ctx.createAnalyser();
			// 1024 samples ≈ 21 ms @ 48 kHz — snappy enough for a 60 fps meter
			// without being noisy.
			analyser.fftSize = 1024;
			analyser.connect(ctx.destination);
			this.analyser = analyser;
			this.levelData = new Uint8Array(analyser.fftSize);
		}
		if (this.gain == null) {
			const gain = ctx.createGain();
			gain.gain.value = this.muted ? 0 : this.volume;
			gain.connect(this.analyser);
			this.gain = gain;
		}
		return this.gain;
	}

	/**
	 * Claim ``chunk`` for the active request, or signal that it must be
	 * dropped. Returns ``true`` if scheduling should proceed, ``false``
	 * if the chunk is stale from a cancelled request.
	 */
	private claimRequestId(chunk: ChunkInput): boolean {
		if (this.activeRequestId == null) {
			this.activeRequestId = chunk.requestId;
			// Fresh read — start the position timeline at 0 (a prior read may have
			// ended naturally without a `stop()`, leaving its timeline behind).
			this.resetTimelineState();
			return true;
		}
		return this.activeRequestId === chunk.requestId;
	}

	/** Reset the per-read position timeline so a freshly-claimed request starts
	 *  at 0. Does not touch `scheduled`/`paused` (caller-owned). */
	private resetTimelineState(): void {
		this.timeline = [];
		this.bufferedDuration = 0;
		this.complete = false;
		this.anchorCtx = 0;
		this.anchorMedia = 0;
		this.reanchorOnResume = false;
	}

	/**
	 * Wire ``buffer`` into a new gap-free source, schedule it at the
	 * running playhead, and advance the playhead by its duration.
	 */
	private scheduleSource(
		ctx: AudioContext,
		buffer: AudioBuffer,
	): AudioBufferSourceNode {
		const source = ctx.createBufferSource();
		source.buffer = buffer;
		source.connect(this.ensureGraph(ctx));
		const startAt = Math.max(this.playhead, ctx.currentTime);
		// First audible buffer of the read: anchor the clock→media map at its
		// real start time (position 0 plays at clock `startAt`).
		if (this.timeline.length === 1) {
			this.anchorCtx = startAt;
			this.anchorMedia = 0;
		}
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
		// `f32le` is the raw-PCM fast path (local Kokoro). Anything else is an
		// encoded container (e.g. cloud ElevenLabs mp3 — raw PCM needs a paid
		// tier) that Web Audio must decode asynchronously.
		if (chunk.format === "f32le") {
			const buffer = decodeFloat32(ctx, chunk);
			if (buffer != null) {
				this.scheduleDecodedBuffer(ctx, buffer);
			}
			return;
		}
		this.enqueueEncoded(ctx, chunk);
	}

	/**
	 * Schedule an already-decoded buffer at the running playhead and wire its
	 * end → maybeFinish. Shared by the raw-f32le and async-decode paths.
	 */
	private scheduleDecodedBuffer(ctx: AudioContext, buffer: AudioBuffer): void {
		// Record on the timeline (with its cumulative offset) BEFORE scheduling so
		// `seek` can re-address it and `getDuration` grows as audio arrives.
		this.timeline.push({ buffer, offset: this.bufferedDuration });
		this.bufferedDuration += buffer.duration;
		const source = this.scheduleSource(ctx, buffer);
		this.maybeFireStart();
		const gen = this.generation;
		source.onended = () => {
			// A seek (or stop) since this source was scheduled supersedes it — its
			// end is meaningless to the current run.
			if (gen !== this.generation) {
				return;
			}
			// Remove from the live list; if this was the last scheduled source for
			// the active request (and no decode is pending), fire the end callbacks.
			this.scheduled = this.scheduled.filter((s) => s !== source);
			this.maybeFinish();
		};
	}

	/**
	 * Decode an encoded container chunk (cloud mp3) via Web Audio and schedule
	 * it. `pendingDecodes` keeps `maybeFinish` from firing `onEnd` before the
	 * decode resolves — a one-shot cloud utterance's `markComplete` arrives right
	 * after its single chunk, usually before the decode finishes.
	 */
	private enqueueEncoded(ctx: AudioContext, chunk: ChunkInput): void {
		const { requestId } = chunk;
		this.pendingDecodes += 1;
		// `decodeAudioData` detaches its input buffer — hand it a copy so the
		// original ArrayBuffer (and any other reader) stays intact.
		ctx
			.decodeAudioData(chunk.pcm.slice(0))
			.then((buffer) => {
				// Drop if the request was cancelled / superseded while decoding.
				if (this.activeRequestId === requestId) {
					this.scheduleDecodedBuffer(ctx, buffer);
				}
			})
			.catch(() => {
				/* undecodable audio — drop the chunk */
			})
			.finally(() => {
				this.pendingDecodes = Math.max(0, this.pendingDecodes - 1);
				// A `markComplete` may have arrived mid-decode; re-check now that
				// the decode (and any scheduling) has settled.
				this.maybeFinish();
			});
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
		// Generation is now final — let the UI render a fixed (non-growing) duration.
		this.complete = true;
		this.maybeFinish();
	}

	/** Abort playback immediately. Any in-flight scheduled sources are stopped. */
	stop(): void {
		// Supersede live sources so their `onended` (fired by `source.stop()`)
		// can't reach `maybeFinish` after we've already ended here.
		this.generation += 1;
		for (const source of this.scheduled) {
			stopAndDisconnect(source);
		}
		this.scheduled = [];
		// Abandon any in-flight decodes — their `.then` no-ops (activeRequestId is
		// cleared below) and their `.finally` maybeFinish is guarded to a no-op.
		this.pendingDecodes = 0;
		this.activeRequestId = null;
		this.startedFor = null;
		// Clear the pause latch so the next utterance isn't blocked from resuming.
		this.paused = false;
		this.resetTimelineState();
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
		// Wait for both scheduled sources AND in-flight decodes before ending.
		if (this.pendingDecodes > 0 || this.scheduled.length > 0) {
			return;
		}
		// Already finished/stopped — nothing to end. Guards the late-decode
		// `finally` from firing a second `onEnd` after `stop()` cleared the id.
		if (this.activeRequestId === null) {
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
		this.analyser = null;
		this.gain = null;
		this.levelData = null;
		this.endCallbacks = [];
		this.startCallbacks = [];
	}
}

/**
 * True when an existing context can still be played through. Only `"running"`
 * (ready) and `"suspended"` (recoverable via {@link maybeResume}) qualify.
 * `"closed"` is dead, and Safari/iOS's non-standard `"interrupted"` state
 * cannot schedule audio AND is never resumed by `maybeResume` (which only acts
 * on `"suspended"`) — so both must trigger a rebuild rather than a silent reuse
 * that would drop the utterance. `state` is typed as the standard union, so we
 * compare against the string to also catch the off-union `"interrupted"`.
 */
function isReusableState(state: string): boolean {
	return state === "running" || state === "suspended";
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
