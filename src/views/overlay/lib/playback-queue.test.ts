import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type ChunkInput,
	copyPlanesToBuffer,
	deinterleaveSamples,
	fillAudioBuffer,
	parseFloat32Samples,
	TtsPlaybackQueue,
} from "./playback-queue";

// happy-dom does not implement Web Audio. We install a controllable fake
// AudioContext that records buffer creation, source scheduling, resume /
// close calls, and exposes hooks for tests to drive ``onended``.

const OriginalAudioContext = (globalThis as { AudioContext?: unknown })
	.AudioContext;

interface FakeSource {
	buffer: FakeBuffer | null;
	connect: () => void;
	disconnect: () => void;
	disconnected: boolean;
	onended: (() => void) | null;
	start: (when?: number) => void;
	startedAt: number;
	stop: () => void;
	stopped: boolean;
}

interface FakeBuffer {
	channelData: Float32Array[];
	channels: number;
	duration: number;
	frames: number;
	sampleRate: number;
}

interface FakeAnalyser {
	connect: () => void;
	disconnect: () => void;
	fftSize: number;
	getByteTimeDomainData: (arr: Uint8Array) => void;
}

let createdSources: FakeSource[] = [];
let createdBuffers: FakeBuffer[] = [];
let createdContexts: FakeAudioContext[] = [];
let createdAnalysers: FakeAnalyser[] = [];
let constructedSinkIds: Array<string | undefined> = [];
let setSinkIdCalls: Array<string | { type: "none" }> = [];
let resumeCalls = 0;
let suspendCalls = 0;
let closeCalls = 0;
// Byte value the fake analyser fills `getByteTimeDomainData` with (128 = silence).
let analyserFillValue = 128;
let ctxState: "running" | "suspended" | "closed" = "running";
let ctxClosedAfterClose = true;
let currentTime = 0;
let resumeShouldReject = false;
let closeShouldReject = false;
let provideSetSinkId = true;
let setSinkIdShouldReject = false;
let decodeShouldReject = false;

class FakeAudioContext {
	state: "running" | "suspended" | "closed" = ctxState;
	constructor(opts?: { sinkId?: string }) {
		constructedSinkIds.push(opts?.sinkId);
		createdContexts.push(this);
		if (provideSetSinkId) {
			(
				this as unknown as {
					setSinkId: (id: string | { type: "none" }) => Promise<void>;
				}
			).setSinkId = (id) => {
				setSinkIdCalls.push(id);
				return setSinkIdShouldReject
					? Promise.reject(new Error("setSinkId failed"))
					: Promise.resolve();
			};
		}
	}
	get currentTime(): number {
		return currentTime;
	}
	get destination() {
		return {};
	}
	createBuffer(
		channels: number,
		frames: number,
		sampleRate: number,
	): FakeBuffer {
		const channelData: Float32Array[] = [];
		for (let i = 0; i < channels; i++) {
			channelData.push(new Float32Array(frames));
		}
		const buf: FakeBuffer = {
			channels,
			frames,
			sampleRate,
			duration: frames / sampleRate,
			channelData,
			// `copyToChannel` is a method on real AudioBuffer; attach inline.
		} as FakeBuffer;
		(
			buf as unknown as {
				copyToChannel: (data: Float32Array, ch: number) => void;
			}
		).copyToChannel = (data, ch) => {
			const target = channelData[ch];
			if (target) {
				target.set(data.subarray(0, target.length));
			}
		};
		createdBuffers.push(buf);
		return buf;
	}
	createBufferSource(): FakeSource {
		const src: FakeSource = {
			buffer: null,
			onended: null,
			startedAt: 0,
			stopped: false,
			disconnected: false,
			connect: () => undefined,
			disconnect() {
				this.disconnected = true;
			},
			start(when = 0) {
				this.startedAt = when;
			},
			stop() {
				this.stopped = true;
			},
		};
		createdSources.push(src);
		return src;
	}
	createAnalyser(): FakeAnalyser {
		const analyser: FakeAnalyser = {
			fftSize: 2048,
			connect: () => undefined,
			disconnect: () => undefined,
			getByteTimeDomainData: (arr) => {
				arr.fill(analyserFillValue);
			},
		};
		createdAnalysers.push(analyser);
		return analyser;
	}
	resume(): Promise<void> {
		resumeCalls += 1;
		if (resumeShouldReject) {
			return Promise.reject(new Error("resume failed"));
		}
		this.state = "running";
		return Promise.resolve();
	}
	suspend(): Promise<void> {
		suspendCalls += 1;
		this.state = "suspended";
		return Promise.resolve();
	}
	close(): Promise<void> {
		closeCalls += 1;
		if (ctxClosedAfterClose) {
			this.state = "closed";
		}
		if (closeShouldReject) {
			return Promise.reject(new Error("close failed"));
		}
		return Promise.resolve();
	}
	decodeAudioData(_data: ArrayBuffer): Promise<FakeBuffer> {
		if (decodeShouldReject) {
			return Promise.reject(new Error("decode failed"));
		}
		// A minimal decoded buffer — 1 channel, 1200 frames @ 24 kHz.
		return Promise.resolve(this.createBuffer(1, 1200, 24_000));
	}
}

