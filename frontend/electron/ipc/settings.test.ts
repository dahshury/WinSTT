import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const listeners = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>();
const appListeners = new Map<string, Array<() => void>>();
let storeData: Record<string, unknown> = {};

const sttProcessState = { running: false, restartCalled: 0 };

const createWindow = (id: number, sentEvents: Array<{ channel: string; payload: unknown }>) => ({
	webContents: {
		id,
		send: (channel: string, payload: unknown) => sentEvents.push({ channel, payload }),
	},
});

const allWindows: ReturnType<typeof createWindow>[] = [];
const sentEvents: Array<{ channel: string; payload: unknown }> = [];

mock.module("electron", () => ({
	app: {
		on: (event: string, cb: () => void) => {
			const list = appListeners.get(event) ?? [];
			list.push(cb);
			appListeners.set(event, list);
		},
		off: (event: string, cb: () => void) => {
			appListeners.set(
				event,
				(appListeners.get(event) ?? []).filter((x) => x !== cb)
			);
		},
	},
	BrowserWindow: {
		getAllWindows: () => allWindows,
	},
	ipcMain: {
		handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
			handlers.set(channel, listener);
		},
		removeHandler: (channel: string) => {
			handlers.delete(channel);
		},
		on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(listener);
			listeners.set(channel, list);
		},
		off: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
			listeners.set(
				channel,
				(listeners.get(channel) ?? []).filter((x) => x !== listener)
			);
		},
	},
}));

import { storeMock } from "@test/mocks/store";

mock.module("../lib/store", () => ({
	...storeMock(),
	store: {
		get store() {
			return storeData;
		},
		get: (key: string) => storeData[key],
		set: (key: string, value: unknown) => {
			storeData[key] = value;
		},
	},
}));

mock.module("./stt-process", () => ({
	isSttProcessRunning: () => sttProcessState.running,
	restartSttProcess: () => {
		sttProcessState.restartCalled++;
	},
}));

const { setupSettingsHandlers, cleanupSettingsHandlers } = await import("./settings");

function fireEvent(channel: string, sender: { id: number }, payload?: unknown): void {
	const list = listeners.get(channel) ?? [];
	for (const cb of list) {
		cb({ sender }, payload);
	}
}

beforeEach(() => {
	storeData = { general: {}, model: {}, audio: {}, quality: {} };
	sttProcessState.running = false;
	sttProcessState.restartCalled = 0;
	sentEvents.length = 0;
	allWindows.length = 0;
	cleanupSettingsHandlers();
	handlers.clear();
	listeners.clear();
	appListeners.clear();
});

afterEach(() => {
	cleanupSettingsHandlers();
});

afterAll(() => {
	// Reset shared state so the global mock.module("./stt-process") doesn't
	// leak `running: true` into sibling test files.
	sttProcessState.running = false;
	sttProcessState.restartCalled = 0;
});

describe("setupSettingsHandlers", () => {
	test("registers settings:load and settings:save", () => {
		setupSettingsHandlers();
		expect(handlers.has("settings:load")).toBe(true);
		expect(listeners.has("settings:save")).toBe(true);
	});

	test("registers a before-quit listener", () => {
		setupSettingsHandlers();
		expect(appListeners.get("before-quit")?.length ?? 0).toBeGreaterThan(0);
	});

	test("settings:load returns the store contents", async () => {
		setupSettingsHandlers();
		const handler = handlers.get("settings:load");
		expect(await handler!(undefined)).toBe(storeData);
	});

	test("cleanupSettingsHandlers removes the handler and listener", () => {
		setupSettingsHandlers();
		cleanupSettingsHandlers();
		expect(handlers.has("settings:load")).toBe(false);
	});
});

