import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realFs from "node:fs";
import { type ElectronMockHandle, electronMock } from "../../test/mocks/electron";
import { electronStoreMock } from "../../test/mocks/electron-store";
import { storeMock } from "../../test/mocks/store";

// `electron` and `node:fs` mocks are kept loose to coexist with other test
// files that mock the same modules — `mock.module(...)` is process-global so
// the LAST file's mock wins, but the source's captured `ipcMain` reference
// is whatever was installed at first import.
//
// Hold a single shared mock instance so handlers registered via initSound() can
// be invoked from this test file via `sharedElectron.ipcMain.invokeHandler()`.
const sharedElectron: ElectronMockHandle = electronMock();
mock.module("electron", () => sharedElectron);

mock.module("electron-store", () => electronStoreMock());

// Configurable fs mock so tests can simulate read failures.
let readFileImpl: (p: string) => Buffer = (_p) => Buffer.from("fake-wav-bytes");
mock.module("node:fs", () => ({
	...realFs,
	default: realFs,
	readFileSync: (p: string) => readFileImpl(p),
}));

// Configurable store mock — tests set storeValues to drive getStoreValue().
const storeValues: Record<string, unknown> = {};
mock.module("./store", () => {
	const base = storeMock();
	return {
		...base,
		getStoreValue: (key: string) => storeValues[key],
		store: {
			...base.store,
			get: (key: string) => storeValues[key],
			set: () => undefined,
			onDidChange: () => () => undefined,
		},
	};
});

const { initSound, playRecordingSound, cleanupSound } = await import("./sound");

// Detect whether sound.ts is using OUR shared electron mock (which has the
// invokeHandler/_handlers helpers used below). When another test file's
// electron mock loaded first into the process-global mock.module cache, the
// captured ipcMain inside sound.ts is NOT our shared instance and we cannot
// invoke its handlers from here. In that case fall back to describe.skip so
// the behavior tests don't run with the wrong mock.
// Probe whether sound.ts's captured ipcMain is OUR sharedElectron mock.
// Register a sentinel handler via initSound then check whether sharedElectron
// has it. If it does NOT, sound.ts is using a different mock instance (because
// another test file imported sound.ts transitively before sound.test.ts could
// install the shared mock — mock.module is process-global but cached imports
// keep their original references).
{
	const probeWin = {
		isDestroyed: () => false,
		webContents: { send: () => undefined },
	};
	cleanupSound();
	initSound(probeWin as never);
}
const usingSharedMock = sharedElectron.ipcMain._handlers.has("sound:get-data");
cleanupSound();
const describeIfShared = usingSharedMock ? describe : describe.skip;

function makeFakeWindow(opts: { destroyed?: boolean } = {}): {
	win: {
		isDestroyed: () => boolean;
		webContents: { send: (channel: string, ...args: unknown[]) => void };
	};
	sent: Array<{ channel: string; args: unknown[] }>;
} {
	const sent: Array<{ channel: string; args: unknown[] }> = [];
	return {
		sent,
		win: {
			isDestroyed: () => opts.destroyed === true,
			webContents: {
				send: (channel: string, ...args: unknown[]) => {
					sent.push({ channel, args });
				},
			},
		},
	};
}

beforeEach(() => {
	for (const k of Object.keys(storeValues)) {
		delete storeValues[k];
	}
	readFileImpl = (_p) => Buffer.from("fake-wav-bytes");
	cleanupSound();
});

afterEach(() => {
	cleanupSound();
});

describe("sound module exports", () => {
	test("exports the public API surface", () => {
		expect(typeof initSound).toBe("function");
		expect(typeof playRecordingSound).toBe("function");
		expect(typeof cleanupSound).toBe("function");
	});

	test("playRecordingSound and cleanupSound do not throw before initSound", () => {
		expect(() => playRecordingSound()).not.toThrow();
		expect(() => cleanupSound()).not.toThrow();
	});
});