// Contained boundary casts. The fakes implement only the Web Audio surface the
// queue touches; these helpers hold the single unavoidable cast between the
// fake and the real type (FakeAudioContext → AudioContext for injection, and
// AudioBuffer → FakeBuffer to read back the recorded channel data). Each helper
// returns the exact same object it was given.
const asAudioContext = (ctx: FakeAudioContext) =>
	ctx as unknown as AudioContext;
const asFakeBuffer = (buffer: AudioBuffer) => buffer as unknown as FakeBuffer;

// Flush ALL pending microtasks. The encoded-decode path chains
// `decodeAudioData().then().catch().finally()`; a couple of `await
// Promise.resolve()` hops don't drain it (notably the `finally` that decrements
// `pendingDecodes`). A `setTimeout(0)` macrotask runs after the microtask queue
// is empty, so awaiting it guarantees the whole decode chain has settled.
const flushMicrotasks = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

function reset(): void {
	createdSources = [];
	createdBuffers = [];
	createdContexts = [];
	createdAnalysers = [];
	constructedSinkIds = [];
	setSinkIdCalls = [];
	resumeCalls = 0;
	suspendCalls = 0;
	analyserFillValue = 128;
	closeCalls = 0;
	ctxState = "running";
	ctxClosedAfterClose = true;
	currentTime = 0;
	resumeShouldReject = false;
	closeShouldReject = false;
	provideSetSinkId = true;
	setSinkIdShouldReject = false;
	decodeShouldReject = false;
	(globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
}

beforeEach(reset);
afterEach(() => {
	(globalThis as { AudioContext?: unknown }).AudioContext =
		OriginalAudioContext;
});

function makeF32leChunk(
	requestId: string,
	samples: number[],
	channels = 1,
	sampleRate = 24_000,
): ChunkInput {
	const arr = new Float32Array(samples);
	return {
		requestId,
		sampleRate,
		channels,
		format: "f32le",
		pcm: arr.buffer,
	};
}

// An encoded (container) chunk — the shape the cloud ElevenLabs path emits.
// The fake AudioContext.decodeAudioData ignores the bytes and returns a stub
// decoded buffer, so the payload contents don't matter here.
function makeEncodedChunk(requestId: string, format = "mp3"): ChunkInput {
	return {
		requestId,
		sampleRate: 0,
		channels: 1,
		format,
		pcm: new Uint8Array([1, 2, 3, 4]).buffer,
	};
}

describe("parseFloat32Samples", () => {
	test("returns null for non-f32le formats", () => {
		expect(
			parseFloat32Samples({ ...makeF32leChunk("r", [0]), format: "s16le" }),
		).toBeNull();
	});

	test("returns null for empty PCM payload", () => {
		expect(parseFloat32Samples(makeF32leChunk("r", []))).toBeNull();
	});

	test("returns a Float32Array view over the PCM payload", () => {
		const view = parseFloat32Samples(makeF32leChunk("r", [0.5, -0.25]));
		expect(view).not.toBeNull();
		expect(Array.from(view ?? new Float32Array())).toEqual([0.5, -0.25]);
	});
});

describe("deinterleaveSamples", () => {
	test("deinterleaves interleaved stereo into per-channel planes", () => {
		const interleaved = new Float32Array([1, 2, 3, 4, 5, 6]);
		const planes = deinterleaveSamples(interleaved, 2, 3);
		expect(planes).toHaveLength(2);
		expect(Array.from(planes[0] ?? [])).toEqual([1, 3, 5]);
		expect(Array.from(planes[1] ?? [])).toEqual([2, 4, 6]);
	});

	test("pads missing samples with zero", () => {
		// Only 5 samples for 3 frames × 2 channels (6 expected) — last sample missing.
		const interleaved = new Float32Array([1, 2, 3, 4, 5]);
		const planes = deinterleaveSamples(interleaved, 2, 3);
		expect(Array.from(planes[1] ?? [])).toEqual([2, 4, 0]);
	});
});

describe("copyPlanesToBuffer", () => {
	test("copies each plane into the matching channel", () => {
		const planes = [new Float32Array([0.1, 0.2]), new Float32Array([0.3, 0.4])];
		const ctx = asAudioContext(new FakeAudioContext());
		const buffer = ctx.createBuffer(2, 2, 24_000);
		copyPlanesToBuffer(buffer, planes);
		const fake = asFakeBuffer(buffer);
		expect(Array.from(fake.channelData[0] ?? [])).toEqual([
			expect.closeTo(0.1, 6),
			expect.closeTo(0.2, 6),
		]);
		expect(Array.from(fake.channelData[1] ?? [])).toEqual([
			expect.closeTo(0.3, 6),
			expect.closeTo(0.4, 6),
		]);
	});
});

describe("fillAudioBuffer", () => {
	test("mono path copies samples directly", () => {
		const ctx = asAudioContext(new FakeAudioContext());
		const buffer = ctx.createBuffer(1, 3, 24_000);
		fillAudioBuffer(buffer, new Float32Array([0.1, 0.2, 0.3]), 1, 3);
		expect(Array.from(asFakeBuffer(buffer).channelData[0] ?? [])).toEqual([
			expect.closeTo(0.1, 6),
			expect.closeTo(0.2, 6),
			expect.closeTo(0.3, 6),
		]);
	});

	test("multi-channel path deinterleaves into matching channels", () => {
		const ctx = asAudioContext(new FakeAudioContext());
		const buffer = ctx.createBuffer(2, 2, 24_000);
		fillAudioBuffer(buffer, new Float32Array([1, 2, 3, 4]), 2, 2);
		const fake = asFakeBuffer(buffer);
		expect(Array.from(fake.channelData[0] ?? [])).toEqual([1, 3]);
		expect(Array.from(fake.channelData[1] ?? [])).toEqual([2, 4]);
	});
});

describe("TtsPlaybackQueue.enqueue", () => {
	test("schedules a source for the first chunk and adopts the request id", () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("req-1", [0.1, 0.2, 0.3]));
		expect(createdSources).toHaveLength(1);
		expect(queue.currentRequestId).toBe("req-1");
		expect(queue.isPlaying).toBe(true);
	});

	test("drops chunks from a different request id", () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("req-1", [0.1]));
		queue.enqueue(makeF32leChunk("req-2", [0.2]));
		expect(createdSources).toHaveLength(1);
	});

	test("drops an undecodable encoded chunk (decodeAudioData rejects)", async () => {
		decodeShouldReject = true;
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeEncodedChunk("r"));
		await Promise.resolve();
		await Promise.resolve();
		expect(createdSources).toHaveLength(0);
	});

	test("drops empty PCM payloads", () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", []));
		expect(createdSources).toHaveLength(0);
	});

	test("drops chunks with fewer than one full frame", () => {
		const queue = new TtsPlaybackQueue();
		// 1 sample but 2 channels → 0 frames.
		queue.enqueue(makeF32leChunk("r", [0.1], 2));
		expect(createdSources).toHaveLength(0);
	});

	test("schedules consecutive chunks back-to-back at the running playhead", () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", new Array(12_000).fill(0)));
		queue.enqueue(makeF32leChunk("r", new Array(12_000).fill(0)));
		expect(createdSources).toHaveLength(2);
		// Second source must start no earlier than first source's duration (0.5s).
		expect(createdSources[1]?.startedAt).toBeGreaterThanOrEqual(0.5);
	});

	test("fires onStart exactly once per request, even across many chunks", () => {
		const queue = new TtsPlaybackQueue();
		let starts = 0;
		queue.onStart(() => {
			starts += 1;
		});
		queue.enqueue(makeF32leChunk("r1", [0.1]));
		queue.enqueue(makeF32leChunk("r1", [0.2]));
		queue.enqueue(makeF32leChunk("r1", [0.3]));
		expect(starts).toBe(1);
	});

	test("source.onended fires onEnd once all scheduled sources finish", () => {
		const queue = new TtsPlaybackQueue();
		let ends = 0;
		queue.onEnd(() => {
			ends += 1;
		});
		queue.enqueue(makeF32leChunk("r", [0.1]));
		queue.enqueue(makeF32leChunk("r", [0.2]));
		// Drain in order.
		createdSources[0]?.onended?.();
		expect(ends).toBe(0); // one still scheduled
		createdSources[1]?.onended?.();
		expect(ends).toBe(1);
	});

	test("resumes a suspended AudioContext on enqueue", () => {
		ctxState = "suspended";
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		expect(resumeCalls).toBe(1);
	});

	test("swallows a rejected resume() so playback proceeds", async () => {
		ctxState = "suspended";
		resumeShouldReject = true;
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		// Let the rejected promise settle.
		await Promise.resolve();
		await Promise.resolve();
		expect(createdSources).toHaveLength(1);
	});
});

