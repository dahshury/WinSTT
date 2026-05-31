import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IPC } from "@/shared/api/ipc-channels";
import type { TtsPlaybackQueue } from "../lib/playback-queue";
import {
	discardTts,
	getTtsLevel,
	pauseTts,
	registerTtsQueue,
	resumeTts,
	unregisterTtsQueue,
	useTtsPlaybackStore,
} from "./tts-playback-store";

// Stub queue implementing only the surface the controls touch. The single
// boundary cast lives here and returns the exact object it was handed.
interface StubQueue {
	getLevel: () => number;
	pause: () => void;
	resume: () => void;
	stop: () => void;
}
const asQueue = (q: StubQueue) => q as unknown as TtsPlaybackQueue;

function resetStore(): void {
	useTtsPlaybackStore.setState({ status: "idle", requestId: null, error: null });
}

describe("useTtsPlaybackStore transitions", () => {
	afterEach(resetStore);

	test("markStarted → speaking with the request id", () => {
		useTtsPlaybackStore.getState().markStarted("r1");
		expect(useTtsPlaybackStore.getState().status).toBe("speaking");
		expect(useTtsPlaybackStore.getState().requestId).toBe("r1");
	});

	test("markEnded collapses speaking → idle and clears the id", () => {
		useTtsPlaybackStore.getState().markStarted("r1");
		useTtsPlaybackStore.getState().markEnded();
		expect(useTtsPlaybackStore.getState().status).toBe("idle");
		expect(useTtsPlaybackStore.getState().requestId).toBeNull();
	});

	test("markEnded preserves an error status (so the reason stays visible)", () => {
		useTtsPlaybackStore.getState().markFailed("boom");
		useTtsPlaybackStore.getState().markEnded();
		expect(useTtsPlaybackStore.getState().status).toBe("error");
		expect(useTtsPlaybackStore.getState().error).toBe("boom");
	});

	test("setPausedStatus toggles speaking <-> paused", () => {
		useTtsPlaybackStore.getState().markStarted("r");
		useTtsPlaybackStore.getState().setPausedStatus(true);
		expect(useTtsPlaybackStore.getState().status).toBe("paused");
		useTtsPlaybackStore.getState().setPausedStatus(false);
		expect(useTtsPlaybackStore.getState().status).toBe("speaking");
	});

	test("setPausedStatus(true) is a no-op when idle", () => {
		useTtsPlaybackStore.getState().setPausedStatus(true);
		expect(useTtsPlaybackStore.getState().status).toBe("idle");
	});

	test("markPlaying does not stomp a paused intent", () => {
		useTtsPlaybackStore.getState().markStarted("r");
		useTtsPlaybackStore.getState().setPausedStatus(true);
		useTtsPlaybackStore.getState().markPlaying();
		expect(useTtsPlaybackStore.getState().status).toBe("paused");
	});
});

describe("tts-playback queue controls", () => {
	const calls = { pause: 0, resume: 0, stop: 0 };
	let level = 0;
	const queue = asQueue({
		pause: () => {
			calls.pause += 1;
		},
		resume: () => {
			calls.resume += 1;
		},
		stop: () => {
			calls.stop += 1;
		},
		getLevel: () => level,
	});

	beforeEach(() => {
		calls.pause = 0;
		calls.resume = 0;
		calls.stop = 0;
		level = 0;
		resetStore();
		registerTtsQueue(queue);
	});
	afterEach(() => {
		unregisterTtsQueue(queue);
	});

	test("getTtsLevel reads the active queue's level", () => {
		level = 0.42;
		expect(getTtsLevel()).toBeCloseTo(0.42, 6);
	});

	test("getTtsLevel is 0 once the queue is unregistered", () => {
		unregisterTtsQueue(queue);
		expect(getTtsLevel()).toBe(0);
	});

	test("pauseTts pauses the queue and sets paused status", () => {
		useTtsPlaybackStore.getState().markStarted("r");
		pauseTts();
		expect(calls.pause).toBe(1);
		expect(useTtsPlaybackStore.getState().status).toBe("paused");
	});

	test("resumeTts resumes the queue and clears paused status", () => {
		useTtsPlaybackStore.getState().markStarted("r");
		pauseTts();
		resumeTts();
		expect(calls.resume).toBe(1);
		expect(useTtsPlaybackStore.getState().status).toBe("speaking");
	});

	test("discardTts stops the local queue AND cancels the server run", () => {
		const originalApi = window.electronAPI;
		const sends: Array<{ channel: string; args: unknown[] }> = [];
		window.electronAPI = {
			...originalApi,
			send: (channel: string, ...args: unknown[]) => {
				sends.push({ channel, args });
			},
		};
		try {
			useTtsPlaybackStore.getState().markStarted("req-9");
			discardTts();
			expect(calls.stop).toBe(1);
			expect(sends).toEqual([{ channel: IPC.TTS_CANCEL, args: [{ requestId: "req-9" }] }]);
		} finally {
			window.electronAPI = originalApi;
		}
	});
});
