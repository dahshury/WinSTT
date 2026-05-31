import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";
import { IPC } from "../../src/shared/api/ipc-channels";

// tts.ts (transitively via ../lib/debug-log) does `import { app } from "electron"`
// at module load. Without a shim the real electron entrypoint is resolved and
// throws "Export named 'app' not found". Spread the full default mock and only
// override BrowserWindow.getAllWindows so the broadcast path fans into our
// in-memory window list.
const base = electronMock();
const handlers = base.ipcMain._handlers;
const listeners = base.ipcMain._listeners;

// In-memory window registry the broadcast path reads via getAllWindows().
interface SentEvent {
	channel: string;
	payload: unknown;
}
const createWindow = (
	id: number,
	sent: SentEvent[],
	options: { destroyed?: boolean; throwOnSend?: boolean } = {}
) => ({
	webContents: {
		id,
		send: (channel: string, payload: unknown) => {
			if (options.throwOnSend) {
				throw new Error("renderer-hung");
			}
			sent.push({ channel, payload });
		},
	},
	isDestroyed: () => Boolean(options.destroyed),
});
const allWindows: ReturnType<typeof createWindow>[] = [];

mock.module("electron", () => ({
	...base,
	BrowserWindow: {
		...base.BrowserWindow,
		getAllWindows: () => allWindows,
	},
}));

// ── store shim ────────────────────────────────────────────────────────
// A focused store mock: a flat dot-path map plus an onDidChange registry.
// Like production electron-store (conf), a write to a nested key fans the
// change UP to its ancestor keys and dispatches their listeners SYNCHRONOUSLY
// inside set() — so `store.set("tts.enabled", …)` fires the `onDidChange("tts")`
// listener the code-under-test wires up, mid-`set`. Replicating that timing is
// what lets the boot-path regression test below catch a listener that runs
// while stale state (lastLocalActive) hasn't been re-aligned yet.
let storeData: Record<string, unknown> = {};
const storeListeners = new Map<string, Array<(value: unknown, prev: unknown) => void>>();

function fireStoreKey(key: string, value: unknown, prev: unknown): void {
	for (const cb of storeListeners.get(key) ?? []) {
		cb(value, prev);
	}
}

function setStore(key: string, value: unknown): void {
	const prev = storeData[key];
	storeData[key] = value;
	fireStoreKey(key, value, prev);
	// Fan up to every ancestor key (e.g. "tts.enabled" → "tts"), matching conf.
	// Production listeners ignore the (value, prev) args and re-read from the
	// store, so the (flat-map) ancestor value is a sufficient stand-in.
	const segments = key.split(".");
	for (let depth = segments.length - 1; depth > 0; depth--) {
		const ancestor = segments.slice(0, depth).join(".");
		fireStoreKey(ancestor, storeData[ancestor], storeData[ancestor]);
	}
}

const storeSetCalls: Array<{ key: string; value: unknown }> = [];

mock.module("../lib/store", () => ({
	store: {
		get store() {
			return storeData;
		},
		get: (key: string) => storeData[key],
		set: (key: string, value: unknown) => {
			storeSetCalls.push({ key, value });
			setStore(key, value);
		},
		onDidChange: (key: string, cb: (value: unknown, prev: unknown) => void) => {
			const list = storeListeners.get(key) ?? [];
			list.push(cb);
			storeListeners.set(key, list);
			return () => {
				storeListeners.set(
					key,
					(storeListeners.get(key) ?? []).filter((x) => x !== cb)
				);
			};
		},
	},
	getStoreValue: (key: string) => storeData[key],
}));

// ── selection-capture shim ──────────────────────────────────────────────
interface Selection {
	originalClipboard: string | null;
	source: string;
	text: string;
}
const selectionStub: { next: Selection } = {
	next: { text: "hello world", source: "uia", originalClipboard: null },
};
let captureSelectionCalls = 0;
mock.module("../lib/selection-capture", () => ({
	captureSelection: () => {
		captureSelectionCalls++;
		return Promise.resolve(selectionStub.next);
	},
}));

// ── SttClient stub ──────────────────────────────────────────────────────
type EmitterCb = (...args: unknown[]) => void;
class FakeSttClient {
	isConnected = true;
	emitters = new Map<string, EmitterCb[]>();
	calls: Array<{ method: string; arg?: unknown }> = [];
	// Behaviour knobs the tests flip.
	estimateResult: unknown = { already_installed: true };
	estimateThrows = false;
	voicesResult: unknown = {
		voices: [{ id: "af_heart", label: "Heart", language: "en-us", gender: "f" }],
		languages: [{ code: "en-us", label: "English" }],
	};
	voicesThrows = false;
	initThrows = false;
	synthesizeThrows = false;
	cancelThrows = false;
	installPauseThrows = false;
	installResumeThrows = false;
	installCancelThrows = false;

	on(event: string, cb: EmitterCb): void {
		const list = this.emitters.get(event) ?? [];
		list.push(cb);
		this.emitters.set(event, list);
	}
	off(event: string, cb: EmitterCb): void {
		this.emitters.set(
			event,
			(this.emitters.get(event) ?? []).filter((x) => x !== cb)
		);
	}
	emit(event: string, ...args: unknown[]): void {
		for (const cb of [...(this.emitters.get(event) ?? [])]) {
			cb(...args);
		}
	}

	initTts(): void {
		this.calls.push({ method: "initTts" });
		if (this.initThrows) {
			throw new Error("init boom");
		}
	}
	shutdownTts(): void {
		this.calls.push({ method: "shutdownTts" });
	}
	ttsSynthesize(payload: unknown): void {
		this.calls.push({ method: "ttsSynthesize", arg: payload });
		if (this.synthesizeThrows) {
			throw new Error("synth boom");
		}
	}
	ttsCancel(requestId?: string): void {
		this.calls.push({ method: "ttsCancel", arg: requestId });
		if (this.cancelThrows) {
			throw new Error("cancel boom");
		}
	}
	ttsInstallPause(): void {
		this.calls.push({ method: "ttsInstallPause" });
		if (this.installPauseThrows) {
			throw new Error("pause boom");
		}
	}
	ttsInstallResume(): void {
		this.calls.push({ method: "ttsInstallResume" });
		if (this.installResumeThrows) {
			throw new Error("resume boom");
		}
	}
	ttsInstallCancel(): void {
		this.calls.push({ method: "ttsInstallCancel" });
		if (this.installCancelThrows) {
			throw new Error("install-cancel boom");
		}
	}
	listTtsVoices(): Promise<unknown> {
		this.calls.push({ method: "listTtsVoices" });
		if (this.voicesThrows) {
			return Promise.reject(new Error("voices boom"));
		}
		return Promise.resolve(this.voicesResult);
	}
	ttsDownloadEstimate(): Promise<unknown> {
		this.calls.push({ method: "ttsDownloadEstimate" });
		if (this.estimateThrows) {
			return Promise.reject(new Error("estimate boom"));
		}
		return Promise.resolve(this.estimateResult);
	}

