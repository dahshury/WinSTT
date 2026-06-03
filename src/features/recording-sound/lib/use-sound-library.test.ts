import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useSettingsStore } from "@/entities/setting";
import { IPC } from "@/shared/api/ipc-channels";
import type { SoundLibraryEntry } from "@/shared/config/settings-schema";
import { useSoundLibrary } from "./use-sound-library";

// Drives the hook through a per-file `window.nativeBridge` stub keyed on IPC
// channels (the push-to-talk / catalog-store convention) instead of a global
// `mock.module` — so nothing leaks into sibling test files.

const originalApi = window.nativeBridge;
const initialSettings = useSettingsStore.getState().settings;

interface AddResult {
	entry?: SoundLibraryEntry;
	error?: string;
	ok: boolean;
}
interface RemoveResult {
	error?: string;
	ok: boolean;
}

let addResult: AddResult = { ok: false };
let removeResult: RemoveResult = { ok: true };
let dialogPath: string | null = null;
const invokes: Array<{ channel: string; payload: unknown }> = [];

function installStub(): void {
	addResult = { ok: false };
	removeResult = { ok: true };
	dialogPath = null;
	invokes.length = 0;
	window.nativeBridge = {
		...originalApi,
		getPathForFile: () => "",
		send: () => undefined,
		on: () => () => undefined,
		invoke: async (channel: string, payload?: unknown) => {
			invokes.push({ channel, payload });
			if (channel === IPC.SOUND_LIBRARY_ADD) {
				return addResult;
			}
			if (channel === IPC.SOUND_LIBRARY_REMOVE) {
				return removeResult;
			}
			if (channel === IPC.DIALOG_OPEN_FILE) {
				return dialogPath;
			}
			return;
		},
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

const entry = (id: string, path: string, name = id): SoundLibraryEntry => ({ id, name, path });

describe("useSoundLibrary", () => {
	test("items put the default first followed by every library entry", () => {
		setLibrary([entry("a", "/a.wav", "Alpha")]);
		const { result } = renderHook(() => useSoundLibrary({ defaultName: "Default" }));
		expect(result.current.items.map((i) => i.name)).toEqual(["Default", "Alpha"]);
		expect(result.current.defaultEntry.isDefault).toBe(true);
		expect(result.current.activeItem.isDefault).toBe(true);
	});

	test("activeItem resolves to the entry whose path matches activePath", () => {
		setLibrary([entry("a", "/a.wav")], "/a.wav");
		const { result } = renderHook(() => useSoundLibrary({ defaultName: "Default" }));
		expect(result.current.activeItem.id).toBe("a");
		expect(result.current.activePath).toBe("/a.wav");
	});

	describe("addFromPath", () => {
		test("on success appends the entry, makes it active, returns the item", async () => {
			addResult = { ok: true, entry: entry("new", "/new.wav", "New") };
			const { result } = renderHook(() => useSoundLibrary({ defaultName: "Default" }));
			let returned: unknown;
			await act(async () => {
				returned = await result.current.addFromPath("/src/new.wav", "New");
			});
			expect(returned).toEqual({ id: "new", isDefault: false, name: "New", path: "/new.wav" });
			const g = useSettingsStore.getState().settings.general;
			expect(g.recordingSoundLibrary).toHaveLength(1);
			expect(g.recordingSoundPath).toBe("/new.wav");
		});

		test("on failure calls onError with the server message and returns null", async () => {
			addResult = { ok: false, error: "disk full" };
			const errors: string[] = [];
			const { result } = renderHook(() =>
				useSoundLibrary({ defaultName: "Default", onError: (m) => errors.push(m) })
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
				useSoundLibrary({ defaultName: "Default", onError: (m) => errors.push(m) })
			);
			await act(async () => {
				await result.current.addFromPath("/src/x.wav");
			});
			expect(errors).toEqual(["Could not add sound"]);
		});

		test("missing onError handler swallows the failure without throwing", async () => {
			addResult = { ok: false };
			const { result } = renderHook(() => useSoundLibrary({ defaultName: "Default" }));
			await act(async () => {
				await expect(result.current.addFromPath("/src/x.wav")).resolves.toBeNull();
			});
		});
	});

	describe("addFromBrowse", () => {
		test("returns null and does not add when the dialog is cancelled", async () => {
			dialogPath = null;
			const { result } = renderHook(() => useSoundLibrary({ defaultName: "Default" }));
			let returned: unknown = "sentinel";
			await act(async () => {
				returned = await result.current.addFromBrowse();
			});
			expect(returned).toBeNull();
			expect(invokes.some((i) => i.channel === IPC.SOUND_LIBRARY_ADD)).toBe(false);
		});

		test("delegates to addFromPath with the chosen path on success", async () => {
			dialogPath = "/picked.wav";
			addResult = { ok: true, entry: entry("p", "/picked.wav", "Picked") };
			const { result } = renderHook(() => useSoundLibrary({ defaultName: "Default" }));
			let returned: unknown;
			await act(async () => {
				returned = await result.current.addFromBrowse();
			});
			expect((returned as { id: string }).id).toBe("p");
		});
	});

	describe("remove", () => {
		test("no-ops for the default entry", async () => {
			const { result } = renderHook(() => useSoundLibrary({ defaultName: "Default" }));
			await act(async () => {
				await result.current.remove(result.current.defaultEntry);
			});
			expect(invokes.some((i) => i.channel === IPC.SOUND_LIBRARY_REMOVE)).toBe(false);
		});

		test("removes a custom entry and keeps activePath when it was not active", async () => {
			setLibrary([entry("a", "/a.wav"), entry("b", "/b.wav")], "/b.wav");
			removeResult = { ok: true };
			const { result } = renderHook(() => useSoundLibrary({ defaultName: "Default" }));
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
			const { result } = renderHook(() => useSoundLibrary({ defaultName: "Default" }));
			const target = result.current.items.find((i) => i.id === "a");
			await act(async () => {
				if (target) {
					await result.current.remove(target);
				}
			});
			expect(useSettingsStore.getState().settings.general.recordingSoundPath).toBe("");
		});

		test("surfaces an error when the file unlink fails", async () => {
			setLibrary([entry("a", "/a.wav")], "");
			removeResult = { ok: false, error: "EBUSY" };
			const errors: string[] = [];
			const { result } = renderHook(() =>
				useSoundLibrary({ defaultName: "Default", onError: (m) => errors.push(m) })
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
				useSoundLibrary({ defaultName: "Default", onError: (m) => errors.push(m) })
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
			const { result } = renderHook(() => useSoundLibrary({ defaultName: "Default" }));
			act(() => {
				const custom = result.current.items.find((i) => i.id === "a");
				if (custom) {
					result.current.select(custom);
				}
			});
			expect(useSettingsStore.getState().settings.general.recordingSoundPath).toBe("/a.wav");
			act(() => result.current.select(result.current.defaultEntry));
			expect(useSettingsStore.getState().settings.general.recordingSoundPath).toBe("");
		});

		test("rename trims and writes; blank names are ignored", () => {
			setLibrary([entry("a", "/a.wav", "Old")]);
			const { result } = renderHook(() => useSoundLibrary({ defaultName: "Default" }));
			act(() => result.current.rename("a", "   "));
			expect(useSettingsStore.getState().settings.general.recordingSoundLibrary[0]?.name).toBe(
				"Old"
			);
			act(() => result.current.rename("a", "  Fresh  "));
			expect(useSettingsStore.getState().settings.general.recordingSoundLibrary[0]?.name).toBe(
				"Fresh"
			);
		});
	});
});
