import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useSettingsStore } from "@/entities/setting";
import { IPC } from "@/shared/api/ipc-channels";
import type { SoundLibraryEntry } from "@/shared/config/settings-schema";
import { MAX_CUSTOM_SOUNDS } from "../model/recording-sound";
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
		invoke: async (channel: string) => {
			if (channel === IPC.SOUND_LIBRARY_ADD) {
				return addResult;
			}
			if (channel === IPC.SOUND_LIBRARY_PICK_AND_ADD) {
				return pickResult;
			}
			if (channel === IPC.SOUND_LIBRARY_REMOVE) {
				return removeResult;
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
			"Marimba",
			"UI Earcon 1",
			"UI Earcon 4",
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

	test("activeItem resolves to a bundled item whose builtin token matches activePath", () => {
		setLibrary([], "builtin:recording_sound_ui_earcon_4.wav");
		const { result } = renderHook(() =>
			useSoundLibrary({ defaultName: "Default" }),
		);
		expect(result.current.activeItem.name).toBe("UI Earcon 4");
		expect(result.current.activeItem.path).toBe(
			"builtin:recording_sound_ui_earcon_4.wav",
		);
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

	describe("limit (MAX_CUSTOM_SOUNDS)", () => {
		const fullLibrary = (): SoundLibraryEntry[] =>
			Array.from({ length: MAX_CUSTOM_SOUNDS }, (_, i) =>
				entry(`s${i}`, `/s${i}.wav`),
			);

		test("isFull is false below the cap and true at the cap", () => {
			setLibrary(fullLibrary().slice(0, MAX_CUSTOM_SOUNDS - 1));
			const { result, rerender } = renderHook(() =>
				useSoundLibrary({ defaultName: "Default" }),
			);
			expect(result.current.isFull).toBe(false);
			act(() => setLibrary(fullLibrary()));
			rerender();
			expect(result.current.isFull).toBe(true);
		});

		test("addFromPath at the cap rejects with the limit message and skips the add command", async () => {
			setLibrary(fullLibrary());
			addResult = { ok: true, entry: entry("over", "/over.wav") };
			const errors: string[] = [];
			const { result } = renderHook(() =>
				useSoundLibrary({
					defaultName: "Default",
					limitMessage: "FULL",
					onError: (m) => errors.push(m),
				}),
			);
			let returned: unknown = "sentinel";
			await act(async () => {
				returned = await result.current.addFromPath("/src/over.wav");
			});
			expect(returned).toBeNull();
			expect(errors).toEqual(["FULL"]);
			expect(tauriCalls.some((i) => i.cmd === "sound_library_add")).toBe(false);
		});

		test("addFromBrowse at the cap rejects without opening the picker dialog", async () => {
			setLibrary(fullLibrary());
			pickResult = { ok: true, entry: entry("over", "/over.wav") };
			const errors: string[] = [];
			const { result } = renderHook(() =>
				useSoundLibrary({
					defaultName: "Default",
					limitMessage: "FULL",
					onError: (m) => errors.push(m),
				}),
			);
			let returned: unknown = "sentinel";
			await act(async () => {
				returned = await result.current.addFromBrowse();
			});
			expect(returned).toBeNull();
			expect(errors).toEqual(["FULL"]);
			expect(
				tauriCalls.some((i) => i.cmd === "sound_library_pick_and_add"),
			).toBe(false);
		});
	});

	describe("remove", () => {
		test("no-ops for built-in entries", async () => {
			const { result } = renderHook(() =>
				useSoundLibrary({ defaultName: "Default" }),
			);
			await act(async () => {
				await result.current.remove(result.current.defaultEntry);
				const builtIn = result.current.items.find(
					(i) => i.path === "builtin:recording_sound_ui_earcon_1.wav",
				);
				if (builtIn) {
					await result.current.remove(builtIn);
				}
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
		test("select sets path to empty for original default, builtin token for bundled choices, and file path for customs", () => {
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
			act(() => {
				const builtIn = result.current.items.find(
					(i) => i.path === "builtin:recording_sound_ui_earcon_1.wav",
				);
				if (builtIn) {
					result.current.select(builtIn);
				}
			});
			expect(
				useSettingsStore.getState().settings.general.recordingSoundPath,
			).toBe("builtin:recording_sound_ui_earcon_1.wav");
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
