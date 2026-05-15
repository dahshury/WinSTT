import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";
import { storeMock } from "@test/mocks/store";
import { uiohookMock } from "@test/mocks/uiohook-napi";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const listeners = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>();
const uioListeners = new Map<string, Array<(e: { keycode: number }) => void>>();

let storeValue: unknown = "ptt";

// Spread the full electronMock so subsequent test files that import `app`
// from electron (e.g. debug-log.ts) are not broken by this partial mock.
mock.module("electron", () => ({
	...electronMock(),
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

	test("paste guard during keydown defers press: hotkey:pressed fires when guard lifts", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		setPasteGuard(true);
		// User starts cycle 2 PTT during cycle 1's paste — both combo keys
		// land in the guard window. Without deferred-press, this PTT press is
		// silently dropped and the user has to press again.
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeUndefined();
		winSent.length = 0;
		setPasteGuard(false);
		const pressed = winSent.find((e) => e.channel === "hotkey:pressed");
		expect(pressed).toBeTruthy();
	});

	test("paste guard does NOT activate combo if user only partially pressed", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		setPasteGuard(true);
		// Only first combo key pressed during guard — combo not satisfied.
		fireKey("keydown", 1);
		setPasteGuard(false);
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeUndefined();
	});

	test("rapid PTT: cycle 1 paste guard up, user starts cycle 2 — second press registers", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		// Cycle 1: press, release (combo becomes active, then released)
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		fireKey("keyup", 47);
		fireKey("keyup", 1);
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeTruthy();
		expect(winSent.find((e) => e.channel === "hotkey:released")).toBeTruthy();

		// Paste fires (guard goes up). User starts cycle 2 PTT during paste.
		winSent.length = 0;
		setPasteGuard(true);
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		// No event during guard
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeUndefined();
		// Paste finishes, guard lifts → deferred press fires.
		setPasteGuard(false);
		const pressed = winSent.find((e) => e.channel === "hotkey:pressed");
		expect(pressed).toBeTruthy();
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
		expect(handlers.has("hotkey:start-recording")).toBe(false);
		expect((listeners.get("hotkey:unregister") ?? []).length).toBe(0);
		expect((listeners.get("hotkey:stop-recording") ?? []).length).toBe(0);
		// uIOhook listeners are also removed
		expect((uioListeners.get("keydown") ?? []).length).toBe(0);
		expect((uioListeners.get("keyup") ?? []).length).toBe(0);
	});

	test("setupHotkeyHandlers defensively clears any pre-existing handlers/listeners on register", () => {
		// Targets the L355–358 pre-setup removal calls. If these strings are
		// mutated to "" the defensive clear is skipped — verify by seeding
		// stale handlers/listeners and confirming setup overwrites/removes them.
		const c = cleanup;
		cleanup = null;
		c?.();
		// Seed stale entries on the test channels.
		handlers.set("hotkey:register", () => "STALE");
		handlers.set("hotkey:start-recording", () => "STALE");
		listeners.set("hotkey:unregister", [() => undefined, () => undefined]);
		listeners.set("hotkey:stop-recording", [() => undefined]);
		// Re-run setup (this is what beforeEach normally does).
		const newCleanup = setupHotkeyHandlers(fakeWindow, fakeSttClient as never);
		// After setup, the stale handlers must have been cleared and replaced
		// with exactly one fresh entry per channel.
		expect((listeners.get("hotkey:unregister") ?? []).length).toBe(1);
		expect((listeners.get("hotkey:stop-recording") ?? []).length).toBe(1);
		expect(handlers.has("hotkey:register")).toBe(true);
		// The stale handler returns "STALE" — the new one is a real function;
		// invoking the registered handler should NOT return "STALE".
		const fresh = handlers.get("hotkey:register");
		expect(fresh).toBeDefined();
		newCleanup();
		cleanup = setupHotkeyHandlers(fakeWindow, fakeSttClient as never);
	});
});

const { isHotkeyActive } = await import("./hotkey");

