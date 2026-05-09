import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { storeMock } from "@test/mocks/store";
import { uiohookMock } from "@test/mocks/uiohook-napi";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const listeners = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>();
const uioListeners = new Map<string, Array<(e: { keycode: number }) => void>>();

let storeValue: unknown = "ptt";

mock.module("electron", () => ({
	ipcMain: {
		handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
			handlers.set(channel, listener);
		},
		on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(listener);
			listeners.set(channel, list);
		},
		removeHandler: (channel: string) => handlers.delete(channel),
		off: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
			listeners.set(
				channel,
				(listeners.get(channel) ?? []).filter((x) => x !== listener)
			);
		},
		removeAllListeners: (channel: string) => listeners.delete(channel),
	},
}));

mock.module("uiohook-napi", () => ({
	...uiohookMock(),
	uIOhook: {
		on: (event: string, cb: (e: { keycode: number }) => void) => {
			const list = uioListeners.get(event) ?? [];
			list.push(cb);
			uioListeners.set(event, list);
		},
		off: (event: string, cb: (e: { keycode: number }) => void) => {
			uioListeners.set(
				event,
				(uioListeners.get(event) ?? []).filter((x) => x !== cb)
			);
		},
		start: () => undefined,
		stop: () => undefined,
	},
}));

mock.module("../lib/debug-log", () => ({
	dbg: () => undefined,
	dbgVerbose: () => undefined,
}));

const playSoundCalls: number[] = [];
mock.module("../lib/sound", () => ({
	initSound: () => undefined,
	playRecordingSound: () => {
		playSoundCalls.push(Date.now());
	},
	cleanupSound: () => undefined,
}));

mock.module("../lib/store", () => ({
	...storeMock(),
	getStoreValue: () => storeValue,
}));

// Use the real keycodes module — mocking it here would leak via process-global
// mock.module and break sibling keycodes.test.ts. The uiohook mock supplies
// UiohookKey which keycodes consumes at module init.

const { setupHotkeyHandlers, setPasteGuard } = await import("./hotkey");

const sentEvents: Array<{ channel: string; args: unknown[] }> = [];
const winSent: Array<{ channel: string; args: unknown[] }> = [];

const fakeWindow = {
	isDestroyed: () => false,
	webContents: {
		isDestroyed: () => false,
		send: (channel: string, ...args: unknown[]) => winSent.push({ channel, args }),
		id: 1,
	},
} as unknown as Electron.BrowserWindow;

const fakeSttClient = {
	get isConnected() {
		return sttConnectedState;
	},
} as { isConnected: boolean };

let sttConnectedState = true;
let cleanup: (() => void) | null = null;

function fireKey(event: "keydown" | "keyup", code: number): void {
	for (const cb of uioListeners.get(event) ?? []) {
		cb({ keycode: code });
	}
}

beforeEach(() => {
	handlers.clear();
	listeners.clear();
	uioListeners.clear();
	sentEvents.length = 0;
	winSent.length = 0;
	playSoundCalls.length = 0;
	storeValue = "ptt";
	sttConnectedState = true;
	setPasteGuard(false);
	cleanup = setupHotkeyHandlers(fakeWindow, fakeSttClient as never);
});

afterEach(() => {
	cleanup?.();
	cleanup = null;
});