describe("TtsPlaybackQueue.enqueue (encoded / mp3 path)", () => {
	test("claims the request id synchronously, schedules after the async decode", async () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeEncodedChunk("r"));
		expect(queue.currentRequestId).toBe("r");
		// Decode is async — no source scheduled in the same tick.
		expect(createdSources).toHaveLength(0);
		await flushMicrotasks();
		expect(createdSources).toHaveLength(1);
	});

	test("fires onStart once the decoded buffer is scheduled (not before)", async () => {
		const queue = new TtsPlaybackQueue();
		let starts = 0;
		queue.onStart(() => {
			starts += 1;
		});
		queue.enqueue(makeEncodedChunk("r"));
		expect(starts).toBe(0);
		await flushMicrotasks();
		expect(starts).toBe(1);
	});

	test("markComplete BEFORE the decode resolves does NOT fire onEnd early", async () => {
		const queue = new TtsPlaybackQueue();
		let ends = 0;
		queue.onEnd(() => {
			ends += 1;
		});
		queue.enqueue(makeEncodedChunk("r"));
		// Cloud sends `tts_complete` right after the single chunk — pendingDecodes
		// must hold the finish until the decode resolves and schedules.
		queue.markComplete("r");
		expect(ends).toBe(0);
		await flushMicrotasks();
		expect(createdSources).toHaveLength(1);
		expect(ends).toBe(0); // scheduled source hasn't ended yet
		createdSources[0]?.onended?.();
		expect(ends).toBe(1);
	});

	test("a decode resolving AFTER stop() neither schedules nor re-fires onEnd", async () => {
		const queue = new TtsPlaybackQueue();
		let ends = 0;
		queue.onEnd(() => {
			ends += 1;
		});
		queue.enqueue(makeEncodedChunk("r"));
		queue.stop(); // fires onEnd once, clears the active id + pendingDecodes
		expect(ends).toBe(1);
		await flushMicrotasks();
		// The late decode is dropped (active id cleared) — no new source, no 2nd end.
		expect(createdSources).toHaveLength(0);
		expect(ends).toBe(1);
	});
});

