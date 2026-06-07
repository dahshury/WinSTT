import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { IPC } from "@/shared/api/ipc-channels";
import { useSoundPreview } from "./use-sound-preview";

// happy-dom has no Web Audio API. We install a controllable fake AudioContext
// and mock the generated Tauri command route used by `soundLibraryReadFile`.

const originalApi = window.nativeBridge;
const OriginalAudioContext = (globalThis as { AudioContext?: unknown })
  .AudioContext;

mock.module("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: (cmd: string) => {
    if (cmd === "sound_library_read_file") {
      invokes.push(IPC.SOUND_LIBRARY_READ_FILE);
      return Promise.resolve(readBytes);
    }
    return Promise.resolve(undefined);
  },
}));

interface FakeSource {
  buffer: unknown;
  connect: () => void;
  disconnect: () => void;
  onended: (() => void) | null;
  start: () => void;
  stop: () => void;
}

let createdSources: FakeSource[] = [];
let ctxState: "running" | "suspended" = "running";
let resumeCalls = 0;
let closeCalls = 0;
let decodeShouldFail = false;
let decodeCalls = 0;
let readBytes: Uint8Array | null = null;
const invokes: string[] = [];
const createdContextOptions: AudioContextOptions[] = [];
const sinkIdCalls: string[] = [];

class FakeAudioContext {
  state: "running" | "suspended" = ctxState;
  constructor(options?: AudioContextOptions) {
    createdContextOptions.push(options ?? {});
  }
  get destination() {
    return {};
  }
  resume(): void {
    resumeCalls += 1;
    this.state = "running";
  }
  close(): Promise<void> {
    closeCalls += 1;
    return Promise.resolve();
  }
  decodeAudioData(): Promise<AudioBuffer> {
    decodeCalls += 1;
    if (decodeShouldFail) {
      return Promise.reject(new Error("bad audio"));
    }
    return Promise.resolve({ duration: 1 } as AudioBuffer);
  }
  setSinkId(sinkId: string | { type: "none" }): Promise<void> {
    sinkIdCalls.push(typeof sinkId === "string" ? sinkId : sinkId.type);
    return Promise.resolve();
  }
  createBufferSource(): FakeSource {
    const src: FakeSource = {
      buffer: null,
      onended: null,
      connect: () => undefined,
      disconnect: () => undefined,
      start: () => undefined,
      stop: () => undefined,
    };
    createdSources.push(src);
    return src;
  }
}

function installStub(): void {
  createdSources = [];
  ctxState = "running";
  resumeCalls = 0;
  closeCalls = 0;
  decodeShouldFail = false;
  decodeCalls = 0;
  readBytes = new Uint8Array([1, 2, 3]);
  invokes.length = 0;
  createdContextOptions.length = 0;
  sinkIdCalls.length = 0;
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
  window.nativeBridge = {
    ...originalApi,
    getPathForFile: () => "",
    send: () => undefined,
    on: () => () => undefined,
    invoke: async (channel: string) => {
      invokes.push(channel);
      if (channel === IPC.SOUND_LIBRARY_READ_FILE) {
        return readBytes;
      }
      return;
    },
  };
}

beforeEach(installStub);

afterEach(() => {
  window.nativeBridge = originalApi;
  (globalThis as { AudioContext?: unknown }).AudioContext =
    OriginalAudioContext;
});