	countCalls(method: string): number {
		return this.calls.filter((c) => c.method === method).length;
	}
	lastArg(method: string): unknown {
		const matching = this.calls.filter((c) => c.method === method);
		return matching.at(-1)?.arg;
	}
}

const { setupTts, triggerTtsCancelAll } = await import("./tts");

// Contained boundary cast — the production setupTts wants a real SttClient;
// our fake exposes the exact subset it touches.
const asSttClient = (c: FakeSttClient) => c as unknown as Parameters<typeof setupTts>[0];

// dbg() lines land in the global buffer installed by test/preload.ts.
const logLines = (globalThis as unknown as { __testLogLines: string[] }).__testLogLines;
function logContains(needle: string): boolean {
	return logLines.some((line) => line.includes(needle));
}

const fakeEvent = {} as Electron.IpcMainInvokeEvent;
const fakeSendEvent = {} as Electron.IpcMainEvent;

let cleanup: (() => void) | null = null;
let client: FakeSttClient;

function setup(opts: { enabled?: boolean; connected?: boolean } = {}): void {
	storeData = {
		"tts.enabled": opts.enabled ?? false,
		"tts.voice": undefined,
		"tts.lang": undefined,
		"tts.speed": undefined,
	};
	client = new FakeSttClient();
	if (opts.connected === false) {
		client.isConnected = false;
	}
	cleanup = setupTts(asSttClient(client));
}

// Drain the microtask queue so the void-returning fireWarmup()'s async
// maybeWarmup() (and any awaited estimate probe) settle before assertions.
function flushMicrotasks(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}

function eventsFor(channel: string, sent: SentEvent[]): SentEvent[] {
	return sent.filter((e) => e.channel === channel);
}

beforeEach(() => {
	storeData = {};
	storeListeners.clear();
	storeSetCalls.length = 0;
	captureSelectionCalls = 0;
	selectionStub.next = { text: "hello world", source: "uia", originalClipboard: null };
	allWindows.length = 0;
	handlers.clear();
	listeners.clear();
	logLines.length = 0;
});

afterEach(() => {
	cleanup?.();
	cleanup = null;
});

describe("setupTts registration & teardown", () => {
	test("registers every TTS handler and listener channel", () => {
		setup();
		expect(handlers.has(IPC.TTS_SPEAK)).toBe(true);
		expect(handlers.has(IPC.TTS_SPEAK_SELECTION)).toBe(true);
		expect(handlers.has(IPC.TTS_INIT)).toBe(true);
		expect(handlers.has(IPC.TTS_LIST_VOICES)).toBe(true);
		expect(handlers.has(IPC.TTS_DOWNLOAD_ESTIMATE)).toBe(true);
		expect(listeners.has(IPC.TTS_CANCEL)).toBe(true);
		expect(listeners.has(IPC.TTS_REPORT_PLAYBACK_STARTED)).toBe(true);
		expect(listeners.has(IPC.TTS_REPORT_PLAYBACK_ENDED)).toBe(true);
		expect(listeners.has(IPC.TTS_INSTALL_PAUSE)).toBe(true);
		expect(listeners.has(IPC.TTS_INSTALL_RESUME)).toBe(true);
		expect(listeners.has(IPC.TTS_INSTALL_CANCEL)).toBe(true);
	});

	test("subscribes to the SttClient data-binary, data-event, connected channels", () => {
		setup();
		expect(client.emitters.get("data-binary")?.length).toBe(1);
		expect(client.emitters.get("data-event")?.length).toBe(1);
		expect(client.emitters.get("connected")?.length).toBe(1);
	});

	test("teardown removes handlers, listeners, and SttClient subscriptions", () => {
		setup();
		cleanup?.();
		cleanup = null;
		expect(handlers.has(IPC.TTS_SPEAK)).toBe(false);
		expect(handlers.has(IPC.TTS_INIT)).toBe(false);
		expect(listeners.has(IPC.TTS_CANCEL)).toBe(false);
		expect(listeners.has(IPC.TTS_INSTALL_PAUSE)).toBe(false);
		expect(client.emitters.get("data-binary")?.length ?? 0).toBe(0);
		expect(client.emitters.get("data-event")?.length ?? 0).toBe(0);
		expect(client.emitters.get("connected")?.length ?? 0).toBe(0);
	});

	test("teardown unsubscribes the store onDidChange listener", () => {
		setup();
		expect(storeListeners.get("tts")?.length).toBe(1);
		cleanup?.();
		cleanup = null;
		expect(storeListeners.get("tts")?.length ?? 0).toBe(0);
	});
});