describe("TtsPlaybackQueue.markComplete", () => {
	test("ignores a complete for a non-active request id", () => {
		const queue = new TtsPlaybackQueue();
		let ends = 0;
		queue.onEnd(() => {
			ends += 1;
		});
		queue.enqueue(makeF32leChunk("real", [0.1]));
		queue.markComplete("stale");
		expect(ends).toBe(0);
	});

	test("does not finish while sources are still scheduled", () => {
		const queue = new TtsPlaybackQueue();
		let ends = 0;
		queue.onEnd(() => {
			ends += 1;
		});
		queue.enqueue(makeF32leChunk("r", [0.1]));
		queue.markComplete("r");
		expect(ends).toBe(0);
	});

	test("fires onEnd if marked complete after all sources drained", () => {
		const queue = new TtsPlaybackQueue();
		let ends = 0;
		queue.onEnd(() => {
			ends += 1;
		});
		queue.enqueue(makeF32leChunk("r", [0.1]));
		createdSources[0]?.onended?.();
		// onended already fired end once via maybeFinish.
		expect(ends).toBe(1);
		// markComplete for the now-cleared request id is a no-op.
		queue.markComplete("r");
		expect(ends).toBe(1);
	});
});

describe("TtsPlaybackQueue.stop", () => {
	test("stops and disconnects every scheduled source", () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		queue.enqueue(makeF32leChunk("r", [0.2]));
		queue.stop();
		expect(createdSources.every((s) => s.stopped)).toBe(true);
		expect(createdSources.every((s) => s.disconnected)).toBe(true);
	});

	test("resets state and playhead so the next request starts fresh", () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", new Array(12_000).fill(0)));
		currentTime = 5;
		queue.stop();
		expect(queue.isPlaying).toBe(false);
		queue.enqueue(makeF32leChunk("r2", new Array(2400).fill(0)));
		// New source must start at or after currentTime (5), not at the abandoned playhead.
		expect(createdSources[1]?.startedAt).toBeGreaterThanOrEqual(5);
	});

	test("swallows a source.stop() throw (node already ended)", () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		const src = createdSources[0];
		if (src) {
			src.stop = () => {
				throw new Error("already stopped");
			};
		}
		expect(() => queue.stop()).not.toThrow();
	});

	test("fires onEnd", () => {
		const queue = new TtsPlaybackQueue();
		let ends = 0;
		queue.onEnd(() => {
			ends += 1;
		});
		queue.enqueue(makeF32leChunk("r", [0.1]));
		queue.stop();
		expect(ends).toBe(1);
	});

	test("playhead resets to 0 when no AudioContext was ever created", () => {
		const queue = new TtsPlaybackQueue();
		queue.stop(); // no ctx ever created
		expect(queue.isPlaying).toBe(false);
	});
});