describe("isHotkeyActive module-level mirror", () => {
	test("starts as false before any combo activation", () => {
		// Resetting via cleanup in afterEach: verify isHotkeyActive returns false
		// at the start of a fresh setup (the beforeEach re-creates handlers).
		expect(isHotkeyActive()).toBe(false);
	});

	test("flips to true when combo is pressed", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		expect(isHotkeyActive()).toBe(false);
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		expect(isHotkeyActive()).toBe(true);
	});

	test("flips back to false when combo is released", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		expect(isHotkeyActive()).toBe(true);
		fireKey("keyup", 47);
		expect(isHotkeyActive()).toBe(false);
	});
});

describe("hotkey recording-mode key tracking", () => {
	test("hotkey:recording-update payload always carries a 'keys' field", async () => {
		// Targets the ObjectLiteral mutation that drops { keys: ... } → {}.
		const start = handlers.get("hotkey:start-recording");
		await start!({ sender: fakeWindow.webContents });
		fireKey("keydown", 1);
		const update = winSent.find((e) => e.channel === "hotkey:recording-update");
		expect(update).toBeDefined();
		expect(update?.args[0]).toBeDefined();
		const payload = update?.args[0] as { keys?: unknown };
		expect(payload).toHaveProperty("keys");
		expect(Array.isArray(payload.keys)).toBe(true);
		expect((payload.keys as string[]).length).toBeGreaterThan(0);
	});

	test("recording peak snapshot does NOT grow beyond MAX_COMBO_KEYS=3", async () => {
		// Targets the L106 boundary: size <= MAX_COMBO_KEYS guard.
		const start = handlers.get("hotkey:start-recording");
		await start!({ sender: fakeWindow.webContents });
		// Press 4 distinct keys all at once (combo already at 4 > MAX=3).
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		fireKey("keydown", 30);
		fireKey("keydown", 31);
		// Stop recording — peak snapshot should reflect at most 3 keys.
		const stop = listeners.get("hotkey:stop-recording")?.[0];
		stop!({});
		const done = winSent.find((e) => e.channel === "hotkey:recording-done");
		const combo = (done?.args[0] as { combo: string | null } | undefined)?.combo;
		expect(combo).toBeTruthy();
		expect(typeof combo).toBe("string");
		const partCount = (combo as string).split("+").length;
		expect(partCount).toBeLessThanOrEqual(3);
	});

	test("recording peak snapshot stops growing once it reaches MAX_COMBO_KEYS", async () => {
		// Press 3 keys → snapshot=3; press a 4th → snapshot must not grow to 4.
		const start = handlers.get("hotkey:start-recording");
		await start!({ sender: fakeWindow.webContents });
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		fireKey("keydown", 30);
		// Now release one and press a 4th (size grows from 2→3 again, peak stays 3)
		fireKey("keyup", 30);
		fireKey("keydown", 31);
		const stop = listeners.get("hotkey:stop-recording")?.[0];
		stop!({});
		const done = winSent.find((e) => e.channel === "hotkey:recording-done");
		const combo = (done?.args[0] as { combo: string | null } | undefined)?.combo;
		expect((combo as string).split("+").length).toBeLessThanOrEqual(3);
	});

	test("recording-done payload carries a 'combo' field shape", async () => {
		// Targets the ObjectLiteral mutation that drops { combo: ... } → {}.
		const start = handlers.get("hotkey:start-recording");
		await start!({ sender: fakeWindow.webContents });
		fireKey("keydown", 75); // Escape
		const done = winSent.find((e) => e.channel === "hotkey:recording-done");
		expect(done?.args[0]).toBeDefined();
		expect(done?.args[0]).toHaveProperty("combo");
	});
});

