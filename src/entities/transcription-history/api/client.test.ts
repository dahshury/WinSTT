import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IPC } from "@/shared/api/ipc-channels";
import type { PaginatedHistory } from "../model/transcription-history";
import {
  deleteHistoryRow,
  listHistoryPage,
  loadHistoryAudio,
  toggleHistoryRow,
} from "./client";

// ── nativeBridge harness ───────────────────────────────────────────────
// The adapter routes every call through `window.nativeBridge.invoke`. The
// preload installs a canonical mock; capture it so afterEach can restore it
// (bun:test shares one happy-dom window across files — leaking a per-test
// override poisons later files that route the REAL ipc-client through it).
const originalNativeBridge = window.nativeBridge;

interface InvokeCall {
  args: unknown[];
  channel: string;
}

let invokeCalls: InvokeCall[] = [];
let invokeImpl: (
  channel: string,
  ...args: unknown[]
) => Promise<unknown> = async () => undefined;

function installFakeBridge(): void {
  invokeCalls = [];
  window.nativeBridge = {
    ...originalNativeBridge,
    invoke: (channel: string, ...args: unknown[]) => {
      invokeCalls.push({ channel, args });
      return invokeImpl(channel, ...args);
    },
  };
}

function removeNativeBridge(): void {
  // `getApi()` returns null when `window.nativeBridge` is absent. Use delete so
  // the `?? null` guard fires (assigning undefined also works, but delete is
  // closer to the real non-bridge context this branch exists for).
  (window as unknown as { nativeBridge?: unknown }).nativeBridge = undefined;
}

beforeEach(() => {
  installFakeBridge();
  invokeImpl = async () => undefined;
});

afterEach(() => {
  window.nativeBridge = originalNativeBridge;
});

describe("listHistoryPage", () => {
  test("forwards the channel + options and returns the resolved page", async () => {
    const page: PaginatedHistory = {
      entries: [
        {
          fileName: "rec.wav",
          id: 7,
          postProcessedText: null,
          postProcessPrompt: null,
          postProcessRequested: false,
          saved: false,
          timestamp: 1,
          title: "hi",
          transcriptionText: "hello",
        },
      ],
      hasMore: true,
    };
    invokeImpl = async () => page;
    const result = await listHistoryPage({ offset: 10, limit: 20 });
    expect(result).toEqual(page);
    expect(invokeCalls).toEqual([
      { channel: IPC.HISTORY_LIST, args: [{ offset: 10, limit: 20 }] },
    ]);
  });

  test("falls back to an empty page when invoke resolves null", async () => {
    invokeImpl = async () => null;
    const result = await listHistoryPage({ offset: 0, limit: 5 });
    expect(result).toEqual({ entries: [], hasMore: false });
  });

  test("returns an empty page (no invoke) when nativeBridge is absent", async () => {
    removeNativeBridge();
    const result = await listHistoryPage({ offset: 0, limit: 5 });
    expect(result).toEqual({ entries: [], hasMore: false });
    // Restore so installFakeBridge's invokeCalls assertion is meaningful and
    // the absent-API path didn't reach an invoke.
    installFakeBridge();
    expect(invokeCalls).toEqual([]);
  });
});

describe("deleteHistoryRow", () => {
  test("returns true only when the result reports deleted === true", async () => {
    invokeImpl = async () => ({ deleted: true });
    expect(await deleteHistoryRow(42)).toBe(true);
    expect(invokeCalls).toEqual([
      { channel: IPC.HISTORY_DELETE_ROW, args: [{ id: 42 }] },
    ]);
  });

  test("returns false when deleted is false", async () => {
    invokeImpl = async () => ({ deleted: false });
    expect(await deleteHistoryRow(42)).toBe(false);
  });

  test("returns false when the result is null (not strictly === true)", async () => {
    invokeImpl = async () => null;
    expect(await deleteHistoryRow(42)).toBe(false);
  });

  test("returns false when nativeBridge is absent", async () => {
    removeNativeBridge();
    expect(await deleteHistoryRow(1)).toBe(false);
  });
});

describe("toggleHistoryRow", () => {
  test("returns the saved boolean from the result", async () => {
    invokeImpl = async () => ({ saved: true });
    expect(await toggleHistoryRow(3)).toBe(true);
    expect(invokeCalls).toEqual([
      { channel: IPC.HISTORY_TOGGLE, args: [{ id: 3 }] },
    ]);
    invokeImpl = async () => ({ saved: false });
    expect(await toggleHistoryRow(3)).toBe(false);
  });

  test("coalesces saved === null to null (?? operator keeps null distinct from false)", async () => {
    invokeImpl = async () => ({ saved: null });
    expect(await toggleHistoryRow(3)).toBeNull();
  });

  test("returns null when the whole result is null", async () => {
    invokeImpl = async () => null;
    expect(await toggleHistoryRow(3)).toBeNull();
  });

  test("returns null (no invoke) when nativeBridge is absent", async () => {
    removeNativeBridge();
    expect(await toggleHistoryRow(3)).toBeNull();
  });
});

describe("loadHistoryAudio", () => {
  test("returns the data-uri string from invoke", async () => {
    invokeImpl = async () => "data:audio/wav;base64,AAAA";
    expect(await loadHistoryAudio(9)).toBe("data:audio/wav;base64,AAAA");
    expect(invokeCalls).toEqual([
      { channel: IPC.HISTORY_LOAD_AUDIO_BY_ROW, args: [{ id: 9 }] },
    ]);
  });

  test("passes through a null result (entry has no WAV)", async () => {
    invokeImpl = async () => null;
    expect(await loadHistoryAudio(9)).toBeNull();
  });

  test("returns null when nativeBridge is absent", async () => {
    removeNativeBridge();
    expect(await loadHistoryAudio(9)).toBeNull();
  });
});
