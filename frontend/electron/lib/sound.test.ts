import { describe, expect, mock, test } from "bun:test";
import * as realFs from "node:fs";
import { electronMock } from "../../test/mocks/electron";
import { electronStoreMock } from "../../test/mocks/electron-store";

// `electron` and `node:fs` mocks are kept loose to coexist with other test
// files that mock the same modules — `mock.module(...)` is process-global so
// the LAST file's mock wins, but the source's captured `ipcMain` reference
// is whatever was installed at first import.
mock.module("electron", () => electronMock());
mock.module("electron-store", () => electronStoreMock());
mock.module("node:fs", () => ({
	...realFs,
	default: realFs,
	readFileSync: (_p: string) => Buffer.from("fake-wav-bytes"),
}));

const { initSound, playRecordingSound, cleanupSound } = await import("./sound");

describe("sound module", () => {
	test("exports the public API surface", () => {
		expect(typeof initSound).toBe("function");
		expect(typeof playRecordingSound).toBe("function");
		expect(typeof cleanupSound).toBe("function");
	});

	test("playRecordingSound and cleanupSound do not throw before initSound", () => {
		expect(() => playRecordingSound()).not.toThrow();
		expect(() => cleanupSound()).not.toThrow();
	});

	// Note: per-behavior tests against initSound (verifying ipcMain.handle
	// registration, sound:get-data handler return values, webContents.send
	// dispatch) are unreliable in the full suite because `electron`'s
	// `mock.module` is process-global — whichever electron mock loads first
	// wins for `sound.ts`'s captured `ipcMain` reference, and later
	// `mock.module("electron", ...)` calls cannot retroactively rewire it.
	// End-to-end registration is covered by Playwright (phase 10).
});
