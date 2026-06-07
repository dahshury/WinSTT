import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	createOutputContext,
	decodeWav,
	ensureRunning,
	playBuffer,
	routeContextToSink,
	toArrayBuffer,
} from "./web-audio";

// Contained boundary casts. The inline mocks implement only the Web Audio
// surface the helpers under test touch; these wrappers hold the single
// unavoidable cast between each mock literal and the real type. Generic over
// the actual literal so the mock's true shape is still type-checked at the call
// site. Each helper returns the exact same object it was given.
const asAudioContext = <T extends object>(ctx: T): AudioContext => ctx as unknown as AudioContext;
const asAudioBuffer = <T extends object>(buf: T): AudioBuffer => buf as unknown as AudioBuffer;

describe("toArrayBuffer", () => {
	test("returns a clean ArrayBuffer of just the view's window", () => {
		const backing = new Uint8Array([9, 9, 1, 2, 3, 4, 9]);
		const view = new Uint8Array(backing.buffer, 2, 4);
		const out = toArrayBuffer(view);
		expect(out.byteLength).toBe(4);
		expect(Array.from(new Uint8Array(out))).toEqual([1, 2, 3, 4]);
	});
});

describe("decodeWav", () => {
	test("delegates to ctx.decodeAudioData and resolves the buffer", async () => {
		const fakeBuf = asAudioBuffer({ __decoded: true });
		const ctx = asAudioContext({
			decodeAudioData: mock(async () => fakeBuf),
		});
		const out = await decodeWav(ctx, new Uint8Array([1, 2]));
		expect(out).toBe(fakeBuf);
	});

	test("returns null and warns when decode rejects", async () => {
		const originalWarn = console.warn;
		const warnings: unknown[][] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(args);
		};
		try {
			const ctx = asAudioContext({
				decodeAudioData: mock(async () => {
					throw new Error("nope");
				}),
			});
			const out = await decodeWav(ctx, new Uint8Array([1]));
			expect(out).toBeNull();
			expect(warnings.some((w) => String(w[0]).includes("[sound]"))).toBe(true);
		} finally {
			console.warn = originalWarn;
		}
	});
});

describe("ensureRunning", () => {
	test("calls resume() on a suspended context", () => {
		const resume = mock(() => undefined);
		const ctx = asAudioContext({ state: "suspended", resume });
		ensureRunning(ctx);
		expect(resume).toHaveBeenCalledTimes(1);
	});

	test("does not call resume() when already running", () => {
		const resume = mock(() => undefined);
		const ctx = asAudioContext({ state: "running", resume });
		ensureRunning(ctx);
		expect(resume).not.toHaveBeenCalled();
	});
});

describe("playBuffer", () => {
	test("creates a source, wires destination, and starts playback", () => {
		const start = mock(() => undefined);
		const connect = mock(() => undefined);
		const source = { buffer: null as unknown, connect, start };
		const destination = { __dest: true } as unknown;
		const ctx = asAudioContext({
			state: "running",
			resume: mock(() => undefined),
			createBufferSource: mock(() => source),
			destination,
		});
		const buf = asAudioBuffer({ __buf: true });
		playBuffer(ctx, buf);
		expect(source.buffer).toBe(buf);
		expect(connect).toHaveBeenCalledWith(destination);
		expect(start).toHaveBeenCalledTimes(1);
	});
});

describe("createOutputContext", () => {
	// AudioContext is not implemented by happy-dom; stub the global constructor
	// to record the options it was invoked with so we can assert the routing
	// decision (default vs sinkId) without a real Web Audio backend.
	const originalAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;
	const calls: Array<AudioContextOptions | undefined> = [];

	afterEach(() => {
		(globalThis as { AudioContext?: unknown }).AudioContext = originalAudioContext;
		calls.length = 0;
	});

	const installFakeAudioContext = (opts?: { throwOnSink?: boolean }): void => {
		class FakeAudioContext {
			readonly options: AudioContextOptions | undefined;
			constructor(o?: AudioContextOptions) {
				if (opts?.throwOnSink && o?.sinkId) {
					throw new Error("sinkId unsupported (older Chromium)");
				}
				this.options = o;
				calls.push(o);
			}
		}
		(globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
	};

	test("constructs a default context when deviceId is empty", () => {
		installFakeAudioContext();
		const ctx = createOutputContext("") as unknown as { options?: AudioContextOptions };
		expect(calls).toHaveLength(1);
		// Empty deviceId → bare constructor, no sinkId option passed.
		expect(calls[0]).toBeUndefined();
		expect(ctx.options).toBeUndefined();
	});

	test("constructs a sink-routed context when deviceId is provided", () => {
		installFakeAudioContext();
		const ctx = createOutputContext("device-42") as unknown as {
			options?: AudioContextOptions;
		};
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({ sinkId: "device-42" });
		expect(ctx.options).toEqual({ sinkId: "device-42" });
	});

	test("falls back to a default context when sinkId construction throws", () => {
		installFakeAudioContext({ throwOnSink: true });
		const ctx = createOutputContext("device-99") as unknown as {
			options?: AudioContextOptions;
		};
		// Two attempts: the throwing sinkId one, then the bare fallback that lands.
		expect(calls).toHaveLength(1);
		expect(calls[0]).toBeUndefined();
		expect(ctx.options).toBeUndefined();
	});
});

describe("routeContextToSink", () => {
	test("no-ops on older runtimes without setSinkId", async () => {
		// No setSinkId → early return; nothing to assert beyond it not throwing.
		const ctx = asAudioContext({ state: "running" });
		await expect(routeContextToSink(ctx, "device-1")).resolves.toBeUndefined();
	});

	test("forwards the deviceId to setSinkId when present", async () => {
		const setSinkId = mock(async () => undefined);
		const ctx = asAudioContext({ setSinkId });
		await routeContextToSink(ctx, "device-7");
		expect(setSinkId).toHaveBeenCalledTimes(1);
		expect(setSinkId).toHaveBeenCalledWith("device-7");
	});

	test("requests the system-default sink when deviceId is empty", async () => {
		const setSinkId = mock(async () => undefined);
		const ctx = asAudioContext({ setSinkId });
		await routeContextToSink(ctx, "");
		expect(setSinkId).toHaveBeenCalledWith("");
	});

	test("swallows setSinkId rejection (device unreachable) and warns (observability)", async () => {
		// Regression: the rejection was previously swallowed silently (unlike
		// `decodeWav`, which warns). It now warns for diagnosability while still
		// resolving without throwing (behaviour unchanged).
		const originalWarn = console.warn;
		const warnings: unknown[][] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(args);
		};
		try {
			const setSinkId = mock(async () => {
				throw new Error("device unavailable");
			});
			const ctx = asAudioContext({ setSinkId });
			await expect(routeContextToSink(ctx, "ghost-device")).resolves.toBeUndefined();
			expect(setSinkId).toHaveBeenCalledTimes(1);
			expect(warnings.some((w) => String(w[0]).includes("[sound]"))).toBe(true);
		} finally {
			console.warn = originalWarn;
		}
	});
});