describe("handleSpeak (TTS_SPEAK)", () => {
	test("rejects a non-object payload via ValidationError", async () => {
		setup({ enabled: true });
		const handler = handlers.get(IPC.TTS_SPEAK);
		expect(handler).toBeDefined();
		// handleSpeak validates synchronously (assertSpeakPayload) BEFORE the
		// Promise.resolve, so a bad payload throws synchronously despite the
		// declared Promise return type — Electron turns that into a rejected
		// invoke at runtime, but the raw callback throws.
		expect(() => handler?.(fakeEvent, 42)).toThrow("TTS speak payload must be an object");
	});

	test("rejects a payload with a missing/empty text field", () => {
		setup({ enabled: true });
		const handler = handlers.get(IPC.TTS_SPEAK);
		expect(() => handler?.(fakeEvent, { text: "" })).toThrow("TTS speak payload.text is required");
		expect(() => handler?.(fakeEvent, {})).toThrow("TTS speak payload.text is required");
	});

	test("throws when TTS is disabled even with valid text", () => {
		setup({ enabled: false });
		const handler = handlers.get(IPC.TTS_SPEAK);
		expect(() => handler?.(fakeEvent, { text: "hi" })).toThrow("TTS is disabled in settings");
		expect(client.countCalls("ttsSynthesize")).toBe(0);
	});

	test("dispatches synthesis, returns the supplied requestId, and broadcasts TTS_STARTED", async () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		const handler = handlers.get(IPC.TTS_SPEAK);
		const result = (await handler?.(fakeEvent, { text: "speak me", requestId: "req-1" })) as {
			requestId: string;
		};
		expect(result.requestId).toBe("req-1");
		expect(client.countCalls("ttsSynthesize")).toBe(1);
		const arg = client.lastArg("ttsSynthesize") as Record<string, unknown>;
		expect(arg.requestId).toBe("req-1");
		expect(arg.text).toBe("speak me");
		const started = eventsFor(IPC.TTS_STARTED, sent);
		expect(started.length).toBe(1);
		expect((started[0]?.payload as { requestId: string }).requestId).toBe("req-1");
	});

	test("generates a UUID requestId when none supplied", async () => {
		setup({ enabled: true });
		const handler = handlers.get(IPC.TTS_SPEAK);
		const result = (await handler?.(fakeEvent, { text: "auto id" })) as { requestId: string };
		expect(typeof result.requestId).toBe("string");
		expect(result.requestId.length).toBeGreaterThan(0);
		expect((client.lastArg("ttsSynthesize") as { requestId: string }).requestId).toBe(
			result.requestId
		);
	});

	test("applies store-backed voice/lang/speed and clamps speed into [0.5, 2.0]", async () => {
		setup({ enabled: true });
		storeData["tts.voice"] = "bf_alice";
		storeData["tts.lang"] = "en-gb";
		storeData["tts.speed"] = 5; // out of range — must clamp to 2.0
		const handler = handlers.get(IPC.TTS_SPEAK);
		await handler?.(fakeEvent, { text: "x" });
		const arg = client.lastArg("ttsSynthesize") as Record<string, unknown>;
		expect(arg.voice).toBe("bf_alice");
		expect(arg.lang).toBe("en-gb");
		expect(arg.speed).toBe(2.0);
	});

	test("payload overrides win over store and defaults fill missing fields", async () => {
		setup({ enabled: true });
		storeData["tts.voice"] = "store_voice";
		const handler = handlers.get(IPC.TTS_SPEAK);
		await handler?.(fakeEvent, { text: "x", voice: "override_voice", speed: 0.1 });
		const arg = client.lastArg("ttsSynthesize") as Record<string, unknown>;
		// payload override wins over store value
		expect(arg.voice).toBe("override_voice");
		// store + payload both empty → defaults
		expect(arg.lang).toBe("en-us");
		// speed 0.1 clamps up to the 0.5 floor
		expect(arg.speed).toBe(0.5);
	});
});

describe("handleSpeakSelection (TTS_SPEAK_SELECTION)", () => {
	test("throws when TTS is disabled and never captures the selection", async () => {
		setup({ enabled: false });
		const handler = handlers.get(IPC.TTS_SPEAK_SELECTION);
		await expect(handler?.(fakeEvent, {})).rejects.toThrow("TTS is disabled in settings");
		expect(captureSelectionCalls).toBe(0);
	});

	test("captures the selection, dispatches synthesis, and returns text+source", async () => {
		setup({ enabled: true });
		selectionStub.next = { text: "selected text", source: "uia", originalClipboard: null };
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		const handler = handlers.get(IPC.TTS_SPEAK_SELECTION);
		const result = (await handler?.(fakeEvent, { requestId: "sel-1" })) as {
			requestId: string;
			text: string;
			source: string;
		};
		expect(captureSelectionCalls).toBe(1);
		expect(result.requestId).toBe("sel-1");
		expect(result.text).toBe("selected text");
		expect(result.source).toBe("uia");
		expect((client.lastArg("ttsSynthesize") as { text: string }).text).toBe("selected text");
		expect(eventsFor(IPC.TTS_STARTED, sent).length).toBe(1);
	});

	test("generates a UUID requestId when none supplied in selection payload", async () => {
		setup({ enabled: true });
		const handler = handlers.get(IPC.TTS_SPEAK_SELECTION);
		const result = (await handler?.(fakeEvent, undefined)) as { requestId: string };
		expect(result.requestId.length).toBeGreaterThan(0);
	});

	test("empty selection broadcasts TTS_FAILED and returns empty requestId without synthesizing", async () => {
		setup({ enabled: true });
		selectionStub.next = { text: "   ", source: "clipboard", originalClipboard: null };
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		const handler = handlers.get(IPC.TTS_SPEAK_SELECTION);
		const result = (await handler?.(fakeEvent, { requestId: "sel-2" })) as {
			requestId: string;
			text: string;
			source: string;
		};
		expect(result.requestId).toBe("");
		expect(result.text).toBe("");
		expect(result.source).toBe("clipboard");
		expect(client.countCalls("ttsSynthesize")).toBe(0);
		const failed = eventsFor(IPC.TTS_FAILED, sent);
		expect(failed.length).toBe(1);
		expect((failed[0]?.payload as { reason: string }).reason).toBe("No text selected");
		expect((failed[0]?.payload as { requestId: string }).requestId).toBe("sel-2");
	});

	test("empty selection with no requestId broadcasts TTS_FAILED with empty requestId", async () => {
		setup({ enabled: true });
		selectionStub.next = { text: "", source: "empty", originalClipboard: null };
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		const handler = handlers.get(IPC.TTS_SPEAK_SELECTION);
		await handler?.(fakeEvent, {});
		const failed = eventsFor(IPC.TTS_FAILED, sent);
		expect((failed[0]?.payload as { requestId: string }).requestId).toBe("");
	});
});

describe("handleInit (TTS_INIT)", () => {
	test("returns { ready: true } and dispatches initTts on success", async () => {
		setup({ enabled: false });
		const handler = handlers.get(IPC.TTS_INIT);
		const before = client.countCalls("initTts");
		const result = await handler?.(fakeEvent);
		expect(result).toEqual({ ready: true });
		expect(client.countCalls("initTts")).toBe(before + 1);
	});

	test("returns { ready: false } and logs when initTts throws", async () => {
		setup({ enabled: false });
		client.initThrows = true;
		const handler = handlers.get(IPC.TTS_INIT);
		const result = await handler?.(fakeEvent);
		expect(result).toEqual({ ready: false });
		expect(logContains("initTts failed")).toBe(true);
	});
});