describe("useSoundPreview", () => {
  test("toggle plays the default sound (no path) and tracks playingId", async () => {
    const { result } = renderHook(() => useSoundPreview());
    await act(async () => {
      await result.current.toggle("default", "");
    });
    expect(result.current.playingId).toBe("default");
    expect(invokes).toContain(IPC.SOUND_LIBRARY_READ_FILE);
    expect(createdSources).toHaveLength(1);
  });

  test("toggle plays a custom sound via the file path branch", async () => {
    const { result } = renderHook(() => useSoundPreview());
    await act(async () => {
      await result.current.toggle("custom", "/sounds/a.wav");
    });
    expect(result.current.playingId).toBe("custom");
    expect(invokes).toContain(IPC.SOUND_LIBRARY_READ_FILE);
  });

  test("toggle plays a bundled alternate via the builtin token branch", async () => {
    const { result } = renderHook(() => useSoundPreview());
    await act(async () => {
      await result.current.toggle(
        "builtin",
        "builtin:recording_sound_ui_earcon_1.wav",
      );
    });
    expect(result.current.playingId).toBe("builtin");
    expect(invokes).toContain(IPC.SOUND_LIBRARY_READ_FILE);
  });

  test("toggling the same id again stops playback", async () => {
    const { result } = renderHook(() => useSoundPreview());
    await act(async () => {
      await result.current.toggle("x", "");
    });
    expect(result.current.playingId).toBe("x");
    await act(async () => {
      await result.current.toggle("x", "");
    });
    expect(result.current.playingId).toBeNull();
  });

  test("decoded buffers are cached — replaying the same id does not refetch", async () => {
    const { result } = renderHook(() => useSoundPreview());
    await act(async () => {
      await result.current.toggle("cached", "");
    });
    await act(async () => {
      await result.current.toggle("cached", ""); // stop
    });
    await act(async () => {
      await result.current.toggle("cached", ""); // play again from cache
    });
    expect(decodeCalls).toBe(1);
    expect(
      invokes.filter((c) => c === IPC.SOUND_LIBRARY_READ_FILE),
    ).toHaveLength(1);
  });

  test("aborts when the byte fetch returns null", async () => {
    readBytes = null;
    const { result } = renderHook(() => useSoundPreview());
    await act(async () => {
      await result.current.toggle("none", "");
    });
    expect(result.current.playingId).toBeNull();
    expect(createdSources).toHaveLength(0);
  });

  test("aborts when decoding fails", async () => {
    decodeShouldFail = true;
    const { result } = renderHook(() => useSoundPreview());
    await act(async () => {
      await result.current.toggle("bad", "");
    });
    expect(result.current.playingId).toBeNull();
    expect(createdSources).toHaveLength(0);
  });

  test("resumes a suspended AudioContext before playing", async () => {
    ctxState = "suspended";
    const { result } = renderHook(() => useSoundPreview());
    await act(async () => {
      await result.current.toggle("s", "");
    });
    expect(resumeCalls).toBeGreaterThanOrEqual(1);
  });

  test("routes preview playback to the requested output device", async () => {
    const { result } = renderHook(() => useSoundPreview());
    await act(async () => {
      await result.current.toggle("speaker-a", "", "speaker-a");
    });
    expect(createdContextOptions[0]?.sinkId).toBe("speaker-a");

    await act(async () => {
      await result.current.toggle("speaker-b", "", "speaker-b");
    });
    expect(sinkIdCalls).toContain("speaker-b");
    expect(result.current.playingId).toBe("speaker-b");

    await act(async () => {
      await result.current.toggle("default-output", "", "");
    });
    expect(sinkIdCalls).toContain("");
    expect(result.current.playingId).toBe("default-output");
  });

  test("source.onended clears playingId only when it is still the active source", async () => {
    const { result } = renderHook(() => useSoundPreview());
    await act(async () => {
      await result.current.toggle("first", "");
    });
    const first = createdSources[0];
    // Start a second preview; the first source is no longer active.
    await act(async () => {
      await result.current.toggle("second", "/b.wav");
    });
    expect(result.current.playingId).toBe("second");
    // Stale onended from the first must NOT clobber the new playingId.
    act(() => first?.onended?.());
    expect(result.current.playingId).toBe("second");
    // The active source's onended does clear it.
    const second = createdSources.at(-1);
    act(() => second?.onended?.());
    expect(result.current.playingId).toBeNull();
  });

  test("unmount tears down the audio context and active source", async () => {
    const { result, unmount } = renderHook(() => useSoundPreview());
    await act(async () => {
      await result.current.toggle("u", "");
    });
    unmount();
    expect(closeCalls).toBeGreaterThanOrEqual(1);
  });
});
