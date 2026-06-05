import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useSettingsStore } from "@/entities/setting";
import type { SoundLibraryEntry } from "@/shared/config/settings-schema";
import { useSoundLibrary } from "./use-sound-library";

// Drives the hook through generated Tauri commands for the sound-library IPC
// seam, with a per-file bridge stub for unrelated calls.
// `mock.module` — so nothing leaks into sibling test files.

const originalApi = window.nativeBridge;
const initialSettings = useSettingsStore.getState().settings;

interface AddResult {
  cancelled?: boolean;
  entry?: SoundLibraryEntry;
  error?: string;
  ok: boolean;
}
interface RemoveResult {
  error?: string;
  ok: boolean;
}

let addResult: AddResult = { ok: false };
let pickResult: AddResult = { ok: false, cancelled: true };
let removeResult: RemoveResult = { ok: true };
const tauriCalls: Array<{
  args: Record<string, unknown> | undefined;
  cmd: string;
}> = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    tauriCalls.push({ cmd, args });
    if (cmd === "sound_library_add") {
      return Promise.resolve(addResult);
    }
    if (cmd === "sound_library_pick_and_add") {
      return Promise.resolve(pickResult);
    }
    if (cmd === "sound_library_remove") {
      return Promise.resolve(removeResult);
    }
    return Promise.resolve(undefined);
  },
  Channel: class {},
}));

function installStub(): void {
  addResult = { ok: false };
  pickResult = { ok: false, cancelled: true };
  removeResult = { ok: true };
  tauriCalls.length = 0;
  window.nativeBridge = {
    ...originalApi,
    getPathForFile: () => "",
    send: () => undefined,
    on: () => () => undefined,
    invoke: async () => undefined,
  };
}

function setLibrary(entries: SoundLibraryEntry[], activePath = ""): void {
  useSettingsStore.setState({
    settings: {
      ...initialSettings,
      general: {
        ...initialSettings.general,
        recordingSoundLibrary: entries,
        recordingSoundPath: activePath,
      },
    },
  });
}

beforeEach(() => {
  installStub();
  useSettingsStore.setState({ settings: initialSettings });
});

afterEach(() => {
  window.nativeBridge = originalApi;
  useSettingsStore.setState({ settings: initialSettings });
});

const entry = (id: string, path: string, name = id): SoundLibraryEntry => ({
  id,
  name,
  path,
});