describe("handleListVoices (TTS_LIST_VOICES)", () => {
	test("returns the parsed, validated catalog from the server", async () => {
		setup({ enabled: false });
		const handler = handlers.get(IPC.TTS_LIST_VOICES);
		const result = (await handler?.(fakeEvent)) as {
			voices: unknown[];
			languages: unknown[];
		};
		expect(result.voices.length).toBe(1);
		expect(result.languages.length).toBe(1);
		expect((result.voices[0] as { id: string }).id).toBe("af_heart");
	});

	test("caches the catalog — a second call does not re-hit the server", async () => {
		setup({ enabled: false });
		const handler = handlers.get(IPC.TTS_LIST_VOICES);
		await handler?.(fakeEvent);
		await handler?.(fakeEvent);
		expect(client.countCalls("listTtsVoices")).toBe(1);
	});

	test("returns an empty catalog (without caching it) when the schema fails validation", async () => {
		setup({ enabled: false });
		client.voicesResult = { voices: "not-an-array" };
		const handler = handlers.get(IPC.TTS_LIST_VOICES);
		const result = (await handler?.(fakeEvent)) as { voices: unknown[]; languages: unknown[] };
		expect(result.voices).toEqual([]);
		expect(result.languages).toEqual([]);
		// Not cached → a retry re-hits the server (and would succeed if it recovers).
		client.voicesResult = {
			voices: [{ id: "x", label: "X", language: "en-us", gender: "m" }],
			languages: [],
		};
		const second = (await handler?.(fakeEvent)) as { voices: unknown[] };
		expect(second.voices.length).toBe(1);
		expect(client.countCalls("listTtsVoices")).toBe(2);
	});

	test("returns an empty catalog and logs when the server call rejects", async () => {
		setup({ enabled: false });
		client.voicesThrows = true;
		const handler = handlers.get(IPC.TTS_LIST_VOICES);
		const result = (await handler?.(fakeEvent)) as { voices: unknown[]; languages: unknown[] };
		expect(result.voices).toEqual([]);
		expect(result.languages).toEqual([]);
		expect(logContains("listTtsVoices failed")).toBe(true);
	});
});

describe("handleDownloadEstimate (TTS_DOWNLOAD_ESTIMATE)", () => {
	test("maps a well-formed server estimate into the renderer shape", async () => {
		setup({ enabled: false });
		client.estimateResult = {
			total_bytes: 1234,
			already_installed: false,
			components: [
				{ id: "engine", label: "Engine pack", bytes: 1000, installed: false },
				{ id: "voice", label: "Voice model", bytes: 234, installed: true },
			],
		};
		const handler = handlers.get(IPC.TTS_DOWNLOAD_ESTIMATE);
		const result = (await handler?.(fakeEvent)) as {
			totalBytes: number;
			alreadyInstalled: boolean;
			unavailable?: boolean;
			components: Array<{ id: string; label: string; bytes: number; installed: boolean }>;
		};
		expect(result.totalBytes).toBe(1234);
		expect(result.alreadyInstalled).toBe(false);
		expect(result.unavailable).toBeUndefined();
		expect(result.components.length).toBe(2);
		expect(result.components[0]).toEqual({
			id: "engine",
			label: "Engine pack",
			bytes: 1000,
			installed: false,
		});
		expect(result.components[1]?.installed).toBe(true);
	});

	test("alreadyInstalled flag flows through when the server reports true", async () => {
		setup({ enabled: false });
		client.estimateResult = { total_bytes: 0, already_installed: true, components: [] };
		const handler = handlers.get(IPC.TTS_DOWNLOAD_ESTIMATE);
		const result = (await handler?.(fakeEvent)) as { alreadyInstalled: boolean };
		expect(result.alreadyInstalled).toBe(true);
	});

	test("drops malformed component entries and treats missing 'installed' as false", async () => {
		setup({ enabled: false });
		client.estimateResult = {
			total_bytes: 50,
			components: [
				{ id: "ok", label: "Good", bytes: 50 }, // installed omitted → false
				{ id: "bad-no-bytes", label: "no bytes" }, // dropped (missing bytes)
				{ label: "no id", bytes: 1 }, // dropped (missing id)
				"not-an-object", // dropped
			],
		};
		const handler = handlers.get(IPC.TTS_DOWNLOAD_ESTIMATE);
		const result = (await handler?.(fakeEvent)) as {
			components: Array<{ id: string; installed: boolean }>;
		};
		expect(result.components.length).toBe(1);
		expect(result.components[0]?.id).toBe("ok");
		expect(result.components[0]?.installed).toBe(false);
	});

	test("non-array components yields an empty components list", async () => {
		setup({ enabled: false });
		client.estimateResult = { total_bytes: 99, components: "nope" };
		const handler = handlers.get(IPC.TTS_DOWNLOAD_ESTIMATE);
		const result = (await handler?.(fakeEvent)) as {
			totalBytes: number;
			components: unknown[];
		};
		expect(result.totalBytes).toBe(99);
		expect(result.components).toEqual([]);
	});

	test("returns the unavailable sentinel when total_bytes is missing/non-numeric", async () => {
		setup({ enabled: false });
		client.estimateResult = { components: [] }; // no total_bytes
		const handler = handlers.get(IPC.TTS_DOWNLOAD_ESTIMATE);
		const result = (await handler?.(fakeEvent)) as {
			totalBytes: number;
			components: unknown[];
			alreadyInstalled: boolean;
			unavailable?: boolean;
		};
		expect(result).toEqual({
			totalBytes: 0,
			components: [],
			alreadyInstalled: false,
			unavailable: true,
		});
	});

	test("returns the unavailable sentinel and logs when the probe rejects", async () => {
		setup({ enabled: false });
		client.estimateThrows = true;
		const handler = handlers.get(IPC.TTS_DOWNLOAD_ESTIMATE);
		const result = (await handler?.(fakeEvent)) as { unavailable?: boolean };
		expect(result.unavailable).toBe(true);
		expect(logContains("ttsDownloadEstimate failed")).toBe(true);
	});
});