describe("TtsPlaybackQueue subscriptions", () => {
	test("onStart returns an unsubscribe that prevents further notifications", () => {
		const queue = new TtsPlaybackQueue();
		let starts = 0;
		const un = queue.onStart(() => {
			starts += 1;
		});
		queue.enqueue(makeF32leChunk("r1", [0.1]));
		expect(starts).toBe(1);
		un();
		// New request — would normally fire onStart again — must NOT call us.
		queue.stop();
		queue.enqueue(makeF32leChunk("r2", [0.2]));
		expect(starts).toBe(1);
	});

	test("onEnd returns an unsubscribe that prevents further notifications", () => {
		const queue = new TtsPlaybackQueue();
		let ends = 0;
		const un = queue.onEnd(() => {
			ends += 1;
		});
		un();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		queue.stop();
		expect(ends).toBe(0);
	});

	test("swallows callback errors so one bad listener can't block others", () => {
		const queue = new TtsPlaybackQueue();
		let secondFired = 0;
		queue.onStart(() => {
			throw new Error("boom");
		});
		queue.onStart(() => {
			secondFired += 1;
		});
		queue.enqueue(makeF32leChunk("r", [0.1]));
		expect(secondFired).toBe(1);
	});
});

describe("TtsPlaybackQueue.dispose", () => {
	test("stops sources and closes the AudioContext", async () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		queue.dispose();
		expect(closeCalls).toBe(1);
	});

	test("can be called before any AudioContext was created", () => {
		const queue = new TtsPlaybackQueue();
		expect(() => queue.dispose()).not.toThrow();
	});

	test("swallows a rejected close() promise", async () => {
		closeShouldReject = true;
		ctxClosedAfterClose = false;
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		queue.dispose();
		await Promise.resolve();
		await Promise.resolve();
		// Just verify we got here without throwing.
		expect(closeCalls).toBe(1);
	});

	test("re-creates the AudioContext on a subsequent enqueue after dispose", () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		queue.dispose();
		// New chunk → new context, new source.
		queue.enqueue(makeF32leChunk("r2", [0.2]));
		expect(createdSources).toHaveLength(2);
	});
});

