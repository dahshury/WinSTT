import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";

const appListeners = new Map<string, Array<() => void>>();
let storeData: Record<string, unknown> = {};

const sttProcessState = { running: false, restartCalled: 0 };

const createWindow = (
	id: number,
	sentEvents: Array<{ channel: string; payload: unknown }>,
	options: { destroyed?: boolean; throwOnSend?: boolean } = {}
) => ({
	webContents: {
		id,
		send: (channel: string, payload: unknown) => {
			if (options.throwOnSend) {
				throw new Error("renderer-hung");
			}
			sentEvents.push({ channel, payload });
		},
	},
	isDestroyed: () => Boolean(options.destroyed),
});

const allWindows: ReturnType<typeof createWindow>[] = [];
const sentEvents: Array<{ channel: string; payload: unknown }> = [];

// Spread `electronMock()` so the process-global mock leak this installs is
// semantically complete — partial shims would make every later test importing
// `Tray`/`Menu`/etc. from `electron` throw "Export named X not found".
// Override only the surfaces this test needs to drive: `app.on/off` to capture
// before-quit listeners, `BrowserWindow.getAllWindows` to feed the broadcast
// path, and `safeStorage` for round-trip secret encryption.
const base = electronMock();
const handlers = base.ipcMain._handlers;
const listeners = base.ipcMain._listeners;

mock.module("electron", () => ({
	...base,
	app: {
		...base.app,
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
		...base.BrowserWindow,
		getAllWindows: () => allWindows,
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

function setNestedByDotPath(target: Record<string, unknown>, key: string, value: unknown): void {
	if (!key.includes(".")) {
		target[key] = value;
		return;
	}
	const parts = key.split(".");
	let cur = target;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i] as string;
		const next = cur[part];
		if (next == null || typeof next !== "object" || Array.isArray(next)) {
			cur[part] = {};
		}
		cur = cur[part] as Record<string, unknown>;
	}
	cur[parts.at(-1) as string] = value;
}

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
				setNestedByDotPath(storeData, key, value);
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

const {
	setupSettingsHandlers,
	cleanupSettingsHandlers,
	applyMainProcessSettingsPatch,
	__settings_test_helpers__,
} = await import("./settings");

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
				dictionary: [{ id: "1", term: "Kubernetes" }],
				snippets: [{ id: "2", trigger: "/x", expansion: "X" }],
				llm: { enabled: true },
			},
		});
		expect(storeData.dictionary).toEqual([{ id: "1", term: "Kubernetes" }]);
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

describe("wake-word config restart predicate", () => {
	test("staying in wakeword mode with a changed wakeWord schedules a restart", async () => {
		setupSettingsHandlers();
		sttProcessState.running = true;
		storeData = {
			general: { recordingMode: "wakeword", wakeWord: "jarvis" },
			audio: {},
			model: {},
			quality: {},
		};
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: {
				general: { recordingMode: "wakeword", wakeWord: "alexa" },
				audio: {},
				model: {},
				quality: {},
			},
		});
		await new Promise((r) => setTimeout(r, 600));
		// Wake-word param changed while staying in wakeword mode → wakeWordRestartNeeded()
		// → resolveChangedKey() falls back to "general.wakeWord" → restart scheduled.
		expect(sttProcessState.restartCalled).toBe(1);
	});

	test("staying in wakeword mode with no wake-field change does NOT restart", async () => {
		setupSettingsHandlers();
		sttProcessState.running = true;
		storeData = {
			general: { recordingMode: "wakeword", wakeWord: "jarvis", wakeWordSensitivity: 0.5 },
			audio: {},
			model: {},
			quality: {},
		};
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: {
				general: { recordingMode: "wakeword", wakeWord: "jarvis", wakeWordSensitivity: 0.5 },
				audio: {},
				model: {},
				quality: {},
			},
		});
		await new Promise((r) => setTimeout(r, 600));
		expect(sttProcessState.restartCalled).toBe(0);
	});

	test("staying in wakeword mode with a changed wakeWordTimeout restarts (anyWakeFieldChanged loop)", async () => {
		setupSettingsHandlers();
		sttProcessState.running = true;
		storeData = {
			general: {
				recordingMode: "wakeword",
				wakeWord: "jarvis",
				wakeWordSensitivity: 0.5,
				wakeWordTimeout: 5,
			},
			audio: {},
			model: {},
			quality: {},
		};
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: {
				general: {
					recordingMode: "wakeword",
					wakeWord: "jarvis",
					wakeWordSensitivity: 0.5,
					wakeWordTimeout: 10,
				},
				audio: {},
				model: {},
				quality: {},
			},
		});
		await new Promise((r) => setTimeout(r, 600));
		expect(sttProcessState.restartCalled).toBe(1);
	});

	test("flipping the live-transcription display schedules a restart (realtimeKeyOrNull)", async () => {
		setupSettingsHandlers();
		sttProcessState.running = true;
		storeData = {
			general: { liveTranscriptionDisplay: "both" },
			audio: {},
			model: {},
			quality: {},
		};
		const win = createWindow(1, sentEvents);
		fireEvent("settings:save", win.webContents, {
			settings: {
				general: { liveTranscriptionDisplay: "none" },
				audio: {},
				model: {},
				quality: {},
			},
		});
		await new Promise((r) => setTimeout(r, 600));
		expect(sttProcessState.restartCalled).toBe(1);
	});
});