describe("handleCancel (TTS_CANCEL) + cancel-all", () => {
	function fireCancel(payload?: unknown): void {
		for (const cb of listeners.get(IPC.TTS_CANCEL) ?? []) {
			cb(fakeSendEvent, payload);
		}
	}

	test("scoped cancel sends ttsCancel(requestId) and broadcasts a single cancelled TTS_COMPLETED", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		fireCancel({ requestId: "abc" });
		expect(client.lastArg("ttsCancel")).toBe("abc");
		const completed = eventsFor(IPC.TTS_COMPLETED, sent);
		expect(completed.length).toBe(1);
		expect(completed[0]?.payload).toEqual({ requestId: "abc", cancelled: true });
	});

	test("cancel-all (no requestId) broadcasts cancelled for every active id plus a wildcard", async () => {
		setup({ enabled: true });
		// Start two requests so two ids are active.
		const speak = handlers.get(IPC.TTS_SPEAK);
		await speak?.(fakeEvent, { text: "a", requestId: "id-a" });
		await speak?.(fakeEvent, { text: "b", requestId: "id-b" });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		fireCancel({}); // no requestId → cancel-all
		expect(client.lastArg("ttsCancel")).toBeUndefined();
		const completed = eventsFor(IPC.TTS_COMPLETED, sent);
		const ids = completed.map((e) => (e.payload as { requestId: string }).requestId);
		// Two tracked ids + the trailing wildcard ("")
		expect(ids).toContain("id-a");
		expect(ids).toContain("id-b");
		expect(ids).toContain("");
		expect(completed.length).toBe(3);
		// Every completed event must carry cancelled: true.
		for (const e of completed) {
			expect((e.payload as { cancelled: boolean }).cancelled).toBe(true);
		}
	});

	test("cancel-all with no tracked ids still broadcasts the wildcard cancelled event", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		fireCancel(undefined); // non-object payload → {} → cancel-all
		const completed = eventsFor(IPC.TTS_COMPLETED, sent);
		expect(completed.length).toBe(1);
		expect(completed[0]?.payload).toEqual({ requestId: "", cancelled: true });
	});

	test("a cancelled request id is no longer broadcast on a subsequent cancel-all", async () => {
		setup({ enabled: true });
		const speak = handlers.get(IPC.TTS_SPEAK);
		await speak?.(fakeEvent, { text: "a", requestId: "id-a" });
		// Scoped-cancel id-a first (removes it from activeIds).
		fireCancel({ requestId: "id-a" });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		fireCancel(undefined); // cancel-all — only the wildcard should remain
		const completed = eventsFor(IPC.TTS_COMPLETED, sent);
		expect(completed.length).toBe(1);
		expect(completed[0]?.payload).toEqual({ requestId: "", cancelled: true });
	});

	test("swallows a throwing ttsCancel and still broadcasts the cancelled event", () => {
		setup({ enabled: true });
		client.cancelThrows = true;
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		fireCancel({ requestId: "boom" });
		expect(logContains("ttsCancel failed")).toBe(true);
		const completed = eventsFor(IPC.TTS_COMPLETED, sent);
		expect(completed.length).toBe(1);
		expect(completed[0]?.payload).toEqual({ requestId: "boom", cancelled: true });
	});

	test("triggerTtsCancelAll fires the cancel-all path exposed by setup", async () => {
		setup({ enabled: true });
		const speak = handlers.get(IPC.TTS_SPEAK);
		await speak?.(fakeEvent, { text: "x", requestId: "global-id" });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		triggerTtsCancelAll();
		expect(client.lastArg("ttsCancel")).toBeUndefined();
		const ids = eventsFor(IPC.TTS_COMPLETED, sent).map(
			(e) => (e.payload as { requestId: string }).requestId
		);
		expect(ids).toContain("global-id");
		expect(ids).toContain("");
	});

	test("triggerTtsCancelAll is a safe no-op after teardown nulls the hook", () => {
		setup({ enabled: true });
		cleanup?.();
		cleanup = null;
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		// Should NOT throw and should broadcast nothing (activeCancelAll === null).
		triggerTtsCancelAll();
		expect(sent.length).toBe(0);
	});
});

describe("install-lifecycle passthroughs", () => {
	function fire(channel: string): void {
		for (const cb of listeners.get(channel) ?? []) {
			cb(fakeSendEvent, undefined);
		}
	}

	test("TTS_INSTALL_PAUSE forwards to ttsInstallPause", () => {
		setup({ enabled: true });
		fire(IPC.TTS_INSTALL_PAUSE);
		expect(client.countCalls("ttsInstallPause")).toBe(1);
	});

	test("TTS_INSTALL_RESUME forwards to ttsInstallResume", () => {
		setup({ enabled: true });
		fire(IPC.TTS_INSTALL_RESUME);
		expect(client.countCalls("ttsInstallResume")).toBe(1);
	});

	test("TTS_INSTALL_CANCEL forwards to ttsInstallCancel", () => {
		setup({ enabled: true });
		fire(IPC.TTS_INSTALL_CANCEL);
		expect(client.countCalls("ttsInstallCancel")).toBe(1);
	});

	test("a throwing install-pause is swallowed and logged", () => {
		setup({ enabled: true });
		client.installPauseThrows = true;
		expect(() => fire(IPC.TTS_INSTALL_PAUSE)).not.toThrow();
		expect(logContains("ttsInstallPause failed")).toBe(true);
	});

	test("a throwing install-resume is swallowed and logged", () => {
		setup({ enabled: true });
		client.installResumeThrows = true;
		expect(() => fire(IPC.TTS_INSTALL_RESUME)).not.toThrow();
		expect(logContains("ttsInstallResume failed")).toBe(true);
	});

	test("a throwing install-cancel is swallowed and logged", () => {
		setup({ enabled: true });
		client.installCancelThrows = true;
		expect(() => fire(IPC.TTS_INSTALL_CANCEL)).not.toThrow();
		expect(logContains("ttsInstallCancel failed")).toBe(true);
	});
});

describe("playback report passthroughs", () => {
	function fire(channel: string, payload: unknown): void {
		for (const cb of listeners.get(channel) ?? []) {
			cb(fakeSendEvent, payload);
		}
	}

	test("TTS_REPORT_PLAYBACK_STARTED re-broadcasts as TTS_PLAYBACK_STARTED with the requestId", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		fire(IPC.TTS_REPORT_PLAYBACK_STARTED, { requestId: "p-1" });
		const out = eventsFor(IPC.TTS_PLAYBACK_STARTED, sent);
		expect(out.length).toBe(1);
		expect(out[0]?.payload).toEqual({ requestId: "p-1" });
	});

	test("TTS_REPORT_PLAYBACK_ENDED re-broadcasts as TTS_PLAYBACK_ENDED with the requestId", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		fire(IPC.TTS_REPORT_PLAYBACK_ENDED, { requestId: "p-2" });
		const out = eventsFor(IPC.TTS_PLAYBACK_ENDED, sent);
		expect(out.length).toBe(1);
		expect(out[0]?.payload).toEqual({ requestId: "p-2" });
	});

	test("playback report with a non-object payload defaults requestId to empty string", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		fire(IPC.TTS_REPORT_PLAYBACK_STARTED, undefined);
		expect(
			(eventsFor(IPC.TTS_PLAYBACK_STARTED, sent)[0]?.payload as { requestId: string }).requestId
		).toBe("");
	});

	test("playback report with an object missing requestId defaults to empty string", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		fire(IPC.TTS_REPORT_PLAYBACK_ENDED, {});
		expect(
			(eventsFor(IPC.TTS_PLAYBACK_ENDED, sent)[0]?.payload as { requestId: string }).requestId
		).toBe("");
	});
});