describe("TtsPlaybackQueue.setOutputDeviceId", () => {
	test("no-op when no AudioContext exists yet (just stores the id)", () => {
		const queue = new TtsPlaybackQueue();
		// No ctx created yet — `ctx?.setSinkId` short-circuits, nothing thrown.
		expect(() => queue.setOutputDeviceId("device-1")).not.toThrow();
		expect(setSinkIdCalls).toHaveLength(0);
		expect(createdContexts).toHaveLength(0);
	});

	test("constructs a NEW AudioContext with the stored sinkId on next enqueue", () => {
		const queue = new TtsPlaybackQueue();
		queue.setOutputDeviceId("device-7");
		queue.enqueue(makeF32leChunk("r", [0.1]));
		// `createOrReuseCtx` took the `opts ? new AudioContext(opts)` branch.
		expect(constructedSinkIds).toEqual(["device-7"]);
	});

	test("re-routes an in-flight AudioContext via setSinkId immediately", () => {
		const queue = new TtsPlaybackQueue();
		// Create a live context first.
		queue.enqueue(makeF32leChunk("r", [0.1]));
		expect(createdContexts).toHaveLength(1);
		queue.setOutputDeviceId("device-live");
		// `ctx?.setSinkId` truthy branch + `deviceId || {type:"none"}` truthy side.
		expect(setSinkIdCalls).toEqual(["device-live"]);
	});

	test("passes the {type:'none'} sentinel when deviceId is empty (system default)", () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		queue.setOutputDeviceId("");
		// `deviceId || {type:"none"}` falls through to the sentinel object.
		expect(setSinkIdCalls).toEqual([{ type: "none" }]);
	});

	test("does not call setSinkId when the platform lacks the API", () => {
		provideSetSinkId = false;
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		// `ctx?.setSinkId` is falsy → branch skipped, no throw.
		expect(() => queue.setOutputDeviceId("device-x")).not.toThrow();
		expect(setSinkIdCalls).toHaveLength(0);
	});

	test("swallows a rejected setSinkId() promise and warns (observability)", async () => {
		setSinkIdShouldReject = true;
		// Regression: the rejection was previously absorbed by `.catch(() =>
		// undefined)` with NO log, so a failed device switch was invisible. It now
		// warns while still absorbing the rejection (behaviour unchanged).
		const originalWarn = console.warn;
		const warnings: unknown[][] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(args);
		};
		try {
			const queue = new TtsPlaybackQueue();
			queue.enqueue(makeF32leChunk("r", [0.1]));
			queue.setOutputDeviceId("device-bad");
			// Let the rejected promise settle — the `.catch` must absorb it (no
			// unhandled rejection).
			await Promise.resolve();
			await Promise.resolve();
			expect(setSinkIdCalls).toEqual(["device-bad"]);
			expect(
				warnings.some((w) =>
					String(w[0]).includes("setSinkId re-route failed"),
				),
			).toBe(true);
		} finally {
			console.warn = originalWarn;
		}
	});

	test("stored sinkId survives a dispose → re-enqueue cycle", () => {
		const queue = new TtsPlaybackQueue();
		queue.setOutputDeviceId("device-persist");
		queue.enqueue(makeF32leChunk("r", [0.1]));
		queue.dispose();
		// After dispose the ctx is null; next enqueue rebuilds with the same id.
		queue.enqueue(makeF32leChunk("r2", [0.2]));
		expect(constructedSinkIds).toEqual(["device-persist", "device-persist"]);
	});
});