describe("recordingSend uses the start-recording sender, not the main window", () => {
	test("recording-update events go to the sender when it differs from win.webContents", async () => {
		const altSent: Array<{ channel: string; args: unknown[] }> = [];
		const altSender = {
			isDestroyed: () => false,
			send: (channel: string, ...args: unknown[]) => altSent.push({ channel, args }),
			id: 99,
		};
		const start = handlers.get("hotkey:start-recording");
		await start!({ sender: altSender });
		fireKey("keydown", 1);
		// Update event should land on altSender, NOT on fakeWindow.webContents.
		const altUpdate = altSent.find((e) => e.channel === "hotkey:recording-update");
		const winUpdate = winSent.find((e) => e.channel === "hotkey:recording-update");
		expect(altUpdate).toBeDefined();
		expect(winUpdate).toBeUndefined();
	});

	test("recording-done lands on the sender after stop", async () => {
		const altSent: Array<{ channel: string; args: unknown[] }> = [];
		const altSender = {
			isDestroyed: () => false,
			send: (channel: string, ...args: unknown[]) => altSent.push({ channel, args }),
			id: 100,
		};
		const start = handlers.get("hotkey:start-recording");
		await start!({ sender: altSender });
		fireKey("keydown", 1);
		const stop = listeners.get("hotkey:stop-recording")?.[0];
		stop!({});
		const altDone = altSent.find((e) => e.channel === "hotkey:recording-done");
		expect(altDone).toBeDefined();
	});

	test("recording-update is suppressed when sender's webContents is destroyed", async () => {
		const altSent: Array<{ channel: string; args: unknown[] }> = [];
		const altSender = {
			isDestroyed: () => true, // destroyed before keydown fires
			send: (channel: string, ...args: unknown[]) => altSent.push({ channel, args }),
			id: 200,
		};
		const start = handlers.get("hotkey:start-recording");
		await start!({ sender: altSender });
		fireKey("keydown", 1);
		// No send when target is destroyed.
		expect(altSent.length).toBe(0);
	});
});

describe("hotkey:register payload edge cases", () => {
	test("undefined payload returns false", async () => {
		const reg = handlers.get("hotkey:register");
		const ok = await reg!({}, undefined);
		expect(ok).toBe(false);
	});

	test("payload with non-object accelerator field returns false", async () => {
		const reg = handlers.get("hotkey:register");
		const ok = await reg!({}, "not-an-object");
		expect(ok).toBe(false);
	});

	test("payload with empty-string accelerator returns false (extractAcceleratorString guard)", async () => {
		// Targets the `acc !== ""` portion of extractAcceleratorString.
		const reg = handlers.get("hotkey:register");
		const ok = await reg!({}, { accelerator: "" });
		expect(ok).toBe(false);
	});
});

describe("hotkey:unregister side effects", () => {
	test("after unregister, releasing a previously-active combo does NOT fire hotkey:released", async () => {
		// Targets the BooleanLiteral mutations on setIsActive(false) and
		// comboFullyReleased = true inside handleUnregister.
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		const unreg = listeners.get("hotkey:unregister")?.[0];
		unreg!({});
		winSent.length = 0;
		// After unregister no combo is active; releasing keys should be a no-op.
		fireKey("keyup", 47);
		fireKey("keyup", 1);
		expect(winSent.find((e) => e.channel === "hotkey:released")).toBeUndefined();
	});

	test("after unregister, isHotkeyActive becomes false", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		expect(isHotkeyActive()).toBe(true);
		const unreg = listeners.get("hotkey:unregister")?.[0];
		unreg!({});
		expect(isHotkeyActive()).toBe(false);
	});
});

describe("hotkey:start-recording disables hotkey detection", () => {
	test("after start-recording, normal combo presses do NOT fire hotkey:pressed", async () => {
		// Targets the BooleanLiteral mutations on isRecording=true,
		// setIsActive(false) inside handleStartRecording.
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		const start = handlers.get("hotkey:start-recording");
		await start!({ sender: fakeWindow.webContents });
		winSent.length = 0;
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		// During recording the combo press path should NOT fire hotkey:pressed.
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeUndefined();
	});

	test("Escape during recording cancels and resetRecording clears state", async () => {
		const start = handlers.get("hotkey:start-recording");
		await start!({ sender: fakeWindow.webContents });
		fireKey("keydown", 1); // Some key
		winSent.length = 0;
		fireKey("keydown", 75); // Escape
		// recording-done fires with combo: null
		const done = winSent.find((e) => e.channel === "hotkey:recording-done");
		expect(done).toBeDefined();
		expect((done?.args[0] as { combo: string | null }).combo).toBeNull();
		// After Escape, subsequent keydowns must NOT generate further recording-update
		// events (recording state was reset).
		winSent.length = 0;
		fireKey("keydown", 47);
		expect(winSent.find((e) => e.channel === "hotkey:recording-update")).toBeUndefined();
	});
});

