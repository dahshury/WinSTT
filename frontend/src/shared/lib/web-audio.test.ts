import { describe, expect, mock, test } from "bun:test";
import { decodeWav, ensureRunning, playBuffer, toArrayBuffer } from "./web-audio";

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
		const fakeBuf = { __decoded: true } as unknown as AudioBuffer;
		const ctx = {
			decodeAudioData: mock(async () => fakeBuf),
		} as unknown as AudioContext;
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
			const ctx = {
				decodeAudioData: mock(async () => {
					throw new Error("nope");
				}),
			} as unknown as AudioContext;
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
		const ctx = { state: "suspended", resume } as unknown as AudioContext;
		ensureRunning(ctx);
		expect(resume).toHaveBeenCalledTimes(1);
	});

	test("does not call resume() when already running", () => {
		const resume = mock(() => undefined);
		const ctx = { state: "running", resume } as unknown as AudioContext;
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
		const ctx = {
			state: "running",
			resume: mock(() => undefined),
			createBufferSource: mock(() => source),
			destination,
		} as unknown as AudioContext;
		const buf = { __buf: true } as unknown as AudioBuffer;
		playBuffer(ctx, buf);
		expect(source.buffer).toBe(buf);
		expect(connect).toHaveBeenCalledWith(destination);
		expect(start).toHaveBeenCalledTimes(1);
	});
});
