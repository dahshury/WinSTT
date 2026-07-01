import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TtsPlaybackQueue } from "../lib/playback-queue";
import {
	discardTts,
	getTtsLevel,
	getTtsProgress,
	pauseTts,
	registerTtsQueue,
	resumeTts,
	seekTts,
	setTtsVolume,
	toggleTtsMuted,
	unregisterTtsQueue,
	useTtsPlaybackStore,
} from "./tts-playback-store";

// Stub queue implementing only the surface the controls touch. The single
// boundary cast lives here and returns the exact object it was handed. The
// media-player methods are optional so the legacy controls block can keep its
// minimal stub.
interface StubQueue {
	getBufferedEnd?: () => number;
	getCurrentTime?: () => number;
	getDuration?: () => number;
	getLevel: () => number;
	pause: () => void;
	resume: () => void;
	seek?: (seconds: number) => void;
	setMuted?: (muted: boolean) => void;
	setVolume?: (volume: number) => void;
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

function resetStore(): void {
	useTtsPlaybackStore.setState({
		status: "idle",
		requestId: null,
		error: null,
		currentTime: 0,
		duration: 0,
		bufferedEnd: 0,
		volume: 1,
		muted: false,
	});
}

describe("useTtsPlaybackStore transitions", () => {
	afterEach(resetStore);

	test("markStarted enters loading with the request id", () => {
		useTtsPlaybackStore.getState().markStarted("r1");
		expect(useTtsPlaybackStore.getState().status).toBe("loading");
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
		const { calls: tauriCalls, restore } = installTauriInvokeRecorder();
		try {
			useTtsPlaybackStore.getState().markStarted("req-9");
			discardTts();
			expect(calls.stop).toBe(1);
			expect(tauriCalls).toEqual([
				{ cmd: "tts_cancel", args: { requestId: "req-9" } },
			]);
		} finally {
			restore();
		}
	});
});

describe("tts-playback media-player helpers", () => {
	const calls = {
		seek: [] as number[],
		volume: [] as number[],
		muted: [] as boolean[],
	};
	const progress = { currentTime: 0, duration: 0, bufferedEnd: 0 };
	const queue = asQueue({
		getLevel: () => 0,
		pause: () => undefined,
		resume: () => undefined,
		stop: () => undefined,
		seek: (s) => calls.seek.push(s),
		setVolume: (v) => calls.volume.push(v),
		setMuted: (m) => calls.muted.push(m),
		getCurrentTime: () => progress.currentTime,
		getDuration: () => progress.duration,
		getBufferedEnd: () => progress.bufferedEnd,
	});

	beforeEach(() => {
		calls.seek = [];
		calls.volume = [];
		calls.muted = [];
		progress.currentTime = 0;
		progress.duration = 0;
		progress.bufferedEnd = 0;
		resetStore();
		registerTtsQueue(queue);
	});
	afterEach(() => {
		unregisterTtsQueue(queue);
	});

	test("getTtsProgress reads the active queue", () => {
		progress.currentTime = 1.5;
		progress.duration = 4;
		progress.bufferedEnd = 3;
		expect(getTtsProgress()).toEqual({
			currentTime: 1.5,
			duration: 4,
			bufferedEnd: 3,
		});
	});

	test("getTtsProgress is all-zero with no queue", () => {
		unregisterTtsQueue(queue);
		expect(getTtsProgress()).toEqual({
			currentTime: 0,
			duration: 0,
			bufferedEnd: 0,
		});
	});

	test("seekTts seeks the queue and optimistically reflects the position", () => {
		useTtsPlaybackStore.setState({ duration: 10, bufferedEnd: 8 });
		seekTts(4);
		expect(calls.seek).toEqual([4]);
		expect(useTtsPlaybackStore.getState().currentTime).toBe(4);
		expect(useTtsPlaybackStore.getState().duration).toBe(10);
		expect(useTtsPlaybackStore.getState().bufferedEnd).toBe(8);
	});

	test("setTtsVolume sets the queue volume and mirrors it in the store", () => {
		setTtsVolume(0.6);
		expect(calls.volume).toEqual([0.6]);
		expect(useTtsPlaybackStore.getState().volume).toBe(0.6);
	});

	test("toggleTtsMuted flips the mute latch on the queue and the store", () => {
		toggleTtsMuted();
		expect(calls.muted).toEqual([true]);
		expect(useTtsPlaybackStore.getState().muted).toBe(true);
		toggleTtsMuted();
		expect(calls.muted).toEqual([true, false]);
		expect(useTtsPlaybackStore.getState().muted).toBe(false);
	});
});

describe("useTtsPlaybackStore progress", () => {
	afterEach(resetStore);

	test("setProgress no-ops (no notification) when values are unchanged", () => {
		let notifications = 0;
		const unsub = useTtsPlaybackStore.subscribe(() => {
			notifications += 1;
		});
		useTtsPlaybackStore.getState().setProgress(1, 2, 1.5);
		useTtsPlaybackStore.getState().setProgress(1, 2, 1.5);
		unsub();
		expect(notifications).toBe(1);
		expect(useTtsPlaybackStore.getState().currentTime).toBe(1);
		expect(useTtsPlaybackStore.getState().duration).toBe(2);
		expect(useTtsPlaybackStore.getState().bufferedEnd).toBe(1.5);
	});

	test("markStarted resets the progress fields", () => {
		useTtsPlaybackStore.getState().setProgress(3, 5, 4);
		useTtsPlaybackStore.getState().markStarted("r");
		const s = useTtsPlaybackStore.getState();
		expect(s.currentTime).toBe(0);
		expect(s.duration).toBe(0);
		expect(s.bufferedEnd).toBe(0);
	});

	test("markEnded resets the progress fields", () => {
		useTtsPlaybackStore.getState().markStarted("r");
		useTtsPlaybackStore.getState().setProgress(3, 5, 4);
		useTtsPlaybackStore.getState().markEnded();
		const s = useTtsPlaybackStore.getState();
		expect(s.currentTime).toBe(0);
		expect(s.duration).toBe(0);
		expect(s.bufferedEnd).toBe(0);
	});
});
