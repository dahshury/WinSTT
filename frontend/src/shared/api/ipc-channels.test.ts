import { describe, expect, test } from "bun:test";
import { IPC, type IpcChannel } from "./ipc-channels";

describe("IPC channel constants", () => {
	test("contains a 'stt:realtime-text' channel", () => {
		expect(IPC.STT_REALTIME_TEXT).toBe("stt:realtime-text");
	});

	test("all channel string values are unique", () => {
		const values = Object.values(IPC);
		expect(new Set(values).size).toBe(values.length);
	});

	test("every channel value is a non-empty string", () => {
		for (const value of Object.values(IPC)) {
			expect(typeof value).toBe("string");
			expect(value.length).toBeGreaterThan(0);
		}
	});

	test("settings channels follow the canonical 'settings:*' prefix", () => {
		expect(IPC.SETTINGS_LOAD.startsWith("settings:")).toBe(true);
		expect(IPC.SETTINGS_SAVE.startsWith("settings:")).toBe(true);
		expect(IPC.SETTINGS_CHANGED.startsWith("settings:")).toBe(true);
		expect(IPC.SETTINGS_SAVE_ERROR.startsWith("settings:")).toBe(true);
	});

	test("IpcChannel type accepts any IPC value", () => {
		const ch: IpcChannel = IPC.STT_REALTIME_TEXT;
		expect(typeof ch).toBe("string");
	});
});
