import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, render } from "@testing-library/react";
import { useRecordingSound } from "./use-recording-sound";

type IpcInvokeFn = (channel: string, ...args: unknown[]) => Promise<unknown>;
type IpcOnHandler = (...args: unknown[]) => void;
type IpcOnFn = (channel: string, callback: IpcOnHandler) => () => void;

interface FakeAudioBufferSource {
	buffer: unknown;
	connect: ReturnType<typeof mock>;
	start: ReturnType<typeof mock>;
}

interface FakeAudioContext {
	close: ReturnType<typeof mock>;
	createBufferSource: ReturnType<typeof mock>;
	decodeAudioData: ReturnType<typeof mock>;
	decodedSources: FakeAudioBufferSource[];
	destination: { __dest: true };
	resume: ReturnType<typeof mock>;
	state: "running" | "suspended" | "closed";
}

const originalAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;
const originalElectronApi = window.electronAPI;

let lastInstance: FakeAudioContext | null = null;
let listeners: Map<string, IpcOnHandler[]>;
let invokeFn: IpcInvokeFn;

function HookHost(): null {
	useRecordingSound();
	return null;
}

function setUpAudioContext(opts?: { decodeFails?: boolean; suspended?: boolean }) {
	(globalThis as { AudioContext?: unknown }).AudioContext = function MockAudioContext(
		this: FakeAudioContext
	) {
		const sources: FakeAudioBufferSource[] = [];
		const inst: FakeAudioContext = {
			state: opts?.suspended ? "suspended" : "running",
			destination: { __dest: true },
			close: mock(() => {
				inst.state = "closed";
			}),
			resume: mock(() => {
				inst.state = "running";
			}),
			decodeAudioData: mock(async (ab: ArrayBuffer) => {
				if (opts?.decodeFails) {
					throw new Error("decode failed");
				}
				return { __decoded: true, byteLength: ab.byteLength } as unknown as AudioBuffer;
			}),
			createBufferSource: mock(() => {
				const src: FakeAudioBufferSource = {
					buffer: null,
					connect: mock(() => undefined),
					start: mock(() => undefined),
				};
				sources.push(src);
				return src;
			}),
			decodedSources: sources,
		};
		Object.assign(this, inst);
		lastInstance = inst;
	} as unknown as typeof AudioContext;
}

function setUpIpc(opts?: { soundData?: Uint8Array | null }) {
	listeners = new Map();
	invokeFn = mock(async (channel: string) => {
		if (channel === "sound:get-data") {
			return opts?.soundData === undefined ? new Uint8Array([0, 1, 2, 3]) : opts.soundData;
		}
		return;
	}) as IpcInvokeFn;
	const onFn: IpcOnFn = (channel, cb) => {
		const list = listeners.get(channel) ?? [];
		list.push(cb);
		listeners.set(channel, list);
		return () => {
			const current = listeners.get(channel) ?? [];
			listeners.set(
				channel,
				current.filter((x) => x !== cb)
			);
		};
	};
	window.electronAPI = {
		...window.electronAPI,
		invoke: invokeFn,
		on: onFn as typeof window.electronAPI.on,
	};
}

function fireIpc(channel: string, ...args: unknown[]) {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
}

async function flushMicrotasks() {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}

beforeEach(() => {
	lastInstance = null;
});

afterEach(() => {
	(globalThis as { AudioContext?: unknown }).AudioContext = originalAudioContext;
	window.electronAPI = originalElectronApi;
});

describe("useRecordingSound", () => {
	test("invokes 'sound:get-data' on mount and decodes the buffer", async () => {
		setUpAudioContext();
		setUpIpc({ soundData: new Uint8Array([1, 2, 3, 4]) });

		render(<HookHost />);
		await act(async () => {
			await flushMicrotasks();
		});

		expect((invokeFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]).toEqual([
			"sound:get-data",
		]);
		expect(lastInstance).not.toBeNull();
		expect(lastInstance?.decodeAudioData).toHaveBeenCalledTimes(1);
	});

	test("playing 'sound:play' creates a buffer source and starts it", async () => {
		setUpAudioContext();
		setUpIpc();

		render(<HookHost />);
		await act(async () => {
			await flushMicrotasks();
		});

		fireIpc("sound:play");
		expect(lastInstance?.createBufferSource).toHaveBeenCalledTimes(1);
		const source = lastInstance?.decodedSources[0];
		expect(source?.connect).toHaveBeenCalledTimes(1);
		expect(source?.start).toHaveBeenCalledTimes(1);
	});

	test("resumes a suspended AudioContext before playing", async () => {
		setUpAudioContext({ suspended: true });
		setUpIpc();

		render(<HookHost />);
		await act(async () => {
			await flushMicrotasks();
		});

		fireIpc("sound:play");
		expect(lastInstance?.resume).toHaveBeenCalledTimes(1);
	});

	test("does nothing on 'sound:play' when no data was loaded", async () => {
		setUpAudioContext();
		setUpIpc({ soundData: null });

		render(<HookHost />);
		await act(async () => {
			await flushMicrotasks();
		});

		// AudioContext was never created because data was null
		expect(lastInstance).toBeNull();
		// firing play with no listeners installed is a no-op
		fireIpc("sound:play");
	});

	test("swallows decodeAudioData failures and warns", async () => {
		const originalWarn = console.warn;
		const warnings: unknown[][] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(args);
		};
		try {
			setUpAudioContext({ decodeFails: true });
			setUpIpc();

			render(<HookHost />);
			await act(async () => {
				await flushMicrotasks();
			});

			fireIpc("sound:play");
			expect(lastInstance?.createBufferSource).not.toHaveBeenCalled();
			expect(warnings.some((w) => String(w[0]).includes("[sound]"))).toBe(true);
		} finally {
			console.warn = originalWarn;
		}
	});

	test("unmount closes the AudioContext and unsubscribes", async () => {
		setUpAudioContext();
		setUpIpc();

		const { unmount } = render(<HookHost />);
		await act(async () => {
			await flushMicrotasks();
		});

		const closed = lastInstance;
		unmount();
		expect(closed?.close).toHaveBeenCalledTimes(1);
		// Subsequent firings have no listeners
		fireIpc("sound:play");
		expect(lastInstance?.createBufferSource).not.toHaveBeenCalled();
	});
});
