import { describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({
	app: {
		isPackaged: false,
		getAppPath: () => "/mock/app",
		getPath: () => "/mock/userdata",
		on: () => undefined,
	},
	ipcMain: {
		handle: () => undefined,
		on: () => undefined,
	},
}));

mock.module("../lib/debug-log", () => ({
	dbg: () => undefined,
}));

import { storeMock } from "@test/mocks/store";

mock.module("../lib/store", () => storeMock());

const sttProcess = await import("./stt-process");

describe("stt-process module", () => {
	test("exports the public API surface", () => {
		expect(typeof sttProcess.isSttProcessRunning).toBe("function");
		// All exports should be functions
		for (const value of Object.values(sttProcess)) {
			expect(typeof value === "function").toBe(true);
		}
	});

	test("isSttProcessRunning is false when no process has been spawned", () => {
		expect(sttProcess.isSttProcessRunning()).toBe(false);
	});
});
