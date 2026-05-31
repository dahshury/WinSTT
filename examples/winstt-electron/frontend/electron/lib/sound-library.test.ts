import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { electronMock } from "../../test/mocks/electron";

// ── Real temp userData dir ───────────────────────────────────────────
//
// sound-library.ts performs REAL fs operations (mkdir/copy/read/unlink) under
// `app.getPath("userData")/sounds`. Rather than mock `node:fs` (which is
// process-global and would poison other test files — see sound.test.ts), we
// point `app.getPath("userData")` at a real throwaway temp dir and let the
// source touch the actual disk. Only the `electron` module is mocked.

const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "winstt-soundlib-"));

const sharedElectron = electronMock();
sharedElectron.app.getPath = (name: string) =>
	name === "userData" ? TMP_USER_DATA : `/mock/${name}`;
mock.module("electron", () => sharedElectron);

const { initSoundLibrary } = await import("./sound-library");
const { IPC } = await import("../../src/shared/api/ipc-channels");

// The library dir the source derives from our temp userData.
const LIBRARY_DIR = path.join(TMP_USER_DATA, "sounds");

interface AddResult {
	entry?: { id: string; name: string; path: string };
	error?: string;
	ok: boolean;
}

// Invoke the three handlers through the same ipcMain the source registered
// them on (our shared electron mock), exactly as the real renderer would.
let dispose: (() => void) | null = null;

function invokeAdd(payload: unknown): Promise<AddResult> {
	return sharedElectron.ipcMain.invokeHandler(IPC.SOUND_LIBRARY_ADD, payload) as Promise<AddResult>;
}
function invokeRemove(payload: unknown): Promise<{ ok: boolean; error?: string }> {
	return sharedElectron.ipcMain.invokeHandler(IPC.SOUND_LIBRARY_REMOVE, payload) as Promise<{
		ok: boolean;
		error?: string;
	}>;
}
function invokeReadFile(payload: unknown): Promise<Uint8Array | null> {
	return sharedElectron.ipcMain.invokeHandler(
		IPC.SOUND_LIBRARY_READ_FILE,
		payload
	) as Promise<Uint8Array | null>;
}

// Create a real source file on disk and return its path.
function writeSourceFile(name: string, contents: string): string {
	const p = path.join(TMP_USER_DATA, name);
	fs.writeFileSync(p, contents);
	return p;
}

beforeEach(() => {
	// Fresh empty library before each test.
	if (fs.existsSync(LIBRARY_DIR)) {
		fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
	}
	dispose = initSoundLibrary();
});

afterEach(() => {
	dispose?.();
	dispose = null;
});

afterAll(() => {
	fs.rmSync(TMP_USER_DATA, { recursive: true, force: true });
});

describe("initSoundLibrary wiring", () => {
	test("registers all three handlers and the disposer removes them", () => {
		expect(sharedElectron.ipcMain._handlers.has(IPC.SOUND_LIBRARY_ADD)).toBe(true);
		expect(sharedElectron.ipcMain._handlers.has(IPC.SOUND_LIBRARY_REMOVE)).toBe(true);
		expect(sharedElectron.ipcMain._handlers.has(IPC.SOUND_LIBRARY_READ_FILE)).toBe(true);
		dispose?.();
		dispose = null;
		expect(sharedElectron.ipcMain._handlers.has(IPC.SOUND_LIBRARY_ADD)).toBe(false);
		expect(sharedElectron.ipcMain._handlers.has(IPC.SOUND_LIBRARY_REMOVE)).toBe(false);
		expect(sharedElectron.ipcMain._handlers.has(IPC.SOUND_LIBRARY_READ_FILE)).toBe(false);
	});
});