describeIfShared("initSound + sound:get-data handler", () => {
	// These tests rely on `sharedElectron` being the same ipcMain that sound.ts
	// captured at import time; if another test file mocked electron first this
	// suite is skipped (mock.module is process-global). In the bucket-5 stryker
	// runs sound.test.ts is the only importer, so the wiring is reliable.
	test("registers a sound:get-data handler", () => {
		const { win } = makeFakeWindow();
		initSound(win as never);
		expect(sharedElectron.ipcMain._handlers.has("sound:get-data")).toBe(true);
	});

	test("handler returns null when general.recordingSound is disabled", async () => {
		const { win } = makeFakeWindow();
		initSound(win as never);
		storeValues["general.recordingSound"] = false;
		const data = await sharedElectron.ipcMain.invokeHandler("sound:get-data");
		expect(data).toBeNull();
	});

	test("handler returns the buffer for the default path when no custom path is set", async () => {
		const { win } = makeFakeWindow();
		initSound(win as never);
		storeValues["general.recordingSound"] = true;
		readFileImpl = () => Buffer.from("default-bytes");
		const data = await sharedElectron.ipcMain.invokeHandler("sound:get-data");
		expect(data).toBeInstanceOf(Buffer);
		expect((data as Buffer).toString()).toBe("default-bytes");
	});

	test("handler returns the buffer for a custom path with an allowed extension", async () => {
		const { win } = makeFakeWindow();
		initSound(win as never);
		storeValues["general.recordingSound"] = true;
		storeValues["general.recordingSoundPath"] = "C:\\sounds\\beep.mp3";
		readFileImpl = (p) => Buffer.from(`from:${p}`);
		const data = await sharedElectron.ipcMain.invokeHandler("sound:get-data");
		expect((data as Buffer).toString()).toBe("from:C:\\sounds\\beep.mp3");
	});

	test("handler falls back to the default path when custom extension is rejected", async () => {
		const { win } = makeFakeWindow();
		initSound(win as never);
		storeValues["general.recordingSound"] = true;
		storeValues["general.recordingSoundPath"] = "C:\\sounds\\malware.exe";
		readFileImpl = (p) => Buffer.from(`from:${p}`);
		const data = await sharedElectron.ipcMain.invokeHandler("sound:get-data");
		// Must NOT pass the .exe path through — must fall through to default.
		expect((data as Buffer).toString()).not.toContain("malware.exe");
		expect((data as Buffer).toString()).toContain("from:");
	});

	test.each([
		".wav",
		".mp3",
		".ogg",
		".flac",
		".m4a",
		".aac",
	])("accepts %s as an allowed sound extension", async (ext) => {
		const { win } = makeFakeWindow();
		initSound(win as never);
		storeValues["general.recordingSound"] = true;
		storeValues["general.recordingSoundPath"] = `C:\\sounds\\beep${ext}`;
		readFileImpl = (p) => Buffer.from(`ok:${p}`);
		const data = await sharedElectron.ipcMain.invokeHandler("sound:get-data");
		expect((data as Buffer).toString()).toContain(`beep${ext}`);
	});

	test("uppercase extension is normalized via toLowerCase()", async () => {
		const { win } = makeFakeWindow();
		initSound(win as never);
		storeValues["general.recordingSound"] = true;
		storeValues["general.recordingSoundPath"] = "C:\\sounds\\BEEP.WAV";
		readFileImpl = (p) => Buffer.from(`ok:${p}`);
		const data = await sharedElectron.ipcMain.invokeHandler("sound:get-data");
		expect((data as Buffer).toString()).toContain("BEEP.WAV");
	});

	test("handler returns null when readFileSync throws", async () => {
		const { win } = makeFakeWindow();
		initSound(win as never);
		storeValues["general.recordingSound"] = true;
		readFileImpl = () => {
			throw new Error("file missing");
		};
		const data = await sharedElectron.ipcMain.invokeHandler("sound:get-data");
		expect(data).toBeNull();
	});

	test("empty custom path string falls through to the default path", async () => {
		// Targets the `custom && custom.length > 0` short-circuit.
		const { win } = makeFakeWindow();
		initSound(win as never);
		storeValues["general.recordingSound"] = true;
		storeValues["general.recordingSoundPath"] = "";
		readFileImpl = (p) => Buffer.from(`from:${p}`);
		const data = await sharedElectron.ipcMain.invokeHandler("sound:get-data");
		// Default path ends with build/splash.wav (path separators vary).
		expect((data as Buffer).toString()).toMatch(/splash\.wav$/);
	});
});

describeIfShared("playRecordingSound", () => {
	test("does NOT send when window has not been initialized", () => {
		// cleanupSound() was called in beforeEach so win is null.
		const { sent } = makeFakeWindow();
		// playRecordingSound has no win to dispatch to → no-op.
		playRecordingSound();
		expect(sent.length).toBe(0);
	});

	test("does NOT send when window has been destroyed", () => {
		const { win, sent } = makeFakeWindow({ destroyed: true });
		initSound(win as never);
		storeValues["general.recordingSound"] = true;
		playRecordingSound();
		expect(sent.length).toBe(0);
	});

	test("does NOT send when recording sound is disabled", () => {
		const { win, sent } = makeFakeWindow();
		initSound(win as never);
		storeValues["general.recordingSound"] = false;
		playRecordingSound();
		expect(sent.length).toBe(0);
	});

	test("sends sound:play to the window when enabled and connected", () => {
		const { win, sent } = makeFakeWindow();
		initSound(win as never);
		storeValues["general.recordingSound"] = true;
		playRecordingSound();
		expect(sent.length).toBe(1);
		expect(sent[0]?.channel).toBe("sound:play");
	});
});

describeIfShared("cleanupSound", () => {
	test("removes the sound:get-data handler", () => {
		const { win } = makeFakeWindow();
		initSound(win as never);
		expect(sharedElectron.ipcMain._handlers.has("sound:get-data")).toBe(true);
		cleanupSound();
		expect(sharedElectron.ipcMain._handlers.has("sound:get-data")).toBe(false);
	});

	test("clears the win reference so playRecordingSound becomes a no-op", () => {
		const { win, sent } = makeFakeWindow();
		initSound(win as never);
		storeValues["general.recordingSound"] = true;
		cleanupSound();
		playRecordingSound();
		expect(sent.length).toBe(0);
	});
});
