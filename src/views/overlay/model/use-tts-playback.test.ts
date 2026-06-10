import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MutableRefObject } from "react";
import type { TtsChunkPayload } from "@/shared/api/ipc-client";
import type { TtsPlaybackQueue } from "../lib/playback-queue";
import {
	handleTtsPausePlaybackControl,
	handleTtsChunkPayload,
	handleTtsCompletedPayload,
	handleTtsResumePlaybackControl,
	installTtsMediaSessionHandlers,
	stopTts,
	ttsMediaSessionPlaybackState,
} from "./use-tts-playback";
import {
	registerTtsQueue,
	unregisterTtsQueue,
	useTtsPlaybackStore,
} from "./tts-playback-store";

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
	readonly currentRequestId: string | null;
	enqueue: (chunk: TtsChunkPayload) => void;
	markComplete: (id: string) => void;
	pause?: () => void;
	resume?: () => void;
	stop: () => void;
}
const asQueue = (q: StubQueue) => q as unknown as TtsPlaybackQueue;

interface TauriInvokeCall {
	args: Record<string, unknown> | undefined;
	cmd: string;
}

interface TauriInternals {
	invoke: (
		cmd: string,
		args?: Record<string, unknown>,
		options?: unknown,
	) => Promise<unknown>;
}

function installTauriInvokeRecorder(): {
	calls: TauriInvokeCall[];
	restore: () => void;
} {
	const internals = (
		window as unknown as { __TAURI_INTERNALS__?: TauriInternals }
	).__TAURI_INTERNALS__;
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

function makeStubQueue(currentRequestId: string | null = "r"): {
	queue: TtsPlaybackQueue;
	calls: QueueCalls;
} {
	const calls: QueueCalls = { enqueue: [], markComplete: [], stop: 0 };
	const queue = asQueue({
		currentRequestId,
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

function makeChunk(
	requestId: string,
	overrides: Partial<TtsChunkPayload> = {},
): TtsChunkPayload {
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
	afterEach(() => {
		useTtsPlaybackStore.setState({
			status: "idle",
			requestId: null,
			error: null,
		});
	});

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

	test("clears loading when completion arrives before any playable audio", () => {
		const { queue } = makeStubQueue(null);
		useTtsPlaybackStore.getState().markStarted("r");
		handleTtsCompletedPayload(queue, {
			requestId: "r",
			cancelled: false,
			elapsedMs: 100,
		});
		expect(useTtsPlaybackStore.getState().status).toBe("idle");
		expect(useTtsPlaybackStore.getState().requestId).toBeNull();
	});
});

describe("TTS playback control events", () => {
	const calls = { pause: 0, resume: 0, stop: 0 };
	const queue = asQueue({
		currentRequestId: null,
		enqueue: () => undefined,
		markComplete: () => undefined,
		pause: () => {
			calls.pause += 1;
		},
		resume: () => {
			calls.resume += 1;
		},
		stop: () => {
			calls.stop += 1;
		},
	});

	beforeEach(() => {
		calls.pause = 0;
		calls.resume = 0;
		calls.stop = 0;
		useTtsPlaybackStore.setState({
			status: "idle",
			requestId: null,
			error: null,
		});
		registerTtsQueue(queue);
	});

	afterEach(() => {
		unregisterTtsQueue(queue);
		useTtsPlaybackStore.setState({
			status: "idle",
			requestId: null,
			error: null,
		});
	});

	test("backend pause control pauses loading or speaking reads", () => {
		useTtsPlaybackStore.getState().markStarted("r");
		handleTtsPausePlaybackControl("loading");
		expect(calls.pause).toBe(1);
		expect(useTtsPlaybackStore.getState().status).toBe("paused");

		useTtsPlaybackStore.setState({
			status: "speaking",
			requestId: "r",
			error: null,
		});
		handleTtsPausePlaybackControl("speaking");
		expect(calls.pause).toBe(2);
		expect(useTtsPlaybackStore.getState().status).toBe("paused");
	});

	test("backend resume control only resumes a paused read", () => {
		handleTtsResumePlaybackControl("idle");
		expect(calls.resume).toBe(0);

		useTtsPlaybackStore.setState({
			status: "paused",
			requestId: "r",
			error: null,
		});
		handleTtsResumePlaybackControl("paused");
		expect(calls.resume).toBe(1);
		expect(useTtsPlaybackStore.getState().status).toBe("speaking");
	});
});

describe("TTS Media Session bridge", () => {
	test("maps TTS status to OS media playback state", () => {
		expect(ttsMediaSessionPlaybackState("idle")).toBe("none");
		expect(ttsMediaSessionPlaybackState("error")).toBe("none");
		expect(ttsMediaSessionPlaybackState("loading")).toBe("playing");
		expect(ttsMediaSessionPlaybackState("speaking")).toBe("playing");
		expect(ttsMediaSessionPlaybackState("paused")).toBe("paused");
	});

	test("media pause/resume actions notify the backend commands", () => {
		const { calls, restore } = installTauriInvokeRecorder();
		const handlers = new Map<
			MediaSessionAction,
			MediaSessionActionHandler | null
		>();
		const session = {
			metadata: null,
			playbackState: "none",
			setActionHandler: (
				action: MediaSessionAction,
				handler: MediaSessionActionHandler | null,
			) => {
				handlers.set(action, handler);
			},
		} as MediaSession;

		try {
			const cleanup = installTtsMediaSessionHandlers(session);
			handlers.get("pause")?.({ action: "pause" });
			handlers.get("play")?.({ action: "play" });
			expect(calls).toEqual([
				{
					cmd: "tts_pause_playback",
					args: { reason: "media-session" },
				},
				{
					cmd: "tts_resume_playback",
					args: { reason: "media-session" },
				},
			]);

			cleanup();
			expect(handlers.get("pause")).toBeNull();
			expect(handlers.get("play")).toBeNull();
			expect(session.playbackState).toBe("none");
		} finally {
			restore();
		}
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
