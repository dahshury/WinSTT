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

const OriginalAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;

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

let createdSources: FakeSource[] = [];
let createdBuffers: FakeBuffer[] = [];
let resumeCalls = 0;
let closeCalls = 0;
let ctxState: "running" | "suspended" | "closed" = "running";
let ctxClosedAfterClose = true;
let currentTime = 0;
let resumeShouldReject = false;
let closeShouldReject = false;

class FakeAudioContext {
	state: "running" | "suspended" | "closed" = ctxState;
	get currentTime(): number {
		return currentTime;
	}
	get destination() {
		return {};
	}
	createBuffer(channels: number, frames: number, sampleRate: number): FakeBuffer {
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
		(buf as unknown as { copyToChannel: (data: Float32Array, ch: number) => void }).copyToChannel =
			(data, ch) => {
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
	resume(): Promise<void> {
		resumeCalls += 1;
		if (resumeShouldReject) {
			return Promise.reject(new Error("resume failed"));
		}
		this.state = "running";
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
}

function reset(): void {
	createdSources = [];
	createdBuffers = [];
	resumeCalls = 0;
	closeCalls = 0;
	ctxState = "running";
	ctxClosedAfterClose = true;
	currentTime = 0;
	resumeShouldReject = false;
	closeShouldReject = false;
	(globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
}

beforeEach(reset);
afterEach(() => {
	(globalThis as { AudioContext?: unknown }).AudioContext = OriginalAudioContext;
});

function makeF32leChunk(
	requestId: string,
	samples: number[],
	channels = 1,
	sampleRate = 24_000
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

describe("parseFloat32Samples", () => {
	test("returns null for non-f32le formats", () => {
		expect(parseFloat32Samples({ ...makeF32leChunk("r", [0]), format: "s16le" })).toBeNull();
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
		const ctx = new FakeAudioContext() as unknown as AudioContext;
		const buffer = ctx.createBuffer(2, 2, 24_000);
		copyPlanesToBuffer(buffer, planes);
		const fake = buffer as unknown as FakeBuffer;
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
		const ctx = new FakeAudioContext() as unknown as AudioContext;
		const buffer = ctx.createBuffer(1, 3, 24_000);
		fillAudioBuffer(buffer, new Float32Array([0.1, 0.2, 0.3]), 1, 3);
		expect(Array.from((buffer as unknown as FakeBuffer).channelData[0] ?? [])).toEqual([
			expect.closeTo(0.1, 6),
			expect.closeTo(0.2, 6),
			expect.closeTo(0.3, 6),
		]);
	});

	test("multi-channel path deinterleaves into matching channels", () => {
		const ctx = new FakeAudioContext() as unknown as AudioContext;
		const buffer = ctx.createBuffer(2, 2, 24_000);
		fillAudioBuffer(buffer, new Float32Array([1, 2, 3, 4]), 2, 2);
		const fake = buffer as unknown as FakeBuffer;
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

	test("drops chunks with unsupported format", () => {
		const queue = new TtsPlaybackQueue();
		queue.enqueue({ ...makeF32leChunk("r", [0]), format: "mp3" });
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