describe("handleAdd", () => {
	test("rejects a missing sourcePath", async () => {
		const res = await invokeAdd({});
		expect(res.ok).toBe(false);
		expect(res.error).toBe("Invalid source path");
	});

	test("rejects a non-string sourcePath", async () => {
		const res = await invokeAdd({ sourcePath: 123 });
		expect(res.ok).toBe(false);
		expect(res.error).toBe("Invalid source path");
	});

	test("rejects a disallowed extension", async () => {
		const res = await invokeAdd({ sourcePath: "C:\\sounds\\beep.exe" });
		expect(res.ok).toBe(false);
		expect(res.error).toBe("Only .wav and .mp3 files are accepted");
	});

	test("rejects when the source file does not exist", async () => {
		const res = await invokeAdd({
			sourcePath: path.join(TMP_USER_DATA, "does-not-exist.wav"),
		});
		expect(res.ok).toBe(false);
		expect(res.error).toBe("Source file not found");
	});

	test("copies an allowed file into the library and derives a name from the basename", async () => {
		const src = writeSourceFile("MyBeep.wav", "RIFF-fake-wav");
		const res = await invokeAdd({ sourcePath: src });
		expect(res.ok).toBe(true);
		expect(res.entry?.name).toBe("MyBeep");
		// Copied file lives inside the library dir and carries the source ext.
		expect(res.entry?.path.startsWith(LIBRARY_DIR)).toBe(true);
		expect(res.entry?.path.endsWith(".wav")).toBe(true);
		expect(fs.existsSync(res.entry?.path as string)).toBe(true);
		expect(fs.readFileSync(res.entry?.path as string, "utf-8")).toBe("RIFF-fake-wav");
	});

	test("normalizes an uppercase extension and accepts .mp3", async () => {
		const src = writeSourceFile("Chime.MP3", "ID3-fake-mp3");
		const res = await invokeAdd({ sourcePath: src });
		expect(res.ok).toBe(true);
		expect(res.entry?.path.endsWith(".mp3")).toBe(true);
	});

	test("uses an explicit trimmed name when provided", async () => {
		const src = writeSourceFile("ignored-basename.wav", "x");
		const res = await invokeAdd({ sourcePath: src, name: "  Custom Name  " });
		expect(res.ok).toBe(true);
		expect(res.entry?.name).toBe("Custom Name");
	});

	test("falls back to the basename when the explicit name is blank", async () => {
		const src = writeSourceFile("FromBase.wav", "x");
		const res = await invokeAdd({ sourcePath: src, name: "   " });
		expect(res.ok).toBe(true);
		expect(res.entry?.name).toBe("FromBase");
	});

	test("rejects a bare dotfile like '.wav' (path.extname is empty → not an allowed ext)", async () => {
		// A leading-dot-only filename has NO extension per Node's path.extname
		// (".wav" → ""), so sanitizeExtension returns null and the add is
		// rejected before any copy. Locks the real platform behavior.
		const src = writeSourceFile(".wav", "x");
		const res = await invokeAdd({ sourcePath: src });
		expect(res.ok).toBe(false);
		expect(res.error).toBe("Only .wav and .mp3 files are accepted");
	});

	test("assigns a unique id per add (two adds of the same source do not collide)", async () => {
		const src = writeSourceFile("dup.wav", "x");
		const a = await invokeAdd({ sourcePath: src });
		const b = await invokeAdd({ sourcePath: src });
		expect(a.entry?.id).not.toBe(b.entry?.id);
		expect(a.entry?.path).not.toBe(b.entry?.path);
	});

	test("returns a copy-failure error when the destination cannot be written", async () => {
		// Make the source a directory so copyFileSync throws (EISDIR/EPERM).
		const dirSrc = path.join(TMP_USER_DATA, "a-dir.wav");
		if (!fs.existsSync(dirSrc)) {
			fs.mkdirSync(dirSrc);
		}
		const res = await invokeAdd({ sourcePath: dirSrc });
		expect(res.ok).toBe(false);
		expect(res.error?.startsWith("Failed to copy file:")).toBe(true);
	});
});

describe("handleRemove", () => {
	test("rejects a missing path", async () => {
		const res = await invokeRemove({});
		expect(res.ok).toBe(false);
		expect(res.error).toBe("Invalid path");
	});

	test("refuses to delete a file outside the library folder", async () => {
		const outside = writeSourceFile("outside.wav", "x");
		const res = await invokeRemove({ path: outside });
		expect(res.ok).toBe(false);
		expect(res.error).toBe("Refusing to delete file outside library folder");
		// The outside file is untouched.
		expect(fs.existsSync(outside)).toBe(true);
	});

	test("removes a file that lives inside the library folder", async () => {
		const src = writeSourceFile("toremove.wav", "x");
		const added = await invokeAdd({ sourcePath: src });
		const dest = added.entry?.path as string;
		expect(fs.existsSync(dest)).toBe(true);
		const res = await invokeRemove({ path: dest });
		expect(res.ok).toBe(true);
		expect(fs.existsSync(dest)).toBe(false);
	});

	test("succeeds (no-op) when the in-library file is already gone", async () => {
		const ghost = path.join(LIBRARY_DIR, "already-deleted.wav");
		// Ensure the library dir exists so the in-library prefix check passes.
		fs.mkdirSync(LIBRARY_DIR, { recursive: true });
		const res = await invokeRemove({ path: ghost });
		expect(res.ok).toBe(true);
	});
});

describe("handleReadFile", () => {
	test("returns null for a missing path", async () => {
		const res = await invokeReadFile({});
		expect(res).toBeNull();
	});

	test("returns null when the file cannot be read", async () => {
		const res = await invokeReadFile({ path: path.join(LIBRARY_DIR, "nope.wav") });
		expect(res).toBeNull();
	});

	test("returns the bytes of an existing file", async () => {
		const src = writeSourceFile("read-me.wav", "hello-bytes");
		const added = await invokeAdd({ sourcePath: src });
		const data = await invokeReadFile({ path: added.entry?.path });
		expect(data).not.toBeNull();
		expect(Buffer.from(data as Uint8Array).toString("utf-8")).toBe("hello-bytes");
	});
});