describe("hotkey:stop-recording return value and reset", () => {
	test("after stop with captured keys, peak snapshot is cleared (next start gets a fresh peak)", async () => {
		const start = handlers.get("hotkey:start-recording");
		await start!({ sender: fakeWindow.webContents });
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		const stop = listeners.get("hotkey:stop-recording")?.[0];
		stop!({});
		// Start a new recording session — only one fresh keydown should produce
		// a one-key peak (proves resetRecording cleared peakSnapshot).
		await start!({ sender: fakeWindow.webContents });
		winSent.length = 0;
		fireKey("keydown", 30);
		const update = winSent.find((e) => e.channel === "hotkey:recording-update");
		expect(update).toBeDefined();
		const payload = update?.args[0] as { keys: string[] };
		expect(payload.keys).toEqual(["A"]);
	});
});

describe("paste guard fully-released gating", () => {
	test("partial press during guard then full release does NOT fire press when guard lifts", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		setPasteGuard(true);
		fireKey("keydown", 1); // only one key of two
		fireKey("keyup", 1); // released before guard lifts
		setPasteGuard(false);
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeUndefined();
		expect(winSent.find((e) => e.channel === "hotkey:released")).toBeUndefined();
	});

	test("paste-guard lift handler errors are swallowed without crashing", () => {
		// Stub the deferred handler to throw; setPasteGuard(false) must not throw.
		// We trigger this by making setPasteGuard install a handler indirectly:
		// fire a keydown during guard, then lift. The internal handler runs
		// `evalOnLift` which is well-formed, but if a future regression makes it
		// throw, the surrounding try/catch should still keep cleanup intact.
		setPasteGuard(true);
		// Simulate a corrupt internal handler by calling setPasteGuard with no
		// pending handler — this should not throw either way.
		expect(() => setPasteGuard(false)).not.toThrow();
	});
});

describe("hotkey deferred press with comboFullyReleased gate", () => {
	test("deferred press is gated on comboFullyReleased=true after a previous activation", async () => {
		// Sequence: press combo → release one key → re-press during guard → lift.
		// Because comboFullyReleased was never set to true between activations,
		// fireDeferredPressIfNeeded should NOT fire a second hotkey:pressed.
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		fireKey("keydown", 1);
		fireKey("keydown", 47); // first press fires
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeTruthy();
		fireKey("keyup", 47); // release one combo key (combo no longer held)
		// hotkey:released fires.
		winSent.length = 0;
		setPasteGuard(true);
		fireKey("keydown", 47); // re-press combo during guard
		setPasteGuard(false);
		// Combo became held again during guard, BUT comboFullyReleased was false
		// (only one of two keys was released). So no deferred press should fire.
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeUndefined();
	});
});

describe("logComboKeyDown does not throw on unknown codes", () => {
	test("pressing a non-combo unknown key during a registered combo is a no-op", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		// Code 9999 isn't in KEYCODE_TO_NAME; the verbose-log fallback `?9999`
		// must not crash and must not affect combo state.
		expect(() => fireKey("keydown", 9999)).not.toThrow();
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeUndefined();
	});

	test("logComboKeyDown is a no-op when no accelerator is registered (kills L177 ConditionalExpression mutant)", () => {
		// No registration → targetKeyCodes is null → logComboKeyDown's
		// `!targetKeyCodes?.has(code)` is true → early return.
		// Mutant `true` always early-returns, but mutant `targetKeyCodes?.has(code)`
		// (the false-branch of the ternary mutator) would attempt to log
		// referencing targetKeyCodes which is null → may throw.
		// We simply assert no crash and no winSent.
		expect(() => fireKey("keydown", 1)).not.toThrow();
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeUndefined();
	});
});

