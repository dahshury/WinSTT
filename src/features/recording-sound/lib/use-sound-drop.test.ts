import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useSoundDrop } from "./use-sound-drop";

// happy-dom has no Web Audio API; useSoundDrop decodes the dropped file to
// measure its duration. Install a controllable fake AudioContext and a
// per-file `window.nativeBridge` stub for the native path lookup.

const originalApi = window.nativeBridge;
const OriginalAudioContext = (globalThis as { AudioContext?: unknown })
	.AudioContext;

let decodeDuration = 1;
let decodeShouldThrow = false;
let nativePath = "/native/drop.wav";

class FakeAudioContext {
	close(): Promise<void> {
		return Promise.resolve();
	}
	decodeAudioData(): Promise<AudioBuffer> {
		if (decodeShouldThrow) {
			return Promise.reject(new Error("unreadable"));
		}
		return Promise.resolve({ duration: decodeDuration } as AudioBuffer);
	}
}

function makeFile(name: string): File {
	const f = new File([new Uint8Array([0, 1, 2])], name, { type: "audio/wav" });
	// happy-dom's File.arrayBuffer is reliable; nothing to patch.
	return f;
}

function dropEvent(file: File | null): React.DragEvent<HTMLElement> {
	let defaultPrevented = false;
	return {
		preventDefault: () => {
			defaultPrevented = true;
		},
		get defaultPrevented() {
			return defaultPrevented;
		},
		dataTransfer: { files: file ? [file] : [] },
	} as unknown as React.DragEvent<HTMLElement>;
}

const t = ((key: string, values?: Record<string, unknown>) =>
	values ? `${key}:${JSON.stringify(values)}` : key) as unknown as Parameters<
	typeof useSoundDrop
>[0]["t"];

beforeEach(() => {
	decodeDuration = 1;
	decodeShouldThrow = false;
	nativePath = "/native/drop.wav";
	(globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
	window.nativeBridge = {
		...originalApi,
		getPathForFile: () => nativePath,
		send: () => undefined,
		on: () => () => undefined,
		invoke: async () => undefined,
	};
});

afterEach(() => {
	window.nativeBridge = originalApi;
	(globalThis as { AudioContext?: unknown }).AudioContext =
		OriginalAudioContext;
});

describe("useSoundDrop", () => {
	test("dragOver/dragLeave toggle the drag state and onDragOver prevents default", () => {
		const { result } = renderHook(() =>
			useSoundDrop({ onAdd: async () => undefined, t }),
		);
		const ev = dropEvent(null);
		act(() => result.current.handlers.onDragOver(ev));
		expect(result.current.dragOver).toBe(true);
		expect(ev.defaultPrevented).toBe(true);
		act(() => result.current.handlers.onDragLeave());
		expect(result.current.dragOver).toBe(false);
	});

	test("no file dropped → silently ignored, no error, onAdd not called", async () => {
		let added = false;
		const { result } = renderHook(() =>
			useSoundDrop({
				onAdd: async () => {
					added = true;
				},
				t,
			}),
		);
		await act(async () => {
			await result.current.handlers.onDrop(dropEvent(null));
		});
		expect(added).toBe(false);
		expect(result.current.dropError).toBe("");
	});

	test("rejects unsupported extension with soundFileDropError", async () => {
		const { result } = renderHook(() =>
			useSoundDrop({ onAdd: async () => undefined, t }),
		);
		await act(async () => {
			await result.current.handlers.onDrop(dropEvent(makeFile("voice.ogg")));
		});
		expect(result.current.dropError).toBe("soundFileDropError");
	});

	test("rejects files longer than the max duration", async () => {
		decodeDuration = 9;
		const { result } = renderHook(() =>
			useSoundDrop({ onAdd: async () => undefined, t }),
		);
		await act(async () => {
			await result.current.handlers.onDrop(dropEvent(makeFile("long.mp3")));
		});
		expect(result.current.dropError).toContain("soundFileTooLong");
	});

	test("reports unreadable audio when decoding throws", async () => {
		decodeShouldThrow = true;
		const { result } = renderHook(() =>
			useSoundDrop({ onAdd: async () => undefined, t }),
		);
		await act(async () => {
			await result.current.handlers.onDrop(dropEvent(makeFile("broken.wav")));
		});
		expect(result.current.dropError).toBe("soundFileUnreadable");
	});

	test("reports unreadable when the native path cannot be resolved", async () => {
		nativePath = "";
		const { result } = renderHook(() =>
			useSoundDrop({ onAdd: async () => undefined, t }),
		);
		await act(async () => {
			await result.current.handlers.onDrop(dropEvent(makeFile("ok.wav")));
		});
		expect(result.current.dropError).toBe("soundFileUnreadable");
	});

	test("valid drop calls onAdd with the native path and extension-stripped name", async () => {
		const calls: [string, string | undefined][] = [];
		const { result } = renderHook(() =>
			useSoundDrop({
				onAdd: async (p, n) => {
					calls.push([p, n]);
				},
				t,
			}),
		);
		await act(async () => {
			await result.current.handlers.onDrop(dropEvent(makeFile("My Clip.wav")));
		});
		expect(calls).toEqual([["/native/drop.wav", "My Clip"]]);
		expect(result.current.dropError).toBe("");
	});

	test("resetError clears a previous error", async () => {
		const { result } = renderHook(() =>
			useSoundDrop({ onAdd: async () => undefined, t }),
		);
		await act(async () => {
			await result.current.handlers.onDrop(dropEvent(makeFile("x.ogg")));
		});
		expect(result.current.dropError).not.toBe("");
		act(() => result.current.resetError());
		expect(result.current.dropError).toBe("");
	});
});