describe("broadcastRestartRequired (unmanaged server hint)", () => {
	test("sends STT_RESTART_REQUIRED to every alive window when restart fires unmanaged", async () => {
		setupSettingsHandlers({ isConnected: true } as unknown as Parameters<
			typeof setupSettingsHandlers
		>[0]);
		sttProcessState.running = false;
		const events1: Array<{ channel: string; payload: unknown }> = [];
		const events2: Array<{ channel: string; payload: unknown }> = [];
		const aliveA = createWindow(10, events1);
		const aliveB = createWindow(11, events2);
		allWindows.push(aliveA, aliveB);
		storeData.audio = { webrtcSensitivity: 0 };
		const sender = createWindow(1, sentEvents);
		fireEvent("settings:save", sender.webContents, {
			settings: { audio: { webrtcSensitivity: 1 } },
		});
		await new Promise((r) => setTimeout(r, 700));
		const restartEvents1 = events1.filter((e) => e.channel === "stt:restart-required");
		const restartEvents2 = events2.filter((e) => e.channel === "stt:restart-required");
		expect(restartEvents1.length).toBeGreaterThanOrEqual(1);
		expect(restartEvents2.length).toBeGreaterThanOrEqual(1);
	});

	test("skips destroyed windows so a hung renderer doesn't block others", async () => {
		setupSettingsHandlers({ isConnected: true } as unknown as Parameters<
			typeof setupSettingsHandlers
		>[0]);
		sttProcessState.running = false;
		const eventsDead: Array<{ channel: string; payload: unknown }> = [];
		const eventsAlive: Array<{ channel: string; payload: unknown }> = [];
		const dead = createWindow(20, eventsDead, { destroyed: true });
		const alive = createWindow(21, eventsAlive);
		allWindows.push(dead, alive);
		storeData.audio = { webrtcSensitivity: 0 };
		const sender = createWindow(1, sentEvents);
		fireEvent("settings:save", sender.webContents, {
			settings: { audio: { webrtcSensitivity: 1 } },
		});
		await new Promise((r) => setTimeout(r, 700));
		const restartDead = eventsDead.filter((e) => e.channel === "stt:restart-required");
		const restartAlive = eventsAlive.filter((e) => e.channel === "stt:restart-required");
		expect(restartDead.length).toBe(0);
		expect(restartAlive.length).toBeGreaterThanOrEqual(1);
	});

	test("swallows a single throwing renderer so siblings still receive the event", async () => {
		setupSettingsHandlers({ isConnected: true } as unknown as Parameters<
			typeof setupSettingsHandlers
		>[0]);
		sttProcessState.running = false;
		const eventsBad: Array<{ channel: string; payload: unknown }> = [];
		const eventsAlive: Array<{ channel: string; payload: unknown }> = [];
		const bad = createWindow(30, eventsBad, { throwOnSend: true });
		const alive = createWindow(31, eventsAlive);
		allWindows.push(bad, alive);
		storeData.audio = { webrtcSensitivity: 0 };
		const sender = createWindow(1, sentEvents);
		fireEvent("settings:save", sender.webContents, {
			settings: { audio: { webrtcSensitivity: 1 } },
		});
		await new Promise((r) => setTimeout(r, 700));
		const restartAlive = eventsAlive.filter((e) => e.channel === "stt:restart-required");
		expect(restartAlive.length).toBeGreaterThanOrEqual(1);
	});
});