describe("useSoundLibrary", () => {
  test("items put the default first followed by every library entry", () => {
    setLibrary([entry("a", "/a.wav", "Alpha")]);
    const { result } = renderHook(() =>
      useSoundLibrary({ defaultName: "Default" }),
    );
    expect(result.current.items.map((i) => i.name)).toEqual([
      "Default",
      "Alpha",
    ]);
    expect(result.current.defaultEntry.isDefault).toBe(true);
    expect(result.current.activeItem.isDefault).toBe(true);
  });

  test("activeItem resolves to the entry whose path matches activePath", () => {
    setLibrary([entry("a", "/a.wav")], "/a.wav");
    const { result } = renderHook(() =>
      useSoundLibrary({ defaultName: "Default" }),
    );
    expect(result.current.activeItem.id).toBe("a");
    expect(result.current.activePath).toBe("/a.wav");
  });

  describe("addFromPath", () => {
    test("on success appends the entry, makes it active, returns the item", async () => {
      addResult = { ok: true, entry: entry("new", "/new.wav", "New") };
      const { result } = renderHook(() =>
        useSoundLibrary({ defaultName: "Default" }),
      );
      let returned: unknown;
      await act(async () => {
        returned = await result.current.addFromPath("/src/new.wav", "New");
      });
      expect(returned).toEqual({
        id: "new",
        isDefault: false,
        name: "New",
        path: "/new.wav",
      });
      const g = useSettingsStore.getState().settings.general;
      expect(g.recordingSoundLibrary).toHaveLength(1);
      expect(g.recordingSoundPath).toBe("/new.wav");
    });

    test("on failure calls onError with the server message and returns null", async () => {
      addResult = { ok: false, error: "disk full" };
      const errors: string[] = [];
      const { result } = renderHook(() =>
        useSoundLibrary({
          defaultName: "Default",
          onError: (m) => errors.push(m),
        }),
      );
      let returned: unknown = "sentinel";
      await act(async () => {
        returned = await result.current.addFromPath("/src/x.wav");
      });
      expect(returned).toBeNull();
      expect(errors).toEqual(["disk full"]);
    });

    test("falls back to a default message when ok is true but entry is missing", async () => {
      addResult = { ok: true };
      const errors: string[] = [];
      const { result } = renderHook(() =>
        useSoundLibrary({
          defaultName: "Default",
          onError: (m) => errors.push(m),
        }),
      );
      await act(async () => {
        await result.current.addFromPath("/src/x.wav");
      });
      expect(errors).toEqual(["Could not add sound"]);
    });

    test("missing onError handler swallows the failure without throwing", async () => {
      addResult = { ok: false };
      const { result } = renderHook(() =>
        useSoundLibrary({ defaultName: "Default" }),
      );
      await act(async () => {
        await expect(
          result.current.addFromPath("/src/x.wav"),
        ).resolves.toBeNull();
      });
    });
  });

  describe("addFromBrowse", () => {
    test("returns null and does not add when the dialog is cancelled", async () => {
      pickResult = { ok: false, cancelled: true };
      const { result } = renderHook(() =>
        useSoundLibrary({ defaultName: "Default" }),
      );
      let returned: unknown = "sentinel";
      await act(async () => {
        returned = await result.current.addFromBrowse();
      });
      expect(returned).toBeNull();
      expect(tauriCalls.some((i) => i.cmd === "sound_library_add")).toBe(false);
    });

    test("adds the backend-picked entry on success", async () => {
      pickResult = { ok: true, entry: entry("p", "/picked.wav", "Picked") };
      const { result } = renderHook(() =>
        useSoundLibrary({ defaultName: "Default" }),
      );
      let returned: unknown;
      await act(async () => {
        returned = await result.current.addFromBrowse();
      });
      expect((returned as { id: string }).id).toBe("p");
      expect(
        useSettingsStore.getState().settings.general.recordingSoundPath,
      ).toBe("/picked.wav");
    });
  });

  describe("remove", () => {
    test("no-ops for the default entry", async () => {
      const { result } = renderHook(() =>
        useSoundLibrary({ defaultName: "Default" }),
      );
      await act(async () => {
        await result.current.remove(result.current.defaultEntry);
      });
      expect(tauriCalls.some((i) => i.cmd === "sound_library_remove")).toBe(
        false,
      );
    });

    test("removes a custom entry and keeps activePath when it was not active", async () => {
      setLibrary([entry("a", "/a.wav"), entry("b", "/b.wav")], "/b.wav");
      removeResult = { ok: true };
      const { result } = renderHook(() =>
        useSoundLibrary({ defaultName: "Default" }),
      );
      const target = result.current.items.find((i) => i.id === "a");
      await act(async () => {
        if (target) {
          await result.current.remove(target);
        }
      });
      const g = useSettingsStore.getState().settings.general;
      expect(g.recordingSoundLibrary.map((e) => e.id)).toEqual(["b"]);
      expect(g.recordingSoundPath).toBe("/b.wav");
    });

    test("collapses activePath back to default when removing the active entry", async () => {
      setLibrary([entry("a", "/a.wav")], "/a.wav");
      removeResult = { ok: true };
      const { result } = renderHook(() =>
        useSoundLibrary({ defaultName: "Default" }),
      );
      const target = result.current.items.find((i) => i.id === "a");
      await act(async () => {
        if (target) {
          await result.current.remove(target);
        }
      });
      expect(
        useSettingsStore.getState().settings.general.recordingSoundPath,
      ).toBe("");
    });

    test("surfaces an error when the file unlink fails", async () => {
      setLibrary([entry("a", "/a.wav")], "");
      removeResult = { ok: false, error: "EBUSY" };
      const errors: string[] = [];
      const { result } = renderHook(() =>
        useSoundLibrary({
          defaultName: "Default",
          onError: (m) => errors.push(m),
        }),
      );
      const target = result.current.items.find((i) => i.id === "a");
      await act(async () => {
        if (target) {
          await result.current.remove(target);
        }
      });
      expect(errors).toEqual(["EBUSY"]);
    });

    test("uses the fallback message when remove fails without an error string", async () => {
      setLibrary([entry("a", "/a.wav")], "");
      removeResult = { ok: false };
      const errors: string[] = [];
      const { result } = renderHook(() =>
        useSoundLibrary({
          defaultName: "Default",
          onError: (m) => errors.push(m),
        }),
      );
      const target = result.current.items.find((i) => i.id === "a");
      await act(async () => {
        if (target) {
          await result.current.remove(target);
        }
      });
      expect(errors).toEqual(["Could not delete sound file"]);
    });
  });

  describe("select / rename", () => {
    test("select sets path to empty for default and to the file path otherwise", () => {
      setLibrary([entry("a", "/a.wav")]);
      const { result } = renderHook(() =>
        useSoundLibrary({ defaultName: "Default" }),
      );
      act(() => {
        const custom = result.current.items.find((i) => i.id === "a");
        if (custom) {
          result.current.select(custom);
        }
      });
      expect(
        useSettingsStore.getState().settings.general.recordingSoundPath,
      ).toBe("/a.wav");
      act(() => result.current.select(result.current.defaultEntry));
      expect(
        useSettingsStore.getState().settings.general.recordingSoundPath,
      ).toBe("");
    });

    test("rename trims and writes; blank names are ignored", () => {
      setLibrary([entry("a", "/a.wav", "Old")]);
      const { result } = renderHook(() =>
        useSoundLibrary({ defaultName: "Default" }),
      );
      act(() => result.current.rename("a", "   "));
      expect(
        useSettingsStore.getState().settings.general.recordingSoundLibrary[0]
          ?.name,
      ).toBe("Old");
      act(() => result.current.rename("a", "  Fresh  "));
      expect(
        useSettingsStore.getState().settings.general.recordingSoundLibrary[0]
          ?.name,
      ).toBe("Fresh");
    });
  });
});