describe("hotkey module", () => {
	test("setPasteGuard is exported and toggleable without crashing", () => {
		expect(typeof setPasteGuard).toBe("function");
		setPasteGuard(true);
		setPasteGuard(false);
	});

	test("setupHotkeyHandlers registers IPC handlers and uIOhook listeners", () => {
		expect(handlers.has("hotkey:register")).toBe(true);
		expect(handlers.has("hotkey:start-recording")).toBe(true);
		expect(listeners.has("hotkey:unregister")).toBe(true);
		expect(listeners.has("hotkey:stop-recording")).toBe(true);
		expect(uioListeners.get("keydown")?.length ?? 0).toBeGreaterThan(0);
		expect(uioListeners.get("keyup")?.length ?? 0).toBeGreaterThan(0);
	});

	test("hotkey:register with valid accelerator returns true", async () => {
		const reg = handlers.get("hotkey:register");
		const ok = await reg!({}, { accelerator: "LCtrl+R" });
		expect(ok).toBe(true);
	});

	test("hotkey:register with empty accelerator returns false", async () => {
		const reg = handlers.get("hotkey:register");
		const ok = await reg!({}, { accelerator: "" });
		expect(ok).toBe(false);
	});

	test("hotkey:register with non-string accelerator returns false", async () => {
		const reg = handlers.get("hotkey:register");
		const ok = await reg!({}, { accelerator: 123 });
		expect(ok).toBe(false);
	});

	test("hotkey:register with null payload returns false", async () => {
		const reg = handlers.get("hotkey:register");
		const ok = await reg!({}, null);
		expect(ok).toBe(false);
	});

	test("hotkey:register with unknown accelerator returns false", async () => {
		const reg = handlers.get("hotkey:register");
		const ok = await reg!({}, { accelerator: "INVALID" });
		expect(ok).toBe(false);
	});

	test("registered combo fires hotkey:pressed when all keys are down", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		const pressed = winSent.find((e) => e.channel === "hotkey:pressed");
		expect(pressed).toBeTruthy();
		// Sound played because mode=ptt and stt is connected
		expect(playSoundCalls.length).toBe(1);
	});

	test("listen mode skips the recording sound", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		storeValue = "listen";
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		expect(playSoundCalls.length).toBe(0);
	});

	test("stt-disconnected skips the recording sound", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		sttConnectedState = false;
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		expect(playSoundCalls.length).toBe(0);
	});

	test("releasing all combo keys fires hotkey:released", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		winSent.length = 0;
		fireKey("keyup", 47);
		const released = winSent.find((e) => e.channel === "hotkey:released");
		expect(released).toBeTruthy();
	});

	test("paste guard suppresses key activation but tracks releases", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		setPasteGuard(true);
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		// No pressed event during paste guard
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeUndefined();
		setPasteGuard(false);
	});

	test("paste guard during keyup defers release until guard lifts", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		// Press combo (creates active state)
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		// Engage paste guard, then release a key
		setPasteGuard(true);
		fireKey("keyup", 47);
		winSent.length = 0;
		// Lift guard — deferred release should fire
		setPasteGuard(false);
		const released = winSent.find((e) => e.channel === "hotkey:released");
		expect(released).toBeTruthy();
	});

	test("hotkey:unregister clears the active accelerator", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		const unreg = listeners.get("hotkey:unregister")?.[0];
		unreg!({});
		// No pressed event after unregister even with key combo
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeUndefined();
	});

	test("hotkey:start-recording captures keys until stop", async () => {
		const start = handlers.get("hotkey:start-recording");
		await start!({ sender: fakeWindow.webContents });
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		const update = winSent.find((e) => e.channel === "hotkey:recording-update");
		expect(update).toBeTruthy();
	});

	test("Escape during recording cancels (combo: null)", async () => {
		const start = handlers.get("hotkey:start-recording");
		await start!({ sender: fakeWindow.webContents });
		fireKey("keydown", 75); // Escape
		const done = winSent.find((e) => e.channel === "hotkey:recording-done");
		expect(done).toBeTruthy();
		expect((done?.args[0] as { combo: string | null } | undefined)?.combo).toBeNull();
	});

	test("hotkey:stop-recording with captured keys returns combo string", async () => {
		const start = handlers.get("hotkey:start-recording");
		await start!({ sender: fakeWindow.webContents });
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		winSent.length = 0;
		const stop = listeners.get("hotkey:stop-recording")?.[0];
		stop!({});
		const done = winSent.find((e) => e.channel === "hotkey:recording-done");
		const combo = (done?.args[0] as { combo: string | null } | undefined)?.combo;
		expect(combo).toBeTruthy();
		expect(typeof combo).toBe("string");
	});

	test("hotkey:stop-recording with no keys returns null combo", async () => {
		const start = handlers.get("hotkey:start-recording");
		await start!({ sender: fakeWindow.webContents });
		const stop = listeners.get("hotkey:stop-recording")?.[0];
		stop!({});
		const done = winSent.find((e) => e.channel === "hotkey:recording-done");
		expect((done?.args[0] as { combo: string | null } | undefined)?.combo).toBeNull();
	});

	test("recording-mode keyup updates the live preview", async () => {
		const start = handlers.get("hotkey:start-recording");
		await start!({ sender: fakeWindow.webContents });
		fireKey("keydown", 1);
		winSent.length = 0;
		fireKey("keyup", 1);
		const update = winSent.find((e) => e.channel === "hotkey:recording-update");
		expect(update).toBeTruthy();
	});

	test("re-pressing combo without full release does NOT re-fire pressed", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		fireKey("keyup", 47);
		// Ctrl still held — pressing R again should NOT re-activate (combo not fully released)
		winSent.length = 0;
		fireKey("keydown", 47);
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeUndefined();
	});

	test("releasing all combo keys allows next activation", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		fireKey("keyup", 1);
		fireKey("keyup", 47);
		winSent.length = 0;
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeTruthy();
	});

	test("cleanup tears down handlers and listeners", () => {
		const c = cleanup;
		cleanup = null;
		c?.();
		expect(handlers.has("hotkey:register")).toBe(false);
	});
});