describe("applyMainProcessSettingsPatch", () => {
	test("writes the patch to the store and broadcasts settings:changed to all windows", () => {
		setupSettingsHandlers();
		const events1: Array<{ channel: string; payload: unknown }> = [];
		const events2: Array<{ channel: string; payload: unknown }> = [];
		allWindows.push(createWindow(40, events1), createWindow(41, events2));
		applyMainProcessSettingsPatch({ "general.recordingMode": "ptt" });
		expect((storeData.general as Record<string, unknown>).recordingMode).toBe("ptt");
		expect(events1.find((e) => e.channel === "settings:changed")).toBeTruthy();
		expect(events2.find((e) => e.channel === "settings:changed")).toBeTruthy();
	});

	test("skips destroyed windows during settings:changed broadcast", () => {
		setupSettingsHandlers();
		const eventsDead: Array<{ channel: string; payload: unknown }> = [];
		const eventsAlive: Array<{ channel: string; payload: unknown }> = [];
		allWindows.push(
			createWindow(50, eventsDead, { destroyed: true }),
			createWindow(51, eventsAlive)
		);
		applyMainProcessSettingsPatch({ "general.recordingMode": "toggle" });
		expect(eventsDead.find((e) => e.channel === "settings:changed")).toBeFalsy();
		expect(eventsAlive.find((e) => e.channel === "settings:changed")).toBeTruthy();
	});

	test("triggers a restart when the patch changes a startup-only key", async () => {
		setupSettingsHandlers();
		sttProcessState.running = true;
		storeData.audio = { webrtcSensitivity: 0 };
		applyMainProcessSettingsPatch({ "audio.webrtcSensitivity": 2 });
		await new Promise((r) => setTimeout(r, 700));
		expect(sttProcessState.restartCalled).toBe(1);
	});
});

describe("readDisplayMode (helper)", () => {
	const { readDisplayMode } = __settings_test_helpers__;

	test("accepts 'none'", () => {
		expect(readDisplayMode("none")).toBe("none");
	});

	test("accepts 'in-app'", () => {
		expect(readDisplayMode("in-app")).toBe("in-app");
	});

	test("accepts 'in-pill'", () => {
		expect(readDisplayMode("in-pill")).toBe("in-pill");
	});

	test("accepts 'both'", () => {
		expect(readDisplayMode("both")).toBe("both");
	});

	test("falls back to 'both' on unknown string", () => {
		expect(readDisplayMode("popup")).toBe("both");
	});

	test("falls back to 'both' on undefined / null / non-string", () => {
		expect(readDisplayMode(undefined)).toBe("both");
		expect(readDisplayMode(null)).toBe("both");
		expect(readDisplayMode(42)).toBe("both");
		expect(readDisplayMode({})).toBe("both");
	});
});

describe("performRestart (helper)", () => {
	const { performRestart, setShuttingDownForTest, setSttClientRefForTest } =
		__settings_test_helpers__;

	test("no-op when isShuttingDown is true", () => {
		setupSettingsHandlers();
		setShuttingDownForTest(true);
		sttProcessState.running = true;
		try {
			performRestart("some.key");
			expect(sttProcessState.restartCalled).toBe(0);
		} finally {
			setShuttingDownForTest(false);
		}
	});

	test("calls restartSttProcess when STT process is managed", () => {
		setupSettingsHandlers();
		sttProcessState.running = true;
		performRestart("audio.webrtcSensitivity");
		expect(sttProcessState.restartCalled).toBe(1);
	});

	test("broadcasts STT_RESTART_REQUIRED to all windows when unmanaged", () => {
		setupSettingsHandlers({ isConnected: true } as unknown as Parameters<
			typeof setupSettingsHandlers
		>[0]);
		sttProcessState.running = false;
		const eventsA: Array<{ channel: string; payload: unknown }> = [];
		const eventsB: Array<{ channel: string; payload: unknown }> = [];
		allWindows.push(createWindow(601, eventsA), createWindow(602, eventsB));
		performRestart("model.realtimeModel");
		const aHit = eventsA.find((e) => e.channel === "stt:restart-required");
		const bHit = eventsB.find((e) => e.channel === "stt:restart-required");
		expect(aHit).toBeTruthy();
		expect(bHit).toBeTruthy();
		expect((aHit?.payload as { setting: string }).setting).toBe("model.realtimeModel");
		expect(sttProcessState.restartCalled).toBe(0);
	});

	test("falls back to 'a setting' when changedKey is null in unmanaged branch", () => {
		setupSettingsHandlers({ isConnected: true } as unknown as Parameters<
			typeof setupSettingsHandlers
		>[0]);
		sttProcessState.running = false;
		const events: Array<{ channel: string; payload: unknown }> = [];
		allWindows.push(createWindow(610, events));
		performRestart(null);
		const hit = events.find((e) => e.channel === "stt:restart-required");
		expect(hit).toBeTruthy();
		expect((hit?.payload as { setting: string }).setting).toBe("a setting");
		setSttClientRefForTest(null);
	});
});