describe("settings:save listener", () => {
	test("rejects non-object payload and emits settings:save-error", () => {
		setupSettingsHandlers();
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, { settings: null });
		const errEvent = sentEvents.find((e) => e.channel === "settings:save-error");
		expect(errEvent).toBeTruthy();
	});

	test("applies allowed keys and writes them to the store", () => {
		setupSettingsHandlers();
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: {
				general: { recordingMode: "vad" },
				audio: { inputDeviceIndex: 5 },
			},
		});
		expect((storeData.general as Record<string, unknown>).recordingMode).toBe("vad");
		expect((storeData.audio as Record<string, unknown>).inputDeviceIndex).toBe(5);
	});

	test("ignores keys not in the allowlist", () => {
		setupSettingsHandlers();
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: { __evil: { x: 1 } },
		});
		expect(storeData.__evil).toBeUndefined();
	});

	test("broadcasts settings:changed to OTHER windows but not the sender", () => {
		setupSettingsHandlers();
		const senderEvents: Array<{ channel: string; payload: unknown }> = [];
		const otherEvents: Array<{ channel: string; payload: unknown }> = [];
		const sender = createWindow(1, senderEvents);
		const other = createWindow(2, otherEvents);
		allWindows.push(sender, other);
		fireEvent("settings:save", sender.webContents, {
			settings: { general: { recordingMode: "vad" } },
		});
		expect(senderEvents.length).toBe(0);
		expect(otherEvents.find((e) => e.channel === "settings:changed")).toBeTruthy();
	});

	test("changing a non-startup key does NOT call restartSttProcess", async () => {
		setupSettingsHandlers();
		sttProcessState.running = true;
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: { general: { recordingMode: "vad" } },
		});
		// Wait past the debounce window
		await new Promise((r) => setTimeout(r, 600));
		expect(sttProcessState.restartCalled).toBe(0);
	});

	test("changing a startup-only key while STT is running schedules a restart", async () => {
		setupSettingsHandlers();
		sttProcessState.running = true;
		storeData.audio = { inputDeviceIndex: 1 };
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: { audio: { inputDeviceIndex: 2 } },
		});
		await new Promise((r) => setTimeout(r, 600));
		expect(sttProcessState.restartCalled).toBe(1);
	});

	test("startup-only key change does NOT restart when STT is not running and not connected", async () => {
		setupSettingsHandlers();
		sttProcessState.running = false;
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: { audio: { inputDeviceIndex: 99 } },
		});
		await new Promise((r) => setTimeout(r, 600));
		expect(sttProcessState.restartCalled).toBe(0);
	});

	test("rapid startup-only changes are debounced into a single restart", async () => {
		setupSettingsHandlers();
		sttProcessState.running = true;
		storeData.audio = { inputDeviceIndex: 0 };
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: { audio: { inputDeviceIndex: 1 } },
		});
		fireEvent("settings:save", win.webContents, {
			settings: { audio: { inputDeviceIndex: 2 } },
		});
		fireEvent("settings:save", win.webContents, {
			settings: { audio: { inputDeviceIndex: 3 } },
		});
		await new Promise((r) => setTimeout(r, 700));
		expect(sttProcessState.restartCalled).toBe(1);
	});

	test("before-quit cancels a pending restart", async () => {
		setupSettingsHandlers();
		sttProcessState.running = true;
		storeData.audio = { inputDeviceIndex: 0 };
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: { audio: { inputDeviceIndex: 7 } },
		});
		// Fire before-quit immediately (sets isShuttingDown + clears timer)
		for (const cb of appListeners.get("before-quit") ?? []) {
			cb();
		}
		await new Promise((r) => setTimeout(r, 600));
		expect(sttProcessState.restartCalled).toBe(0);
	});

	test("setupSettingsHandlers re-registration replaces the old listener", () => {
		setupSettingsHandlers();
		const firstCount = listeners.get("settings:save")?.length ?? 0;
		setupSettingsHandlers();
		const secondCount = listeners.get("settings:save")?.length ?? 0;
		// One old listener was removed before re-adding, so count stays at 1
		expect(secondCount).toBe(firstCount);
	});

	test("startup-only key with non-object section in old settings triggers restart", async () => {
		setupSettingsHandlers();
		sttProcessState.running = true;
		// Simulate old store where "audio" was undefined entirely
		storeData = { general: {}, model: {}, audio: undefined, quality: {} };
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: { audio: { inputDeviceIndex: 1 } },
		});
		await new Promise((r) => setTimeout(r, 600));
		expect(sttProcessState.restartCalled).toBe(1);
	});
});
