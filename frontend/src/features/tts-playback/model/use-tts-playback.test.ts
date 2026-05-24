import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MutableRefObject } from "react";
import { IPC } from "@/shared/api/ipc-channels";
import type { TtsChunkPayload } from "@/shared/api/ipc-client";
import type { TtsPlaybackQueue } from "../lib/playback-queue";
import {
	handleTtsChunkPayload,
	handleTtsCompletedPayload,
	makeQueueEndHandler,
	reduceQueueEnd,
	stopTts,
	type TtsPlaybackState,
} from "./use-tts-playback";

// Lightweight queue stub — verifies that the module-level handlers
// forward exactly the right payloads without coupling to the real
// AudioContext-driven implementation.

interface QueueCalls {
	enqueue: TtsChunkPayload[];
	markComplete: string[];
	stop: number;
}

function makeStubQueue(): { queue: TtsPlaybackQueue; calls: QueueCalls } {
	const calls: QueueCalls = { enqueue: [], markComplete: [], stop: 0 };
	const queue = {
		enqueue: (chunk: TtsChunkPayload) => {
			calls.enqueue.push(chunk);
		},
		markComplete: (id: string) => {
			calls.markComplete.push(id);
		},
		stop: () => {
			calls.stop += 1;
		},
	} as unknown as TtsPlaybackQueue;
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

describe("reduceQueueEnd", () => {
	test("collapses a `speaking` state to idle", () => {
		const next = reduceQueueEnd({ status: "speaking", error: null, requestId: "r" });
		expect(next).toEqual({ status: "idle", error: null, requestId: null });
	});

	test("leaves an `error` state untouched so the user sees why it failed", () => {
		const errorState: TtsPlaybackState = {
			status: "error",
			error: "boom",
			requestId: null,
		};
		expect(reduceQueueEnd(errorState)).toBe(errorState);
	});

	test("leaves an `idle` state untouched", () => {
		const idle: TtsPlaybackState = { status: "idle", error: null, requestId: null };
		expect(reduceQueueEnd(idle)).toBe(idle);
	});
});

describe("makeQueueEndHandler", () => {
	const originalApi = window.electronAPI;
	const sends: Array<{ channel: string; args: unknown[] }> = [];

	beforeEach(() => {
		sends.length = 0;
		window.electronAPI = {
			...originalApi,
			send: (channel: string, ...args: unknown[]) => {
				sends.push({ channel, args });
			},
		};
	});

	afterEach(() => {
		window.electronAPI = originalApi;
	});

	test("clears the active id, runs the reducer, and reports the ended id to main", () => {
		const activeIdRef = makeRef("req-42");
		const received: Array<(prev: TtsPlaybackState) => TtsPlaybackState> = [];
		const setState = (u: (prev: TtsPlaybackState) => TtsPlaybackState) => {
			received.push(u);
		};
		const handler = makeQueueEndHandler(activeIdRef, setState);
		handler();
		expect(activeIdRef.current).toBeNull();
		expect(received).toHaveLength(1);
		expect(received[0]).toBe(reduceQueueEnd);
		expect(sends).toEqual([
			{ channel: IPC.TTS_REPORT_PLAYBACK_ENDED, args: [{ requestId: "req-42" }] },
		]);
	});

	test("emits an empty id even when no request was active so listeners can reset", () => {
		const handler = makeQueueEndHandler(makeRef(null), () => undefined);
		handler();
		expect(sends).toEqual([{ channel: IPC.TTS_REPORT_PLAYBACK_ENDED, args: [{ requestId: "" }] }]);
	});
});

describe("stopTts", () => {
	const originalApi = window.electronAPI;
	const sends: Array<{ channel: string; args: unknown[] }> = [];

	beforeEach(() => {
		sends.length = 0;
		window.electronAPI = {
			...originalApi,
			send: (channel: string, ...args: unknown[]) => {
				sends.push({ channel, args });
			},
		};
	});

	afterEach(() => {
		window.electronAPI = originalApi;
	});

	test("forwards the request id to TTS_CANCEL", () => {
		stopTts("r");
		expect(sends).toEqual([{ channel: IPC.TTS_CANCEL, args: [{ requestId: "r" }] }]);
	});

	test("cancels every active request when called without an id", () => {
		stopTts();
		expect(sends).toEqual([{ channel: IPC.TTS_CANCEL, args: [{ requestId: undefined }] }]);
	});
});