describe("onDataBinary (tts chunk relay)", () => {
	function emitBinary(header: Record<string, unknown>, pcm: Buffer): void {
		client.emit("data-binary", { header, pcm });
	}

	test("ignores non tts_chunk binary frames", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		emitBinary({ type: "audio_data" }, Buffer.from([1, 2, 3]));
		expect(eventsFor(IPC.TTS_CHUNK, sent).length).toBe(0);
	});

	test("relays a tts_chunk frame, copying the pcm into a fresh ArrayBuffer", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		const pcm = Buffer.from([10, 20, 30, 40]);
		emitBinary(
			{
				type: "tts_chunk",
				request_id: "chunk-req",
				sample_rate: 48_000,
				seq: 7,
				is_final: true,
				format: "s16le",
				channels: 2,
			},
			pcm
		);
		const chunks = eventsFor(IPC.TTS_CHUNK, sent);
		expect(chunks.length).toBe(1);
		const payload = chunks[0]?.payload as {
			requestId: string;
			sampleRate: number;
			seq: number;
			isFinal: boolean;
			format: string;
			channels: number;
			pcm: ArrayBuffer;
		};
		expect(payload.requestId).toBe("chunk-req");
		expect(payload.sampleRate).toBe(48_000);
		expect(payload.seq).toBe(7);
		expect(payload.isFinal).toBe(true);
		expect(payload.format).toBe("s16le");
		expect(payload.channels).toBe(2);
		// The bytes were copied verbatim into the transferable ArrayBuffer.
		expect(Array.from(new Uint8Array(payload.pcm))).toEqual([10, 20, 30, 40]);
	});

	test("applies field defaults when the header omits them", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		emitBinary({ type: "tts_chunk" }, Buffer.from([]));
		const payload = eventsFor(IPC.TTS_CHUNK, sent)[0]?.payload as {
			requestId: string;
			sampleRate: number;
			seq: number;
			isFinal: boolean;
			format: string;
			channels: number;
		};
		expect(payload.requestId).toBe("");
		expect(payload.sampleRate).toBe(24_000);
		expect(payload.seq).toBe(0);
		expect(payload.isFinal).toBe(false);
		expect(payload.format).toBe("f32le");
		expect(payload.channels).toBe(1);
	});
});

describe("onDataEvent (server JSON event relay)", () => {
	function emitEvent(event: Record<string, unknown>): void {
		client.emit("data-event", event);
	}

	test("tts_complete ends the request and broadcasts TTS_COMPLETED with cancelled + elapsed", async () => {
		setup({ enabled: true });
		const speak = handlers.get(IPC.TTS_SPEAK);
		await speak?.(fakeEvent, { text: "x", requestId: "c-1" });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		emitEvent({ type: "tts_complete", request_id: "c-1", cancelled: false, elapsed_ms: 42 });
		const completed = eventsFor(IPC.TTS_COMPLETED, sent);
		expect(completed.length).toBe(1);
		expect(completed[0]?.payload).toEqual({ requestId: "c-1", cancelled: false, elapsedMs: 42 });
	});

	test("tts_complete with no elapsed_ms reports elapsedMs null", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		emitEvent({ type: "tts_complete", request_id: "c-2", cancelled: true });
		expect(eventsFor(IPC.TTS_COMPLETED, sent)[0]?.payload).toEqual({
			requestId: "c-2",
			cancelled: true,
			elapsedMs: null,
		});
	});

	test("tts_complete removes the id from activeIds so cancel-all no longer broadcasts it", async () => {
		setup({ enabled: true });
		const speak = handlers.get(IPC.TTS_SPEAK);
		await speak?.(fakeEvent, { text: "x", requestId: "done-id" });
		emitEvent({ type: "tts_complete", request_id: "done-id" });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		triggerTtsCancelAll();
		const ids = eventsFor(IPC.TTS_COMPLETED, sent).map(
			(e) => (e.payload as { requestId: string }).requestId
		);
		expect(ids).not.toContain("done-id");
		expect(ids).toEqual([""]);
	});

	test("tts_failed broadcasts TTS_FAILED with the server reason", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		emitEvent({ type: "tts_failed", request_id: "f-1", reason: "model load error" });
		expect(eventsFor(IPC.TTS_FAILED, sent)[0]?.payload).toEqual({
			requestId: "f-1",
			reason: "model load error",
		});
	});

	test("tts_failed falls back to a generic reason when none is provided", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		emitEvent({ type: "tts_failed", request_id: "f-2" });
		expect((eventsFor(IPC.TTS_FAILED, sent)[0]?.payload as { reason: string }).reason).toBe(
			"Unknown TTS error"
		);
	});

	test("tts_model_download_start broadcasts an empty TTS_MODEL_DOWNLOAD_START", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		emitEvent({ type: "tts_model_download_start" });
		const out = eventsFor(IPC.TTS_MODEL_DOWNLOAD_START, sent);
		expect(out.length).toBe(1);
		expect(out[0]?.payload).toEqual({});
	});

	test("tts_model_download_progress relays progress/bytes (with defaults)", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		emitEvent({
			type: "tts_model_download_progress",
			progress: 0.5,
			downloaded_bytes: 500,
			total_bytes: 1000,
		});
		expect(eventsFor(IPC.TTS_MODEL_DOWNLOAD_PROGRESS, sent)[0]?.payload).toEqual({
			progress: 0.5,
			downloadedBytes: 500,
			totalBytes: 1000,
		});
	});

	test("tts_model_download_progress defaults to zeros when fields are missing", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		emitEvent({ type: "tts_model_download_progress" });
		expect(eventsFor(IPC.TTS_MODEL_DOWNLOAD_PROGRESS, sent)[0]?.payload).toEqual({
			progress: 0,
			downloadedBytes: 0,
			totalBytes: 0,
		});
	});

	test("tts_model_download_complete forwards the cancelled flag", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		emitEvent({ type: "tts_model_download_complete", cancelled: true });
		expect(eventsFor(IPC.TTS_MODEL_DOWNLOAD_COMPLETE, sent)[0]?.payload).toEqual({
			cancelled: true,
		});
	});

	test("tts_install_status relays the phase (defaulting to 'unknown')", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		emitEvent({ type: "tts_install_status", phase: "engine-pack" });
		expect(eventsFor(IPC.TTS_INSTALL_STATUS, sent)[0]?.payload).toEqual({ phase: "engine-pack" });
		const sent2: SentEvent[] = [];
		allWindows.length = 0;
		allWindows.push(createWindow(2, sent2));
		emitEvent({ type: "tts_install_status" });
		expect(eventsFor(IPC.TTS_INSTALL_STATUS, sent2)[0]?.payload).toEqual({ phase: "unknown" });
	});

	test("tts_install_failed relays reason+category and falls back appropriately", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		emitEvent({ type: "tts_install_failed", reason: "404", category: "NETWORK" });
		expect(eventsFor(IPC.TTS_INSTALL_FAILED, sent)[0]?.payload).toEqual({
			reason: "404",
			category: "NETWORK",
		});
		const sent2: SentEvent[] = [];
		allWindows.length = 0;
		allWindows.push(createWindow(2, sent2));
		emitEvent({ type: "tts_install_failed" });
		expect(eventsFor(IPC.TTS_INSTALL_FAILED, sent2)[0]?.payload).toEqual({
			reason: "TTS install failed",
			category: null,
		});
	});

	test("tts_install_failed with an empty reason still falls back to the generic message", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		emitEvent({ type: "tts_install_failed", reason: "" });
		expect((eventsFor(IPC.TTS_INSTALL_FAILED, sent)[0]?.payload as { reason: string }).reason).toBe(
			"TTS install failed"
		);
	});

	test("tts_install_paused / tts_install_resumed broadcast empty payloads", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		emitEvent({ type: "tts_install_paused" });
		emitEvent({ type: "tts_install_resumed" });
		expect(eventsFor(IPC.TTS_INSTALL_PAUSED, sent)[0]?.payload).toEqual({});
		expect(eventsFor(IPC.TTS_INSTALL_RESUMED, sent)[0]?.payload).toEqual({});
	});

	test("an unknown event type is silently ignored", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		emitEvent({ type: "some_unrelated_event", request_id: "x" });
		expect(sent.length).toBe(0);
	});

	test("an event with a non-string type is silently ignored", () => {
		setup({ enabled: true });
		const sent: SentEvent[] = [];
		allWindows.push(createWindow(1, sent));
		emitEvent({ type: 123 as unknown as string });
		expect(sent.length).toBe(0);
	});
});

