import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import {
	__use_sound_file_drop_test_helpers__ as helpers,
	useSoundFileDrop,
} from "./use-sound-file-drop";

const originalApi = window.electronAPI;
const update = mock(() => undefined);
const t = ((key: string) => key) as Parameters<typeof useSoundFileDrop>[0]["t"];

beforeEach(() => {
	(update as unknown as { mockClear: () => void }).mockClear();
	window.electronAPI = {
		...originalApi,
		invoke: async () => null,
		getPathForFile: () => "/mock/path/sound.wav",
	};
});

afterEach(() => {
	window.electronAPI = originalApi;
});

describe("useSoundFileDrop", () => {
	test("initial state: no drag, no error", () => {
		const { result } = renderHook(() => useSoundFileDrop({ update, t }));
		expect(result.current.dragOver).toBe(false);
		expect(result.current.dropError).toBe("");
	});

	test("dragOver handler sets dragOver=true", () => {
		const { result } = renderHook(() => useSoundFileDrop({ update, t }));
		const event = {
			preventDefault: () => undefined,
		} as unknown as Parameters<typeof result.current.handlers.onDragOver>[0];
		act(() => result.current.handlers.onDragOver(event));
		expect(result.current.dragOver).toBe(true);
	});

	test("dragLeave handler resets dragOver", () => {
		const { result } = renderHook(() => useSoundFileDrop({ update, t }));
		act(() => result.current.handlers.onDragLeave());
		expect(result.current.dragOver).toBe(false);
	});

	test("handleReset clears the recording sound path", () => {
		const { result } = renderHook(() => useSoundFileDrop({ update, t }));
		act(() => result.current.handleReset());
		expect(update).toHaveBeenCalledWith({ recordingSoundPath: "" });
	});

	test("handleBrowse with no file returns silently", async () => {
		const { result } = renderHook(() => useSoundFileDrop({ update, t }));
		await act(async () => {
			await result.current.handleBrowse();
		});
		expect(update).not.toHaveBeenCalled();
	});

	test("handleBrowse with selected file updates recording sound path", async () => {
		window.electronAPI = {
			...originalApi,
			invoke: async () => "/picked/path.wav",
			getPathForFile: () => "/mock/path/sound.wav",
		};
		const { result } = renderHook(() => useSoundFileDrop({ update, t }));
		await act(async () => {
			await result.current.handleBrowse();
		});
		expect(update).toHaveBeenCalledWith({ recordingSoundPath: "/picked/path.wav" });
	});

	test("dropping a file with invalid extension sets a dropError", async () => {
		const { result } = renderHook(() => useSoundFileDrop({ update, t }));
		const file = new File(["hi"], "x.txt", { type: "text/plain" });
		const event = {
			preventDefault: () => undefined,
			dataTransfer: { files: [file] },
		} as unknown as Parameters<typeof result.current.handlers.onDrop>[0];
		await act(async () => {
			await result.current.handlers.onDrop(event);
		});
		expect(result.current.dropError.length).toBeGreaterThan(0);
		expect(update).not.toHaveBeenCalled();
	});

	test("dropping with no file does nothing and does not throw", async () => {
		const { result } = renderHook(() => useSoundFileDrop({ update, t }));
		const event = {
			preventDefault: () => undefined,
			dataTransfer: { files: [] },
		} as unknown as Parameters<typeof result.current.handlers.onDrop>[0];
		await act(async () => {
			await result.current.handlers.onDrop(event);
		});
		expect(update).not.toHaveBeenCalled();
	});
});

describe("hasValidExtension", () => {
	test.each([
		["sound.wav", true],
		["song.MP3", true],
		["nested.path/file.wav", true],
		["file.txt", false],
		["nodot", false],
		["", false],
	])("hasValidExtension(%p) → %p", (input, expected) => {
		expect(helpers.hasValidExtension(input)).toBe(expected);
	});
});

describe("buildDropResultFromFilePath", () => {
	test("non-empty path → ok=true result with that path", () => {
		expect(helpers.buildDropResultFromFilePath("/x/y.wav")).toEqual({
			ok: true,
			filePath: "/x/y.wav",
		});
	});
	test("empty string → ok=false with empty error", () => {
		expect(helpers.buildDropResultFromFilePath("")).toEqual({ ok: false, error: "" });
	});
	test("null → ok=false with empty error", () => {
		expect(helpers.buildDropResultFromFilePath(null)).toEqual({ ok: false, error: "" });
	});
});

describe("validateDroppedSoundFile", () => {
	const mockT = ((key: string, vals?: Record<string, unknown>) =>
		vals ? `${key}:${JSON.stringify(vals)}` : key) as Parameters<
		typeof helpers.validateDroppedSoundFile
	>[1];

	test("rejects unsupported extension with i18n error", async () => {
		const file = new File(["hi"], "evil.txt", { type: "text/plain" });
		const result = await helpers.validateDroppedSoundFile(file, mockT);
		expect(result).toEqual({ ok: false, error: "soundFileDropError" });
	});
});

describe("MAX_DURATION_SECONDS / ACCEPTED_EXTENSIONS constants", () => {
	test("MAX_DURATION_SECONDS is the documented 3-second limit", () => {
		expect(helpers.MAX_DURATION_SECONDS).toBe(3);
	});
	test("ACCEPTED_EXTENSIONS lists wav and mp3", () => {
		expect(helpers.ACCEPTED_EXTENSIONS).toContain("wav");
		expect(helpers.ACCEPTED_EXTENSIONS).toContain("mp3");
	});
});
