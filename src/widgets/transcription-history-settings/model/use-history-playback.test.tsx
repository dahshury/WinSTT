import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	act,
	type RenderHookResult,
	renderHook,
	waitFor,
} from "@testing-library/react";
import { useHistoryPlayback, type PlaybackState } from "./use-history-playback";

const audioDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Audio");
const rafDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	"requestAnimationFrame",
);
const tauriInternals = window as unknown as {
	__TAURI_INTERNALS__: {
		invoke: (cmd: string, args?: unknown) => Promise<unknown>;
	};
};
const originalInvoke = tauriInternals.__TAURI_INTERNALS__.invoke;

let audio: MockAudio | null = null;
let hook: RenderHookResult<PlaybackState, void> | null = null;
let requestFrame: ReturnType<typeof mock>;

class MockAudio extends EventTarget {
	currentTime = 0;
	duration = 12;
	playbackRate = 1;
	readonly removedEvents: string[] = [];
	readonly pause = mock(() => {
		this.dispatchEvent(new Event("pause"));
	});
	readonly play = mock(async () => {
		this.dispatchEvent(new Event("play"));
	});

	constructor(readonly src: string) {
		super();
		audio = this;
	}

	override removeEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: EventListenerOptions | boolean,
	): void {
		this.removedEvents.push(type);
		super.removeEventListener(type, callback, options);
	}
}

beforeEach(() => {
	audio = null;
	requestFrame = mock(() => 1);
	Object.defineProperty(globalThis, "Audio", {
		configurable: true,
		value: MockAudio,
	});
	Object.defineProperty(globalThis, "requestAnimationFrame", {
		configurable: true,
		value: requestFrame,
	});
	tauriInternals.__TAURI_INTERNALS__.invoke = mock(async (cmd: string) => {
		if (cmd === "tts_history_load_audio") {
			return "data:audio/wav;base64,AAAA";
		}
		return undefined;
	});
});

afterEach(() => {
	hook?.unmount();
	hook = null;
	tauriInternals.__TAURI_INTERNALS__.invoke = originalInvoke;
	if (audioDescriptor) {
		Object.defineProperty(globalThis, "Audio", audioDescriptor);
	} else {
		delete (globalThis as unknown as { Audio?: typeof Audio }).Audio;
	}
	if (rafDescriptor) {
		Object.defineProperty(globalThis, "requestAnimationFrame", rafDescriptor);
	} else {
		delete (
			globalThis as unknown as {
				requestAnimationFrame?: typeof requestAnimationFrame;
			}
		).requestAnimationFrame;
	}
});

async function startPlayback(): Promise<RenderHookResult<PlaybackState, void>> {
	hook = renderHook(() => useHistoryPlayback("tts-entry", true, "", "tts"));
	act(() => hook?.result.current.toggle());
	await waitFor(() => expect(hook?.result.current.hasStarted).toBe(true));
	return hook;
}

describe("useHistoryPlayback", () => {
	test("tracks playhead and duration from media events without a frame loop", async () => {
		const handle = await startPlayback();
		const el = audio;
		expect(el).not.toBeNull();
		expect(handle.result.current.playing).toBe(true);
		expect(handle.result.current.duration).toBe(12);

		act(() => {
			if (!el) {
				return;
			}
			el.currentTime = 3.25;
			el.dispatchEvent(new Event("timeupdate"));
		});
		expect(handle.result.current.currentTime).toBe(3.25);

		act(() => {
			if (!el) {
				return;
			}
			el.duration = 24;
			el.dispatchEvent(new Event("durationchange"));
		});
		expect(handle.result.current.duration).toBe(24);
		expect(requestFrame).not.toHaveBeenCalled();
	});

	test("mirrors seeking immediately and follows external play/pause events", async () => {
		const handle = await startPlayback();
		const el = audio;
		expect(el).not.toBeNull();

		act(() => handle.result.current.seek(7));
		expect(el?.currentTime).toBe(7);
		expect(handle.result.current.currentTime).toBe(7);

		act(() => {
			if (!el) {
				return;
			}
			el.currentTime = 8;
			el.dispatchEvent(new Event("seeking"));
		});
		expect(handle.result.current.currentTime).toBe(8);

		act(() => el?.dispatchEvent(new Event("pause")));
		expect(handle.result.current.playing).toBe(false);
		act(() => el?.dispatchEvent(new Event("play")));
		expect(handle.result.current.playing).toBe(true);
	});

	test("resets on ended and detaches every listener on unmount", async () => {
		const handle = await startPlayback();
		const el = audio;
		expect(el).not.toBeNull();

		act(() => {
			if (!el) {
				return;
			}
			el.currentTime = 12;
			el.dispatchEvent(new Event("ended"));
		});
		expect(handle.result.current.currentTime).toBe(0);
		expect(handle.result.current.playing).toBe(false);
		expect(el?.currentTime).toBe(0);

		handle.unmount();
		hook = null;
		expect(el?.removedEvents.sort()).toEqual(
			[
				"durationchange",
				"ended",
				"loadedmetadata",
				"pause",
				"play",
				"seeked",
				"seeking",
				"timeupdate",
			].sort(),
		);
	});
});