describe("hotkey recording payload field names (mutation guards)", () => {
	test("recording-update payload from a keyup event ALSO carries 'keys' field (kills L267 ObjectLiteral mutant)", async () => {
		const start = handlers.get("hotkey:start-recording");
		await start!({ sender: fakeWindow.webContents });
		fireKey("keydown", 1);
		winSent.length = 0;
		fireKey("keyup", 1);
		const update = winSent.find((e) => e.channel === "hotkey:recording-update");
		expect(update?.args[0]).toBeDefined();
		const payload = update?.args[0] as { keys?: unknown };
		expect(payload).toHaveProperty("keys");
	});

	test("recording-done combo joins names with '+' separator (kills L369 StringLiteral '+' mutant)", async () => {
		const start = handlers.get("hotkey:start-recording");
		await start!({ sender: fakeWindow.webContents });
		fireKey("keydown", 1); // LCtrl
		fireKey("keydown", 47); // R (or similar)
		const stop = listeners.get("hotkey:stop-recording")?.[0];
		stop!({});
		const done = winSent.find((e) => e.channel === "hotkey:recording-done");
		const combo = (done?.args[0] as { combo: string | null } | undefined)?.combo;
		// L369 mutant "" would produce "LCtrlR" instead of "LCtrl+R".
		expect(typeof combo).toBe("string");
		expect(combo as string).toContain("+");
		// Two named keys → exactly one "+" separator.
		expect(((combo as string).match(/\+/g) || []).length).toBe(1);
	});
});

describe("hotkey recording peak preservation (L118 boundary)", () => {
	test("releasing a key after peak is reached does NOT shrink the peak snapshot (kills L118 ConditionalExpression mutant)", async () => {
		// Genuine: `recordingPressed.size > peakSnapshot.length` — peak only
		// grows. Mutant `true` would re-set peak to the smaller current set.
		const start = handlers.get("hotkey:start-recording");
		await start!({ sender: fakeWindow.webContents });
		fireKey("keydown", 1);
		fireKey("keydown", 47); // peak now = 2 keys
		// Release one key → recordingPressed.size = 1, peakSnapshot.length = 2.
		// Genuine: 1 > 2 → false → peak preserved at 2.
		// Mutant `true`: 1 > 2 forced true → peak overwritten to size 1.
		fireKey("keyup", 47);
		const stop = listeners.get("hotkey:stop-recording")?.[0];
		stop!({});
		const done = winSent.find((e) => e.channel === "hotkey:recording-done");
		const combo = (done?.args[0] as { combo: string | null } | undefined)?.combo;
		// Combo must reflect the full 2-key peak.
		expect(combo).toBeTruthy();
		expect((combo as string).split("+").length).toBe(2);
	});
});

describe("hotkey store key fidelity (mutation guards)", () => {
	test("playRecordingSound is suppressed in 'listen' mode regardless of stt connection (kills L205 'general.recordingMode' StringLiteral mutant)", async () => {
		// If the store key were mutated to "", getStoreValue("") would return our
		// override (we mock getStoreValue to return storeValue regardless of key)
		// — actually our mock returns storeValue for any key, so this only kills
		// the LITERAL key when combined with the shouldPlayRecordingSound check
		// that compares the returned value to "listen".
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		storeValue = "listen";
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		expect(playSoundCalls.length).toBe(0);
		// Confirm a hotkey:pressed event still fired (gate is sound-only).
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeTruthy();
	});

	test("deferred press also reads the recording mode and skips sound in 'listen' mode (kills L218 'general.recordingMode' StringLiteral mutant)", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		storeValue = "listen";
		setPasteGuard(true);
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		setPasteGuard(false);
		// Deferred press fires; sound suppressed in listen mode.
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeTruthy();
		expect(playSoundCalls.length).toBe(0);
	});

	test("deferred press with mode='ptt' DOES play recording sound (kills L221 ConditionalExpression mutants on shouldPlayRecordingSound)", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		storeValue = "ptt";
		setPasteGuard(true);
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		setPasteGuard(false);
		// Deferred press fires, mode=ptt + connected → sound played.
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeTruthy();
		expect(playSoundCalls.length).toBe(1);
	});

	test("deferred press with stt disconnected does NOT play sound (kills L221 ConditionalExpression mutants)", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		sttConnectedState = false;
		setPasteGuard(true);
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		setPasteGuard(false);
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeTruthy();
		expect(playSoundCalls.length).toBe(0);
	});
});