describe("broadcastAll fan-out & resilience", () => {
	test("broadcasts to every alive window", async () => {
		setup({ enabled: true });
		const sentA: SentEvent[] = [];
		const sentB: SentEvent[] = [];
		allWindows.push(createWindow(1, sentA), createWindow(2, sentB));
		const speak = handlers.get(IPC.TTS_SPEAK);
		await speak?.(fakeEvent, { text: "x", requestId: "fan" });
		expect(eventsFor(IPC.TTS_STARTED, sentA).length).toBe(1);
		expect(eventsFor(IPC.TTS_STARTED, sentB).length).toBe(1);
	});

	test("skips destroyed windows", async () => {
		setup({ enabled: true });
		const dead: SentEvent[] = [];
		const alive: SentEvent[] = [];
		allWindows.push(createWindow(1, dead, { destroyed: true }), createWindow(2, alive));
		const speak = handlers.get(IPC.TTS_SPEAK);
		await speak?.(fakeEvent, { text: "x", requestId: "skip-dead" });
		expect(eventsFor(IPC.TTS_STARTED, dead).length).toBe(0);
		expect(eventsFor(IPC.TTS_STARTED, alive).length).toBe(1);
	});

	test("swallows a throwing renderer so siblings still receive the broadcast", async () => {
		setup({ enabled: true });
		const bad: SentEvent[] = [];
		const good: SentEvent[] = [];
		allWindows.push(createWindow(1, bad, { throwOnSend: true }), createWindow(2, good));
		const speak = handlers.get(IPC.TTS_SPEAK);
		await speak?.(fakeEvent, { text: "x", requestId: "resilient" });
		expect(eventsFor(IPC.TTS_STARTED, good).length).toBe(1);
		expect(logContains("broadcast failed")).toBe(true);
	});
});