describe("TtsPlaybackQueue createOrReuseCtx", () => {
	test("rebuilds the context when the existing one is closed", () => {
		// A closed context must be discarded and a fresh one created.
		ctxClosedAfterClose = true;
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		expect(createdContexts).toHaveLength(1);
		// Drive the live ctx to "closed" out-of-band (simulating browser teardown).
		const live = createdContexts[0];
		if (live) {
			live.state = "closed";
		}
		queue.enqueue(makeF32leChunk("r", [0.2]));
		// `this.ctx.state === "closed"` branch → a second context is built.
		expect(createdContexts).toHaveLength(2);
	});

	test("reuses the same running context across enqueues (no sinkId set)", () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		queue.enqueue(makeF32leChunk("r", [0.2]));
		// `opts ? … : new AudioContext()` no-sink branch, and the ctx is reused.
		expect(createdContexts).toHaveLength(1);
		expect(constructedSinkIds).toEqual([undefined]);
	});

	test("REUSES (does not rebuild) a suspended context and resumes it", () => {
		// `createOrReuseCtx` rebuilds only on `ctx == null || state === "closed"`.
		// A *suspended* context must be reused — and `ensureCtx`→`maybeResume`
		// must then resume it. This is the "suspended reuse" branch.
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		expect(createdContexts).toHaveLength(1);
		const live = createdContexts[0];
		// Drive the existing ctx to "suspended" out-of-band (e.g. tab backgrounded).
		if (live) {
			live.state = "suspended";
		}
		const resumeBefore = resumeCalls;
		queue.enqueue(makeF32leChunk("r", [0.2]));
		// No new context built — the suspended one was reused…
		expect(createdContexts).toHaveLength(1);
		// …and `maybeResume` called `.resume()` on it.
		expect(resumeCalls).toBe(resumeBefore + 1);
	});

	test("REBUILDS an 'interrupted' context (Safari/iOS) instead of silently reusing it", () => {
		// Regression: `createOrReuseCtx` rebuilt only on `null || "closed"`, so a
		// context driven to the non-standard Safari/iOS "interrupted" state was
		// reused — yet `maybeResume` only acts on "suspended", so it was never
		// recovered and the utterance silently dropped. The fix treats any
		// non-(running|suspended) state as non-reusable → rebuild.
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		expect(createdContexts).toHaveLength(1);
		const live = createdContexts[0];
		if (live) {
			// "interrupted" is off the standard AudioContextState union; set it via
			// a contained boundary cast to mimic the real Safari/iOS transition.
			(live as unknown as { state: string }).state = "interrupted";
		}
		queue.enqueue(makeF32leChunk("r", [0.2]));
		// A fresh context was built rather than reusing the interrupted one.
		expect(createdContexts).toHaveLength(2);
	});

	test("does NOT resume an already-running context (maybeResume early return)", () => {
		// `maybeResume` short-circuits when `state !== "suspended"`. A running
		// context across two enqueues must never have `.resume()` called.
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		queue.enqueue(makeF32leChunk("r", [0.2]));
		expect(resumeCalls).toBe(0);
	});
});

describe("TtsPlaybackQueue reject-path arrows settle without crashing", () => {
	test("maybeResume's rejected resume() is swallowed and the queue stays playing", async () => {
		ctxState = "suspended";
		resumeShouldReject = true;
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		// The `.catch(() => {})` arrow body must run on the rejected microtask.
		await Promise.resolve();
		await Promise.resolve();
		// Behaviour is preserved despite the rejected resume.
		expect(resumeCalls).toBe(1);
		expect(queue.isPlaying).toBe(true);
		// Subsequent chunks for the same request still schedule.
		queue.enqueue(makeF32leChunk("r", [0.2]));
		expect(createdSources).toHaveLength(2);
	});

	test("dispose's rejected close() is swallowed and the ctx reference is cleared", async () => {
		closeShouldReject = true;
		ctxClosedAfterClose = false;
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		queue.dispose();
		// The `.catch(() => {})` arrow in dispose() must absorb the rejection.
		await Promise.resolve();
		await Promise.resolve();
		expect(closeCalls).toBe(1);
		// ctx was nulled by dispose() → a later enqueue rebuilds a fresh context.
		queue.enqueue(makeF32leChunk("r2", [0.2]));
		expect(createdContexts).toHaveLength(2);
	});

	test("setOutputDeviceId's rejected setSinkId() is swallowed (queue still usable)", async () => {
		setSinkIdShouldReject = true;
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		queue.setOutputDeviceId("device-bad");
		await Promise.resolve();
		await Promise.resolve();
		expect(setSinkIdCalls).toEqual(["device-bad"]);
		// Despite the rejected re-route, more audio still schedules.
		queue.enqueue(makeF32leChunk("r", [0.2]));
		expect(createdSources).toHaveLength(2);
	});
});

