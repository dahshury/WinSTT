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
	// settings.ts imports `../lib/secret-storage`, which uses `safeStorage`.
	// The shim round-trips strings so encrypt(plain) → decrypt → plain.
	safeStorage: {
		isEncryptionAvailable: () => true,
		encryptString: (s: string) => Buffer.from(`E(${s})`, "utf8"),
		decryptString: (b: Buffer) => {
			const txt = b.toString("utf8");
			if (txt.startsWith("E(") && txt.endsWith(")")) {
				return txt.slice(2, -1);
			}
			throw new Error("bad blob");
		},
	},
}));

import { storeMock } from "@test/mocks/store";

mock.module("../lib/store", () => {
	const base = storeMock();
	return {
		...base,
		store: {
			...base.store,
			get store() {
				return storeData;
			},
			get: (key: string) => storeData[key],
			set: (key: string, value: unknown) => {
				storeData[key] = value;
			},
		},
	};
});

mock.module("./stt-process-deps", () => ({
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

	test("settings:load returns the store contents (decrypted clone)", async () => {
		setupSettingsHandlers();
		const handler = handlers.get("settings:load");
		// settings:load returns a defensive clone with secrets decrypted so the
		// renderer never sees on-disk envelopes. Compare by value, not identity.
		expect(await handler!(undefined)).toEqual(storeData);
	});

	test("cleanupSettingsHandlers removes the handler and listener", () => {
		setupSettingsHandlers();
		cleanupSettingsHandlers();
		expect(handlers.has("settings:load")).toBe(false);
	});

	test("settings:load decrypts the openrouter api key for the renderer", async () => {
		storeData = { llm: { openrouterApiKey: "enc:v1:RShzay1vci10ZXN0KQ==" } };
		setupSettingsHandlers();
		const handler = handlers.get("settings:load");
		const result = (await handler!(undefined)) as { llm: { openrouterApiKey: string } };
		expect(result.llm.openrouterApiKey).toBe("sk-or-test");
	});

	test("settings:load passes legacy plaintext through unchanged", async () => {
		storeData = { llm: { openrouterApiKey: "sk-or-legacy" } };
		setupSettingsHandlers();
		const handler = handlers.get("settings:load");
		const result = (await handler!(undefined)) as { llm: { openrouterApiKey: string } };
		expect(result.llm.openrouterApiKey).toBe("sk-or-legacy");
	});

	test("settings:load does not mutate the on-disk store reference", async () => {
		storeData = { llm: { openrouterApiKey: "enc:v1:RShzay1vci10ZXN0KQ==" } };
		setupSettingsHandlers();
		const handler = handlers.get("settings:load");
		await handler!(undefined);
		// The on-disk value must remain its encrypted form.
		expect((storeData.llm as { openrouterApiKey: string }).openrouterApiKey).toBe(
			"enc:v1:RShzay1vci10ZXN0KQ=="
		);
	});
});

describe("settings:save encryption", () => {
	test("encrypts the openrouter api key before persisting", () => {
		storeData = {};
		setupSettingsHandlers();
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: { llm: { openrouterApiKey: "sk-or-fresh" } },
		});
		const persisted = (storeData.llm as { openrouterApiKey: string }).openrouterApiKey;
		expect(persisted.startsWith("enc:v1:")).toBe(true);
		expect(persisted).not.toBe("sk-or-fresh");
	});

	test("does not encrypt a non-secret field", () => {
		storeData = {};
		setupSettingsHandlers();
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: { llm: { endpoint: "http://localhost:11434" } },
		});
		expect((storeData.llm as { endpoint: string }).endpoint).toBe("http://localhost:11434");
	});

	test("broadcasts plaintext (not ciphertext) to other windows", () => {
		storeData = {};
		setupSettingsHandlers();
		const senderEvents: Array<{ channel: string; payload: unknown }> = [];
		const otherEvents: Array<{ channel: string; payload: unknown }> = [];
		const sender = createWindow(1, senderEvents);
		const other = createWindow(2, otherEvents);
		allWindows.push(sender, other);
		fireEvent("settings:save", sender.webContents, {
			settings: { llm: { openrouterApiKey: "sk-or-fresh" } },
		});
		const broadcast = otherEvents.find((e) => e.channel === "settings:changed");
		expect(broadcast).toBeTruthy();
		const payload = broadcast?.payload as {
			settings: { llm: { openrouterApiKey: string } };
		};
		expect(payload.settings.llm.openrouterApiKey).toBe("sk-or-fresh");
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

	test("saves the 'model' section to the store", () => {
		// Locks down the "model" entry of ALLOWED_SETTINGS_KEYS at L8 — if the
		// literal mutates to "" the model section would silently be dropped.
		setupSettingsHandlers();
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: { model: { model: "tiny" } },
		});
		expect((storeData.model as Record<string, unknown>).model).toBe("tiny");
	});

	test("saves the 'quality' section to the store", () => {
		// Locks down the "quality" entry of ALLOWED_SETTINGS_KEYS at L9.
		setupSettingsHandlers();
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: { quality: { batchSize: 32 } },
		});
		expect((storeData.quality as Record<string, unknown>).batchSize).toBe(32);
	});

	test("saves the 'hotkey' section to the store", () => {
		setupSettingsHandlers();
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: { hotkey: { pushToTalkKey: "Alt+X" } },
		});
		expect((storeData.hotkey as Record<string, unknown>).pushToTalkKey).toBe("Alt+X");
	});

	test("saves the 'dictionary', 'snippets', and 'llm' sections to the store", () => {
		setupSettingsHandlers();
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: {
				dictionary: [{ id: "1", find: "a", replace: "b" }],
				snippets: [{ id: "2", trigger: "/x", expansion: "X" }],
				llm: { enabled: true },
			},
		});
		expect(storeData.dictionary).toEqual([{ id: "1", find: "a", replace: "b" }]);
		expect(storeData.snippets).toEqual([{ id: "2", trigger: "/x", expansion: "X" }]);
		expect((storeData.llm as Record<string, unknown>).enabled).toBe(true);
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
		storeData.audio = { webrtcSensitivity: 1 };
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: { audio: { webrtcSensitivity: 2 } },
		});
		await new Promise((r) => setTimeout(r, 600));
		expect(sttProcessState.restartCalled).toBe(1);
	});

	test("startup-only key change does NOT restart when STT is not running and not connected", async () => {
		setupSettingsHandlers();
		sttProcessState.running = false;
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: { audio: { webrtcSensitivity: 99 } },
		});
		await new Promise((r) => setTimeout(r, 600));
		expect(sttProcessState.restartCalled).toBe(0);
	});

	test("rapid startup-only changes are debounced into a single restart", async () => {
		setupSettingsHandlers();
		sttProcessState.running = true;
		storeData.audio = { webrtcSensitivity: 0 };
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: { audio: { webrtcSensitivity: 1 } },
		});
		fireEvent("settings:save", win.webContents, {
			settings: { audio: { webrtcSensitivity: 2 } },
		});
		fireEvent("settings:save", win.webContents, {
			settings: { audio: { webrtcSensitivity: 3 } },
		});
		await new Promise((r) => setTimeout(r, 700));
		expect(sttProcessState.restartCalled).toBe(1);
	});

	test("before-quit cancels a pending restart", async () => {
		setupSettingsHandlers();
		sttProcessState.running = true;
		storeData.audio = { webrtcSensitivity: 0 };
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: { audio: { webrtcSensitivity: 2 } },
		});
		// Fire before-quit immediately (sets isShuttingDown + clears timer)
		for (const cb of appListeners.get("before-quit") ?? []) {
			cb();
		}
		await new Promise((r) => setTimeout(r, 600));
		expect(sttProcessState.restartCalled).toBe(0);
	});

	test("inputDeviceIndex change does NOT trigger restart (live-swapped via control msg)", async () => {
		// Regression: inputDeviceIndex used to be a startup-only key, which
		// caused a full server restart on every device pick.  It now flows
		// through sttSetParameter("input_device_index") for an in-place swap.
		setupSettingsHandlers();
		sttProcessState.running = true;
		storeData.audio = { inputDeviceIndex: 1 };
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: { audio: { inputDeviceIndex: 5 } },
		});
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
			settings: { audio: { webrtcSensitivity: 1 } },
		});
		await new Promise((r) => setTimeout(r, 600));
		expect(sttProcessState.restartCalled).toBe(1);
	});

	test("startup-only change with only sttClient.isConnected logs manual restart hint", async () => {
		// Exercises hasServerToRestart() via the "connected but not managed" branch:
		// performRestart() goes down the external-server log path instead of restartSttProcess().
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (msg: unknown) => {
			logs.push(String(msg));
		};
		try {
			setupSettingsHandlers({ isConnected: true } as unknown as Parameters<
				typeof setupSettingsHandlers
			>[0]);
			sttProcessState.running = false;
			storeData.audio = { webrtcSensitivity: 0 };
			const win = createWindow(1, sentEvents);
			fireEvent("settings:save", win.webContents, {
				settings: { audio: { webrtcSensitivity: 1 } },
			});
			await new Promise((r) => setTimeout(r, 600));
			expect(sttProcessState.restartCalled).toBe(0);
			expect(logs.some((l) => l.includes("server is not managed by Electron"))).toBe(true);
		} finally {
			console.log = originalLog;
		}
	});

	test("startup-only change with sttClient.isConnected=false and no managed server does not restart", async () => {
		// Locks down the false-arm of hasServerToRestart() when sttClient is provided but disconnected.
		setupSettingsHandlers({ isConnected: false } as unknown as Parameters<
			typeof setupSettingsHandlers
		>[0]);
		sttProcessState.running = false;
		storeData.audio = { webrtcSensitivity: 0 };
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: { audio: { webrtcSensitivity: 1 } },
		});
		await new Promise((r) => setTimeout(r, 600));
		expect(sttProcessState.restartCalled).toBe(0);
	});
});