describe("shouldScheduleRestart (helper)", () => {
	const { shouldScheduleRestart, hasRestartRelevantChange, setShuttingDownForTest } =
		__settings_test_helpers__;

	test("returns false when nothing restart-relevant changed", () => {
		setupSettingsHandlers();
		sttProcessState.running = true;
		const old = { general: { recordingMode: "ptt" }, audio: {}, model: {}, quality: {} };
		const next = { general: { recordingMode: "ptt" }, audio: {}, model: {}, quality: {} };
		expect(shouldScheduleRestart(old, next)).toBe(false);
	});

	test("returns false when relevant change exists but server is shutting down", () => {
		setupSettingsHandlers();
		sttProcessState.running = true;
		const old = { audio: { webrtcSensitivity: 1 } };
		const next = { audio: { webrtcSensitivity: 2 } };
		setShuttingDownForTest(true);
		try {
			expect(shouldScheduleRestart(old, next)).toBe(false);
		} finally {
			setShuttingDownForTest(false);
		}
	});

	test("returns false when relevant change exists but no server to restart", () => {
		setupSettingsHandlers();
		sttProcessState.running = false;
		const old = { audio: { webrtcSensitivity: 1 } };
		const next = { audio: { webrtcSensitivity: 2 } };
		expect(shouldScheduleRestart(old, next)).toBe(false);
	});

	test("returns true when startup key changed AND server is running", () => {
		setupSettingsHandlers();
		sttProcessState.running = true;
		const old = { audio: { webrtcSensitivity: 1 } };
		const next = { audio: { webrtcSensitivity: 2 } };
		expect(shouldScheduleRestart(old, next)).toBe(true);
	});

	test("returns true when wake-word config changed AND server is running", () => {
		setupSettingsHandlers();
		sttProcessState.running = true;
		const old = { general: { recordingMode: "wakeword", wakeWord: "jarvis" } };
		const next = { general: { recordingMode: "wakeword", wakeWord: "alexa" } };
		expect(shouldScheduleRestart(old, next)).toBe(true);
	});

	test("returns true when realtime-display flips AND server is running", () => {
		setupSettingsHandlers();
		sttProcessState.running = true;
		const old = { general: { liveTranscriptionDisplay: "both" } };
		const next = { general: { liveTranscriptionDisplay: "none" } };
		expect(shouldScheduleRestart(old, next)).toBe(true);
	});

	test("hasRestartRelevantChange covers all three OR branches independently", () => {
		// Startup-only branch
		expect(
			hasRestartRelevantChange(
				{ audio: { webrtcSensitivity: 1 } },
				{ audio: { webrtcSensitivity: 2 } }
			)
		).toBe(true);
		// Wake-word branch
		expect(
			hasRestartRelevantChange(
				{ general: { recordingMode: "wakeword", wakeWord: "a" } },
				{ general: { recordingMode: "wakeword", wakeWord: "b" } }
			)
		).toBe(true);
		// Realtime-display branch
		expect(
			hasRestartRelevantChange(
				{ general: { liveTranscriptionDisplay: "both" } },
				{ general: { liveTranscriptionDisplay: "none" } }
			)
		).toBe(true);
		// None
		expect(hasRestartRelevantChange({}, {})).toBe(false);
	});
});