describe("TtsPlaybackQueue.getLevel (analyser tap)", () => {
	test("returns 0 when nothing has played (no analyser built yet)", () => {
		const queue = new TtsPlaybackQueue();
		expect(queue.getLevel()).toBe(0);
	});

	test("routes sources through a single analyser wired to the destination", () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		queue.enqueue(makeF32leChunk("r", [0.2]));
		// One analyser shared across both sources of the same context.
		expect(createdAnalysers).toHaveLength(1);
	});

	test("reads a non-zero RMS level off the analyser while playing", () => {
		analyserFillValue = 255; // full-scale deflection from the 128 centre
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		// (255-128)/128 ≈ 0.99 constant → RMS ≈ 0.99.
		expect(queue.getLevel()).toBeGreaterThan(0.9);
	});

	test("level returns to 0 once the request finishes", () => {
		analyserFillValue = 255;
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		expect(queue.getLevel()).toBeGreaterThan(0.9);
		createdSources[0]?.onended?.();
		// activeRequestId cleared → getLevel short-circuits to 0.
		expect(queue.getLevel()).toBe(0);
	});

	test("rebuilds the analyser when the context is rebuilt (closed → fresh)", () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		expect(createdAnalysers).toHaveLength(1);
		const live = createdContexts[0];
		if (live) {
			live.state = "closed";
		}
		queue.enqueue(makeF32leChunk("r", [0.2]));
		// New context → new analyser.
		expect(createdContexts).toHaveLength(2);
		expect(createdAnalysers).toHaveLength(2);
	});
});

describe("TtsPlaybackQueue.pause / resume", () => {
	test("pause() suspends a running context and sets isPaused", () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		queue.pause();
		expect(suspendCalls).toBe(1);
		expect(queue.isPaused).toBe(true);
	});

	test("a chunk arriving while paused does NOT auto-resume the context", () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		queue.pause();
		const resumeBefore = resumeCalls;
		// Next chunk for the same request — ensureCtx must skip maybeResume.
		queue.enqueue(makeF32leChunk("r", [0.2]));
		expect(resumeCalls).toBe(resumeBefore);
		expect(queue.isPaused).toBe(true);
	});

	test("resume() resumes a suspended context and clears isPaused", () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		queue.pause();
		const resumeBefore = resumeCalls;
		queue.resume();
		expect(resumeCalls).toBe(resumeBefore + 1);
		expect(queue.isPaused).toBe(false);
	});

	test("stop() clears the pause latch so the next utterance can play", () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		queue.pause();
		queue.stop();
		expect(queue.isPaused).toBe(false);
	});

	test("pause() before any context exists still latches paused (no throw)", () => {
		const queue = new TtsPlaybackQueue();
		expect(() => queue.pause()).not.toThrow();
		expect(queue.isPaused).toBe(true);
		expect(suspendCalls).toBe(0);
	});
});

describe("TtsPlaybackQueue.isPlaying false branch", () => {
	test("is false on a brand-new queue (activeRequestId === null)", () => {
		const queue = new TtsPlaybackQueue();
		expect(queue.isPlaying).toBe(false);
		expect(queue.currentRequestId).toBeNull();
	});

	test("flips false again once the active request finishes", () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue(makeF32leChunk("r", [0.1]));
		expect(queue.isPlaying).toBe(true);
		createdSources[0]?.onended?.();
		expect(queue.isPlaying).toBe(false);
	});
});
