import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MutableRefObject } from "react";
import type { TtsChunkPayload } from "@/shared/api/ipc-client";
import type { TtsPlaybackQueue } from "../lib/playback-queue";
import { handleTtsChunkPayload, handleTtsCompletedPayload, stopTts } from "./use-tts-playback";

// Lightweight queue stub — verifies that the module-level handlers
// forward exactly the right payloads without coupling to the real
// AudioContext-driven implementation.

interface QueueCalls {
	enqueue: TtsChunkPayload[];
	markComplete: string[];
	stop: number;
}

// The stub implements only the three queue methods the handlers call; this
// contains the single boundary cast to the real queue type, returning the
// exact stub object it was handed.
interface StubQueue {
	enqueue: (chunk: TtsChunkPayload) => void;
	markComplete: (id: string) => void;
	stop: () => void;
}
const asQueue = (q: StubQueue) => q as unknown as TtsPlaybackQueue;

interface TauriInvokeCall {
	args: Record<string, unknown> | undefined;
	cmd: string;
}

interface TauriInternals {
	invoke: (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
}

function installTauriInvokeRecorder(): {
	calls: TauriInvokeCall[];
	restore: () => void;
} {
	const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals })
		.__TAURI_INTERNALS__;
	if (!internals) {
		throw new Error("expected test Tauri internals to be installed");
	}
	const calls: TauriInvokeCall[] = [];
	const originalInvoke = internals.invoke;
	internals.invoke = (cmd, args) => {
		calls.push({ cmd, args });
		return Promise.resolve(undefined);
	};
	return {
		calls,
		restore: () => {
			internals.invoke = originalInvoke;
		},
	};
}

function makeStubQueue(): { queue: TtsPlaybackQueue; calls: QueueCalls } {
	const calls: QueueCalls = { enqueue: [], markComplete: [], stop: 0 };
	const queue = asQueue({
		enqueue: (chunk: TtsChunkPayload) => {
			calls.enqueue.push(chunk);
		},
		markComplete: (id: string) => {
			calls.markComplete.push(id);
		},
		stop: () => {
			calls.stop += 1;
		},
	});
	return { queue, calls };
}

function makeRef(value: string | null): MutableRefObject<string | null> {
	return { current: value };
}

function makeChunk(requestId: string, overrides: Partial<TtsChunkPayload> = {}): TtsChunkPayload {
	return {
		requestId,
		sampleRate: 24_000,
		channels: 1,
		format: "f32le",
		pcm: new Float32Array([0.1]).buffer,
		isFinal: false,
		seq: 0,
		...overrides,
	};
}

describe("handleTtsChunkPayload", () => {
	test("forwards the chunk to the queue and records the active request id", () => {
		const { queue, calls } = makeStubQueue();
		const activeIdRef = makeRef(null);
		handleTtsChunkPayload(queue, activeIdRef, makeChunk("req-1"));
		expect(activeIdRef.current).toBe("req-1");
		expect(calls.enqueue).toHaveLength(1);
		expect(calls.enqueue[0]?.requestId).toBe("req-1");
		// Reshapes payload to drop seq / isFinal (queue only needs the
		// audio-shaped fields).
		expect(Object.keys(calls.enqueue[0] ?? {}).sort()).toEqual([
			"channels",
			"format",
			"pcm",
			"requestId",
			"sampleRate",
		]);
	});

	test("does NOT clobber the active id when the chunk has an empty id", () => {
		const { queue } = makeStubQueue();
		const activeIdRef = makeRef("existing");
		handleTtsChunkPayload(queue, activeIdRef, makeChunk(""));
		expect(activeIdRef.current).toBe("existing");
	});
});

describe("handleTtsCompletedPayload", () => {
	test("marks the queue complete on a normal completion", () => {
		const { queue, calls } = makeStubQueue();
		handleTtsCompletedPayload(queue, {
			requestId: "r",
			cancelled: false,
			elapsedMs: 100,
		});
		expect(calls.markComplete).toEqual(["r"]);
		expect(calls.stop).toBe(0);
	});

	test("stops the queue on a cancelled completion", () => {
		const { queue, calls } = makeStubQueue();
		handleTtsCompletedPayload(queue, {
			requestId: "r",
			cancelled: true,
			elapsedMs: null,
		});
		expect(calls.markComplete).toEqual(["r"]);
		expect(calls.stop).toBe(1);
	});
});

describe("stopTts", () => {
	let calls: TauriInvokeCall[] = [];
	let restoreTauriInvoke: (() => void) | null = null;

	beforeEach(() => {
		const recorder = installTauriInvokeRecorder();
		calls = recorder.calls;
		restoreTauriInvoke = recorder.restore;
	});

	afterEach(() => {
		restoreTauriInvoke?.();
		restoreTauriInvoke = null;
	});

	test("forwards the request id to the typed TTS cancel command", () => {
		stopTts("r");
		expect(calls).toEqual([{ cmd: "tts_cancel", args: { requestId: "r" } }]);
	});

	test("cancels every active request when called without an id", () => {
		stopTts();
		expect(calls).toEqual([{ cmd: "tts_cancel", args: { requestId: null } }]);
	});
});