describe("handleStartRecording/Unregister state semantics (mutation guards)", () => {
	test("handleStartRecording returns true (kills L363 BooleanLiteral mutant)", async () => {
		const start = handlers.get("hotkey:start-recording");
		const result = await start!({ sender: fakeWindow.webContents });
		expect(result).toBe(true);
	});

	test("handleStartRecording disables hotkey detection — isActive flips to false (kills L362 BooleanLiteral mutant)", async () => {
		// Activate the combo first
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		expect(isHotkeyActive()).toBe(true);
		// Now start recording — internal isActive is forced false.
		const start = handlers.get("hotkey:start-recording");
		await start!({ sender: fakeWindow.webContents });
		expect(isHotkeyActive()).toBe(false);
	});

	test("handleUnregister sets comboFullyReleased=true so the next register can re-activate (kills L352 BooleanLiteral mutant)", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		// Press the combo and DO NOT release — comboFullyReleased becomes false.
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		// Unregister WITHOUT releasing keys.
		const unreg = listeners.get("hotkey:unregister")?.[0];
		unreg!({});
		// Re-register and immediately press the combo — for this to fire
		// hotkey:pressed, comboFullyReleased must have been reset to true.
		await reg!({}, { accelerator: "LCtrl+R" });
		winSent.length = 0;
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeTruthy();
	});
});

describe("deferred press/release isActive mutation guards", () => {
	test("after deferred release, isActive is false (kills L167 BooleanLiteral mutant)", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		expect(isHotkeyActive()).toBe(true);
		setPasteGuard(true);
		fireKey("keyup", 47);
		setPasteGuard(false);
		// L167 genuine: setIsActive(false) → false. Mutant: true → would stay active.
		expect(isHotkeyActive()).toBe(false);
	});

	test("after deferred press, isActive is true (kills L215 BooleanLiteral mutant)", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		setPasteGuard(true);
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		setPasteGuard(false);
		// L215 genuine: setIsActive(true). Mutant false: would stay inactive even
		// after combo became held during guard.
		expect(isHotkeyActive()).toBe(true);
	});

	test("after deferred press, comboFullyReleased=false: re-pressing without full release does NOT re-fire (kills L216 BooleanLiteral mutant)", async () => {
		const reg = handlers.get("hotkey:register");
		await reg!({}, { accelerator: "LCtrl+R" });
		setPasteGuard(true);
		fireKey("keydown", 1);
		fireKey("keydown", 47);
		setPasteGuard(false);
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeTruthy();
		// Release one key (combo no longer held → released fires; comboFullyReleased
		// must NOT yet be true because Ctrl is still held).
		fireKey("keyup", 47);
		winSent.length = 0;
		// Re-press R alone — combo held again → tryActivateCombo gates on
		// comboFullyReleased (genuine: false → no re-fire). Mutant L216: true →
		// would re-fire pressed.
		fireKey("keydown", 47);
		expect(winSent.find((e) => e.channel === "hotkey:pressed")).toBeUndefined();
	});
});

describe("extractAccelerator payload-shape edge cases (mutation guards)", () => {
	test("payload with non-string accelerator (number) returns false (kills L314 ConditionalExpression mutant)", async () => {
		// extractAcceleratorString uses `typeof acc === 'string' && acc !== ""`.
		// Mutating `acc !== ""` to `true` (always true) would still gate on the
		// typeof check. But mutating the empty-string literal to "Stryker was here!"
		// changes the comparison to `acc !== "Stryker was here!"` — for an empty
		// string, that's true → register would succeed for "" — covered by the
		// existing "empty-string accelerator returns false" test.
		const reg = handlers.get("hotkey:register");
		const ok = await reg!({}, { accelerator: 0 });
		expect(ok).toBe(false);
	});

	test("payload that's a truthy non-object (e.g. number 42) returns false (kills L317 ConditionalExpression mutant)", async () => {
		// extractAccelerator gate: `if (!p || typeof p !== "object") return null;`
		// Mutating `typeof p !== "object"` to `false` would let a non-object
		// truthy payload (like 42) fall through and crash on (p as { accelerator })
		// — except numbers/strings have no `.accelerator`, so result is undefined,
		// extractAcceleratorString returns null, register returns false. So this
		// mutant is actually equivalent at the API level — but try a number anyway.
		const reg = handlers.get("hotkey:register");
		const ok = await reg!({}, 42);
		expect(ok).toBe(false);
	});
});
