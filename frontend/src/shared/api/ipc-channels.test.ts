import { describe, expect, test } from "bun:test";
import { channelsByDirection, IPC, IPC_DIRECTIONS, type IpcChannel } from "./ipc-channels";

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

describe("IPC_DIRECTIONS", () => {
	test("has an entry for every IPC channel", () => {
		const directionKeys = new Set(Object.keys(IPC_DIRECTIONS));
		for (const channel of Object.values(IPC)) {
			expect(directionKeys.has(channel)).toBe(true);
		}
	});

	test("declares no extraneous channels beyond IPC", () => {
		const ipcValues = new Set<string>(Object.values(IPC));
		for (const channel of Object.keys(IPC_DIRECTIONS)) {
			expect(ipcValues.has(channel)).toBe(true);
		}
	});

	test("every direction value is a known IpcDirection", () => {
		const valid = new Set(["send", "invoke", "on", "secure"]);
		for (const dirs of Object.values(IPC_DIRECTIONS)) {
			for (const dir of dirs) {
				expect(valid.has(dir)).toBe(true);
			}
		}
	});
});

describe("channelsByDirection", () => {
	test("returns every channel whose direction list includes the query", () => {
		const sendChannels = new Set(channelsByDirection("send"));
		expect(sendChannels.has(IPC.SETTINGS_SAVE)).toBe(true);
		expect(sendChannels.has(IPC.STT_RELOAD_MODEL)).toBe(true);
		expect(sendChannels.has(IPC.TRAY_MENU_RESIZE)).toBe(true);
		expect(sendChannels.has(IPC.SETTINGS_LOAD)).toBe(false);
	});

	test("returns invoke channels including the secure-encrypted ones", () => {
		const invokeChannels = new Set(channelsByDirection("invoke"));
		expect(invokeChannels.has(IPC.SETTINGS_LOAD)).toBe(true);
		expect(invokeChannels.has(IPC.CLIPBOARD_OPERATE)).toBe(true);
		expect(invokeChannels.has(IPC.SETTINGS_SAVE)).toBe(false);
	});

	test("returns push channels for direction='on'", () => {
		const onChannels = new Set(channelsByDirection("on"));
		expect(onChannels.has(IPC.STT_REALTIME_TEXT)).toBe(true);
		expect(onChannels.has(IPC.SETTINGS_CHANGED)).toBe(true);
		expect(onChannels.has(IPC.SETTINGS_SAVE)).toBe(false);
	});

	test("returns only the secure-tagged channels for direction='secure'", () => {
		const secureChannels = new Set(channelsByDirection("secure"));
		expect(secureChannels.has(IPC.CLIPBOARD_OPERATE)).toBe(true);
		expect(secureChannels.has(IPC.UPDATER_GET_STATUS_HISTORY)).toBe(true);
		expect(secureChannels.has(IPC.UPDATER_CLEAR_STATUS_HISTORY)).toBe(true);
		// Generic invoke channels must NOT be secure.
		expect(secureChannels.has(IPC.SETTINGS_LOAD)).toBe(false);
	});

	test("internal preload-only channels carry no renderer-facing direction", () => {
		expect(IPC_DIRECTIONS[IPC.SECURE_GET_KEY]).toEqual([]);
		expect(IPC_DIRECTIONS[IPC.SECURE_INVOKE]).toEqual([]);
	});
});