describe("preserveMainOwnedGeneral (helper)", () => {
	const { preserveMainOwnedGeneral, mergeMainOwnedFields } = __settings_test_helpers__;

	test("returns value unchanged when value is not a plain object", () => {
		expect(preserveMainOwnedGeneral(undefined)).toBeUndefined();
		expect(preserveMainOwnedGeneral(null)).toBeNull();
		expect(preserveMainOwnedGeneral("string")).toBe("string");
		expect(preserveMainOwnedGeneral([1, 2, 3])).toEqual([1, 2, 3]);
	});

	test("returns value unchanged when existing store 'general' is not a plain object", () => {
		storeData.general = null;
		const input = { recordingMode: "ptt", onboarded: false };
		expect(preserveMainOwnedGeneral(input)).toEqual(input);
	});

	test("overlays main-owned keys from store onto patch", () => {
		storeData.general = {
			recordingMode: "vad",
			onboarded: true,
			onboardedAt: "2025-01-01",
			onboardedTrack: "default",
		};
		const renderer = { recordingMode: "ptt", onboarded: false };
		const out = preserveMainOwnedGeneral(renderer) as Record<string, unknown>;
		// Renderer-supplied non-main keys win
		expect(out.recordingMode).toBe("ptt");
		// Main-owned keys are preserved from the store
		expect(out.onboarded).toBe(true);
		expect(out.onboardedAt).toBe("2025-01-01");
		expect(out.onboardedTrack).toBe("default");
	});

	test("mergeMainOwnedFields copies the 3 main-owned keys from existing into the patch", () => {
		const merged = mergeMainOwnedFields(
			{ recordingMode: "ptt", customField: "x" },
			{ onboarded: true, onboardedAt: "t", onboardedTrack: "stable", noise: 1 }
		);
		expect(merged.recordingMode).toBe("ptt");
		expect(merged.customField).toBe("x");
		expect(merged.onboarded).toBe(true);
		expect(merged.onboardedAt).toBe("t");
		expect(merged.onboardedTrack).toBe("stable");
		// Not a main-owned key — must NOT leak through
		expect(merged.noise).toBeUndefined();
	});
});

describe("applySettings (helper)", () => {
	const { applySettings, applySettingEntry } = __settings_test_helpers__;

	test("writes every allowed top-level section to the store", () => {
		storeData = { general: {}, model: {}, audio: {}, quality: {} };
		applySettings({
			general: { recordingMode: "ptt" },
			audio: { webrtcSensitivity: 7 },
			model: { model: "tiny" },
		});
		expect((storeData.general as Record<string, unknown>).recordingMode).toBe("ptt");
		expect((storeData.audio as Record<string, unknown>).webrtcSensitivity).toBe(7);
		expect((storeData.model as Record<string, unknown>).model).toBe("tiny");
	});

	test("silently drops keys not in the allowlist", () => {
		storeData = {};
		applySettings({ __evil: { x: 1 }, also_not_allowed: "y" });
		expect(storeData.__evil).toBeUndefined();
		expect(storeData.also_not_allowed).toBeUndefined();
	});

	test("encrypts secret fields before persisting", () => {
		storeData = {};
		applySettings({ llm: { openrouterApiKey: "sk-or-secret" } });
		const persisted = (storeData.llm as { openrouterApiKey: string }).openrouterApiKey;
		expect(persisted.startsWith("enc:v1:")).toBe(true);
		expect(persisted).not.toBe("sk-or-secret");
	});

	test("preserves main-owned general keys (onboarded family) on round-trip", () => {
		storeData.general = { onboarded: true, onboardedAt: "2025-01-01", onboardedTrack: "stable" };
		applySettings({ general: { recordingMode: "ptt", onboarded: false } });
		const persisted = storeData.general as Record<string, unknown>;
		// Renderer-supplied non-main keys win
		expect(persisted.recordingMode).toBe("ptt");
		// Main-owned keys survive the renderer's stale `false`
		expect(persisted.onboarded).toBe(true);
		expect(persisted.onboardedAt).toBe("2025-01-01");
		expect(persisted.onboardedTrack).toBe("stable");
	});

	test("applySettingEntry early-returns for disallowed key", () => {
		storeData = {};
		applySettingEntry("__not_in_schema", { evil: true });
		expect(storeData.__not_in_schema).toBeUndefined();
	});

	test("applySettingEntry routes 'general' through preserveMainOwnedGeneral", () => {
		storeData.general = { onboarded: true, onboardedAt: "t", onboardedTrack: "k" };
		applySettingEntry("general", { recordingMode: "vad", onboarded: false });
		const persisted = storeData.general as Record<string, unknown>;
		expect(persisted.recordingMode).toBe("vad");
		expect(persisted.onboarded).toBe(true);
	});

	test("applySettingEntry writes non-'general' allowed keys directly", () => {
		storeData = {};
		applySettingEntry("audio", { webrtcSensitivity: 9 });
		expect((storeData.audio as Record<string, unknown>).webrtcSensitivity).toBe(9);
	});
});