describe("eager warm-up", () => {
	test("fires init_tts on setup when TTS is enabled, connected, and already installed", async () => {
		setup({ enabled: true });
		client.estimateResult = { already_installed: true };
		// setup() already ran fireWarmup synchronously; re-run is awaited below.
		await flushMicrotasks();
		expect(client.countCalls("initTts")).toBeGreaterThanOrEqual(1);
		expect(logContains("warm-up: init_tts dispatched")).toBe(true);
	});

	test("does NOT warm up when TTS is disabled", async () => {
		setup({ enabled: false });
		await flushMicrotasks();
		expect(client.countCalls("initTts")).toBe(0);
	});

	test("does NOT warm up when the client is disconnected", async () => {
		setup({ enabled: true, connected: false });
		await flushMicrotasks();
		expect(client.countCalls("initTts")).toBe(0);
	});

	test("first-connect boot check flips tts.enabled OFF when the install is incomplete", async () => {
		// Build a client that is enabled+connected but reports not-installed.
		storeData = { "tts.enabled": true };
		client = new FakeSttClient();
		client.estimateResult = { already_installed: false };
		cleanup = setupTts(asSttClient(client));
		await flushMicrotasks();
		// The boot check should have flipped the store flag off and NOT warmed up.
		expect(storeSetCalls).toContainEqual({ key: "tts.enabled", value: false });
		expect(client.countCalls("initTts")).toBe(0);
		expect(logContains("install incomplete")).toBe(true);
	});

	test("boot install-check probe failure falls through to warm-up", async () => {
		storeData = { "tts.enabled": true };
		client = new FakeSttClient();
		client.estimateThrows = true;
		cleanup = setupTts(asSttClient(client));
		await flushMicrotasks();
		expect(logContains("boot install-check probe failed")).toBe(true);
		expect(client.countCalls("initTts")).toBeGreaterThanOrEqual(1);
	});

	test("re-warms on a (re)connect event (boot check only runs once)", async () => {
		storeData = { "tts.enabled": true };
		client = new FakeSttClient();
		// Not installed on first probe, but a reconnect must NOT re-run the boot
		// check, so it should warm up the second time around.
		client.estimateResult = { already_installed: false };
		cleanup = setupTts(asSttClient(client));
		await flushMicrotasks();
		// First connect flipped enabled off → no init.
		expect(client.countCalls("initTts")).toBe(0);
		// Re-enable so isTtsEnabled() is true again, then fire a reconnect.
		storeData["tts.enabled"] = true;
		client.emit("connected");
		await flushMicrotasks();
		// bootInstallCheckDone is now true → skips the gate → warms up.
		expect(client.countCalls("initTts")).toBeGreaterThanOrEqual(1);
	});

	test("a throwing initTts during warm-up is swallowed and logged", async () => {
		storeData = { "tts.enabled": true };
		client = new FakeSttClient();
		client.estimateResult = { already_installed: true };
		client.initThrows = true;
		cleanup = setupTts(asSttClient(client));
		await flushMicrotasks();
		expect(logContains("warm-up init_tts failed")).toBe(true);
	});

	// Fire the onDidChange("tts") listener registered by setupTts. The store
	// mock keys listeners by the exact set() key, and the handler subscribes to
	// "tts"; the production listener ignores the (value, prev) args and re-reads
	// from the store, so (undefined, undefined) is fine.
	function fireTtsChange(): void {
		for (const cb of storeListeners.get("tts") ?? []) {
			cb(undefined, undefined);
		}
	}

	// CASE 1 — warm-up on off→on while source is local.
	test("flipping tts.enabled off→on while source is local fires warm-up, not shutdown", async () => {
		setup({ enabled: false });
		storeData["tts.source"] = "local";
		client.estimateResult = { already_installed: true };
		await flushMicrotasks();
		expect(client.countCalls("initTts")).toBe(0);
		storeData["tts.enabled"] = true;
		fireTtsChange();
		await flushMicrotasks();
		expect(client.countCalls("initTts")).toBeGreaterThanOrEqual(1);
		expect(client.countCalls("shutdownTts")).toBe(0);
	});

	// CASE 2 — shutdown on on→off while source is local.
	test("flipping tts.enabled on→off while source is local fires shutdownTts to free Kokoro", async () => {
		setup({ enabled: true });
		storeData["tts.source"] = "local";
		client.estimateResult = { already_installed: true };
		await flushMicrotasks();
		const initBefore = client.countCalls("initTts");
		storeData["tts.enabled"] = false;
		fireTtsChange();
		await flushMicrotasks();
		expect(client.countCalls("shutdownTts")).toBe(1);
		expect(client.countCalls("initTts")).toBe(initBefore);
	});

	// CASE 3 — shutdown on source local→cloud while enabled (the headline gap:
	// tts.enabled never changes, so the old off→on check missed it entirely).
	test("switching tts.source local→cloud while enabled fires shutdownTts (no warm-up)", async () => {
		setup({ enabled: true });
		storeData["tts.source"] = "local";
		client.estimateResult = { already_installed: true };
		await flushMicrotasks();
		const initBefore = client.countCalls("initTts");
		storeData["tts.source"] = "cloud";
		fireTtsChange();
		await flushMicrotasks();
		expect(client.countCalls("shutdownTts")).toBe(1);
		expect(client.countCalls("initTts")).toBe(initBefore);
	});

	// CASE 4 — warm-up on source cloud→local while enabled. lastLocalActive is
	// computed at construction, so the initial state must be cloud (inactive).
	test("switching tts.source cloud→local while enabled fires warm-up, no shutdown", async () => {
		storeData = { "tts.enabled": true, "tts.source": "cloud" };
		client = new FakeSttClient();
		client.estimateResult = { already_installed: true };
		cleanup = setupTts(asSttClient(client));
		await flushMicrotasks();
		expect(client.countCalls("initTts")).toBe(0);
		storeData["tts.source"] = "local";
		fireTtsChange();
		await flushMicrotasks();
		expect(client.countCalls("initTts")).toBeGreaterThanOrEqual(1);
		expect(client.countCalls("shutdownTts")).toBe(0);
	});

	// CASE 5 — neither edge fires while source stays cloud (cloud is never the
	// local synthesis path, so toggling tts.enabled is a no-op for Kokoro).
	test("toggling tts.enabled while source is cloud fires NEITHER warm-up NOR shutdownTts", async () => {
		storeData = { "tts.enabled": false, "tts.source": "cloud" };
		client = new FakeSttClient();
		client.estimateResult = { already_installed: true };
		cleanup = setupTts(asSttClient(client));
		await flushMicrotasks();
		expect(client.countCalls("initTts")).toBe(0);
		expect(client.countCalls("shutdownTts")).toBe(0);
		storeData["tts.enabled"] = true;
		fireTtsChange();
		await flushMicrotasks();
		expect(client.countCalls("initTts")).toBe(0);
		expect(client.countCalls("shutdownTts")).toBe(0);
		storeData["tts.enabled"] = false;
		fireTtsChange();
		await flushMicrotasks();
		expect(client.countCalls("initTts")).toBe(0);
		expect(client.countCalls("shutdownTts")).toBe(0);
	});

	// REGRESSION GUARD — a no-edge change (e.g. voice/speed edit) on the active
	// local path fires neither warm-up nor shutdown.
	test("an on→on (enabled, local) store change with no edge fires neither warm-up nor shutdown", async () => {
		setup({ enabled: true });
		storeData["tts.source"] = "local";
		client.estimateResult = { already_installed: true };
		await flushMicrotasks();
		const initBefore = client.countCalls("initTts");
		fireTtsChange();
		await flushMicrotasks();
		expect(client.countCalls("initTts")).toBe(initBefore);
		expect(client.countCalls("shutdownTts")).toBe(0);
	});

	test("an off→off store change does NOT warm up", async () => {
		setup({ enabled: false });
		await flushMicrotasks();
		fireTtsChange();
		await flushMicrotasks();
		expect(client.countCalls("initTts")).toBe(0);
		expect(client.countCalls("shutdownTts")).toBe(0);
	});

	// REGRESSION GUARD — on→off while local but disconnected must skip the
	// shutdown (shutdown_tts is a fire-and-forget control send; pointless on a
	// dead channel and ungated internally, so the caller must gate on isConnected).
	test("on→off while local but client disconnected does NOT call shutdownTts", async () => {
		setup({ enabled: true, connected: false });
		storeData["tts.source"] = "local";
		await flushMicrotasks();
		storeData["tts.enabled"] = false;
		fireTtsChange();
		await flushMicrotasks();
		expect(client.countCalls("shutdownTts")).toBe(0);
	});

	// REGRESSION GUARD — the boot install-check's programmatic flip-off must not
	// register as an active→inactive edge (nothing was ever warmed, so freeing
	// is a no-op). This is NON-VACUOUS only because the store mock fans the
	// `store.set("tts.enabled", false)` write up to the "tts" listener
	// SYNCHRONOUSLY (like conf): the listener runs mid-`set`, so it fails unless
	// `lastLocalActive` is pre-aligned to false BEFORE the write in tts.ts. With
	// the ordering reversed, the listener would see stale `lastLocalActive=true`
	// and fire a spurious shutdownTts → this test would catch it.
	test("first-connect boot check flipping tts.enabled OFF does NOT call shutdownTts", async () => {
		storeData = { "tts.enabled": true, "tts.source": "local" };
		client = new FakeSttClient();
		client.estimateResult = { already_installed: false };
		cleanup = setupTts(asSttClient(client));
		await flushMicrotasks();
		expect(storeSetCalls).toContainEqual({ key: "tts.enabled", value: false });
		expect(client.countCalls("shutdownTts")).toBe(0);
	});
});
