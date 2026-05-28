import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";
import { storeMock } from "@test/mocks/store";

// tts-hotkey.ts → ../lib/debug-log → `import { app } from "electron"` at module
// load. Without the shim the real electron entrypoint resolves and throws
// "Export named 'app' not found".
mock.module("electron", () => electronMock());

// ── uiohook-napi shim ──────────────────────────────────────────────
// Capture the keydown / keyup listeners the handler registers so the test can
// drive synthetic key events through the SAME path the OS hook would. `off`
// must splice the exact listener so dispose() is observable (listener arrays
// shrink back to 0).
type UioListener = (event: { keycode: number }) => void;
const uioListeners: { keydown: UioListener[]; keyup: UioListener[] } = {
	keydown: [],
	keyup: [],
};
// Keycodes used by the keycodes.ts accelerator parser. These MUST match the
// shared uiohook mock so `parseAccelerator("LCtrl+LShift+S")` resolves.
const UiohookKey = {
	Ctrl: 1,
	Shift: 5,
	Backspace: 72,
	S: 48,
	A: 30,
} as const;

mock.module("uiohook-napi", () => ({
	uIOhook: {
		on: (channel: "keydown" | "keyup", listener: UioListener) => {
			uioListeners[channel].push(listener);
		},
		off: (channel: "keydown" | "keyup", listener: UioListener) => {
			const list = uioListeners[channel];
			const idx = list.indexOf(listener);
			if (idx !== -1) {
				list.splice(idx, 1);
			}
		},
		start: () => undefined,
		stop: () => undefined,
	},
	UiohookKey,
}));

// ── store shim ─────────────────────────────────────────────────────
// Backed by a single mutable map so store.get / store.set / onDidChange stay
// internally consistent. The handler subscribes to onDidChange("tts", …); we
// expose the registered callbacks so a test can fire the change notification.
const storeValues: Record<string, unknown> = {};
const storeChangeListeners = new Map<string, Array<() => void>>();
mock.module("../lib/store", () => ({
	store: {
		get: (key: string) => storeValues[key],
		set: (key: string, value: unknown) => {
			storeValues[key] = value;
			for (const cb of storeChangeListeners.get(key) ?? []) {
				cb();
			}
		},
		onDidChange: (key: string, cb: () => void) => {
			const list = storeChangeListeners.get(key) ?? [];
			list.push(cb);
			storeChangeListeners.set(key, list);
			return () => {
				storeChangeListeners.set(
					key,
					(storeChangeListeners.get(key) ?? []).filter((x) => x !== cb)
				);
			};
		},
	},
}));

// ── selection-capture shim ─────────────────────────────────────────
// Drive what the user "had selected" and whether the capture rejects.
let captureResult: { text: string; source: string; originalClipboard: null } = {
	text: "hello world",
	source: "uia",
	originalClipboard: null,
};
let captureShouldReject = false;
let captureRejectWithString = false;
let captureCallCount = 0;
mock.module("../lib/selection-capture", () => ({
	captureSelection: () => {
		captureCallCount += 1;
		if (captureRejectWithString) {
			return Promise.reject("string failure");
		}
		if (captureShouldReject) {
			return Promise.reject(new Error("UIA blew up"));
		}
		return Promise.resolve(captureResult);
	},
}));

// ── hotkey shim (isPasteGuardActive) ───────────────────────────────
let pasteGuardActive = false;
mock.module("./hotkey", () => ({
	isPasteGuardActive: () => pasteGuardActive,
}));

// ── recording-mode shim (isAnyHotkeyRecording) ─────────────────────
let anyHotkeyRecording = false;
mock.module("./recording-mode", () => ({
	isAnyHotkeyRecording: () => anyHotkeyRecording,
}));

// ── tts shim (triggerTtsCancelAll) ─────────────────────────────────
let cancelAllCount = 0;
mock.module("./tts", () => ({
	triggerTtsCancelAll: () => {
		cancelAllCount += 1;
	},
}));

const { setupTtsHotkey } = await import("./tts-hotkey");

// Restore the shared store mock for sibling tests — bun's mock.module registry
// is process-global, and a slim per-file shim leaks otherwise. NOTE: the
// factory MUST be synchronous — an `async` factory that does a dynamic import
// inside `afterAll` deadlocks bun's module loader at teardown.
afterAll(() => {
	mock.module("../lib/store", () => storeMock());
});

// dbg() output is routed through electron-log's console transport, which
// test/preload.ts captures into __testLogLines (every level). Patching
// console.log here would miss the console.info-routed lines dbg() emits.
const consoleLogLines = (globalThis as unknown as { __testLogLines: string[] }).__testLogLines;
function logContains(needle: string): boolean {
	return consoleLogLines.some((line) => line.includes(needle));
}

// ── fake SttClient ─────────────────────────────────────────────────
interface SynthCall {
	lang?: string;
	requestId: string;
	speed?: number;
	text: string;
	voice?: string;
}
function makeClient(): { synth: SynthCall[]; client: { ttsSynthesize: (p: SynthCall) => void } } {
	const synth: SynthCall[] = [];
	return {
		synth,
		client: {
			ttsSynthesize: (p: SynthCall) => {
				synth.push(p);
			},
		},
	};
}
// The production signature takes an SttClient; our stub only needs ttsSynthesize.
type SetupArg = Parameters<typeof setupTtsHotkey>[0];
const asClient = (m: { ttsSynthesize: (p: SynthCall) => void }): SetupArg =>
	m as unknown as SetupArg;

const COMBO = "LCtrl+LShift+S";
const COMBO_KEYS = [UiohookKey.Ctrl, UiohookKey.Shift, UiohookKey.S];

function fireKeyDown(keycode: number): void {
	const listener = uioListeners.keydown[0];
	if (listener) {
		listener({ keycode });
	}
}
function fireKeyUp(keycode: number): void {
	const listener = uioListeners.keyup[0];
	if (listener) {
		listener({ keycode });
	}
}
function holdCombo(): void {
	for (const k of COMBO_KEYS) {
		fireKeyDown(k);
	}
}
// Fire the store-change subscription the handler registered for the "tts" key.
// `install` writes storeValues directly (no store.set), so the subscription
// callback only runs when invoked explicitly here — mirroring electron-store's
// onDidChange firing after a persisted write.
function fireTtsStoreChange(): void {
	for (const cb of (storeChangeListeners.get("tts") ?? []).slice()) {
		cb();
	}
}

// `setupTtsHotkey` carries module-global state (pressed/firedThisHold/combo/
// listenerInstalled/activeClient) that is only cleared by the returned
// dispose(). Each test installs fresh state and disposes via this handle.
let active: { dispose: () => void } | null = null;
function install(
	client: { ttsSynthesize: (p: SynthCall) => void },
	opts: { hotkey?: string | unknown; enabled?: boolean } = {}
): void {
	if ("hotkey" in opts) {
		storeValues["tts.hotkey"] = opts.hotkey;
	} else {
		storeValues["tts.hotkey"] = COMBO;
	}
	storeValues["tts.enabled"] = opts.enabled ?? true;
	active = setupTtsHotkey(asClient(client));
}

beforeEach(() => {
	// Fully tear down any prior install so module-global state resets.
	if (active) {
		active.dispose();
		active = null;
	}
	uioListeners.keydown.length = 0;
	uioListeners.keyup.length = 0;
	storeChangeListeners.clear();
	for (const key of Object.keys(storeValues)) {
		delete storeValues[key];
	}
	captureResult = { text: "hello world", source: "uia", originalClipboard: null };
	captureShouldReject = false;
	captureRejectWithString = false;
	captureCallCount = 0;
	cancelAllCount = 0;
	pasteGuardActive = false;
	anyHotkeyRecording = false;
});

describe("setupTtsHotkey: install / lifecycle", () => {
	test("installs keydown + keyup listeners and a tts store subscription", () => {
		const { client } = makeClient();
		install(client);
		expect(uioListeners.keydown.length).toBe(1);
		expect(uioListeners.keyup.length).toBe(1);
		expect((storeChangeListeners.get("tts") ?? []).length).toBe(1);
	});

	test("returns a handle whose dispose() detaches both listeners and the subscription", () => {
		const { client } = makeClient();
		install(client);
		const handle = active;
		expect(handle).not.toBeNull();
		handle?.dispose();
		active = null;
		expect(uioListeners.keydown.length).toBe(0);
		expect(uioListeners.keyup.length).toBe(0);
		expect((storeChangeListeners.get("tts") ?? []).length).toBe(0);
	});

	test("is idempotent — a second call does not double-register listeners", () => {
		const { client } = makeClient();
		install(client);
		// Second call while installed: returns a handle but installs nothing new.
		const second = setupTtsHotkey(asClient(client));
		expect(uioListeners.keydown.length).toBe(1);
		expect(uioListeners.keyup.length).toBe(1);
		expect((storeChangeListeners.get("tts") ?? []).length).toBe(1);
		second.dispose();
	});

	test("dispose() twice is a safe no-op (second call detaches nothing)", () => {
		const { client } = makeClient();
		install(client);
		const handle = active;
		active = null;
		handle?.dispose();
		expect(uioListeners.keydown.length).toBe(0);
		expect(() => handle?.dispose()).not.toThrow();
		expect(uioListeners.keydown.length).toBe(0);
	});

	test("re-install after dispose works (listenerInstalled is reset by cleanup)", () => {
		const { client } = makeClient();
		install(client);
		active?.dispose();
		active = null;
		uioListeners.keydown.length = 0;
		uioListeners.keyup.length = 0;
		// Fresh install must register again — proves cleanup() flipped
		// listenerInstalled back to false.
		install(client);
		expect(uioListeners.keydown.length).toBe(1);
		expect(uioListeners.keyup.length).toBe(1);
	});

	test("BUG: idempotent re-call drops the new SttClient — speak still goes to the FIRST client", async () => {
		// setupTtsHotkey returns early when listenerInstalled, WITHOUT updating
		// `activeClient`. If a caller re-wires with a fresh client (e.g. after a
		// WS reconnect) without disposing first, synthesis keeps dispatching to
		// the STALE first client. Documents current (arguably buggy) behaviour.
		const first = makeClient();
		const second = makeClient();
		install(first.client);
		const handle = setupTtsHotkey(asClient(second.client));
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(first.synth.length).toBe(1);
		expect(second.synth.length).toBe(0);
		handle.dispose();
	});
});

describe("setupTtsHotkey: combo firing (happy path)", () => {
	test("dispatches ttsSynthesize only once the FULL combo is held", async () => {
		const { client, synth } = makeClient();
		install(client);
		fireKeyDown(COMBO_KEYS[0] as number);
		fireKeyDown(COMBO_KEYS[1] as number);
		expect(captureCallCount).toBe(0);
		fireKeyDown(COMBO_KEYS[2] as number); // completes the combo
		expect(captureCallCount).toBe(1);
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(1);
		expect(synth[0]?.text).toBe("hello world");
	});

	test("passes the captured selection text + store voice/lang/speed verbatim", async () => {
		const { client, synth } = makeClient();
		storeValues["tts.voice"] = "bf_emma";
		storeValues["tts.lang"] = "en-gb";
		storeValues["tts.speed"] = 1.25;
		install(client);
		captureResult = { text: "  read me  ", source: "uia", originalClipboard: null };
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(1);
		const call = synth[0];
		expect(call?.text).toBe("  read me  ");
		expect(call?.voice).toBe("bf_emma");
		expect(call?.lang).toBe("en-gb");
		expect(call?.speed).toBe(1.25);
		// requestId is a randomUUID — present and non-empty.
		expect(typeof call?.requestId).toBe("string");
		expect((call?.requestId ?? "").length).toBeGreaterThan(0);
	});

	test("applies default voice / lang / speed when the store keys are unset", async () => {
		const { client, synth } = makeClient();
		install(client); // no tts.voice/lang/speed seeded
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth[0]?.voice).toBe("af_heart");
		expect(synth[0]?.lang).toBe("en-us");
		expect(synth[0]?.speed).toBe(1.0);
	});

	test("speed below 0.5 is clamped up to 0.5", async () => {
		const { client, synth } = makeClient();
		storeValues["tts.speed"] = 0.1;
		install(client);
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth[0]?.speed).toBe(0.5);
	});

	test("speed above 2.0 is clamped down to 2.0", async () => {
		const { client, synth } = makeClient();
		storeValues["tts.speed"] = 9;
		install(client);
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth[0]?.speed).toBe(2.0);
	});

	test("non-numeric speed falls back to the 1.0 default", async () => {
		const { client, synth } = makeClient();
		storeValues["tts.speed"] = "fast";
		install(client);
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth[0]?.speed).toBe(1.0);
	});

	test("empty-string store voice/lang fall back to defaults (|| not ??)", async () => {
		const { client, synth } = makeClient();
		storeValues["tts.voice"] = "";
		storeValues["tts.lang"] = "";
		install(client);
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth[0]?.voice).toBe("af_heart");
		expect(synth[0]?.lang).toBe("en-us");
	});
});

describe("setupTtsHotkey: single-shot per hold (auto-repeat guard)", () => {
	test("does NOT re-dispatch while the combo stays held (OS auto-repeat)", async () => {
		const { client, synth } = makeClient();
		install(client);
		holdCombo();
		// Auto-repeat re-delivers the last key several times.
		fireKeyDown(COMBO_KEYS[2] as number);
		fireKeyDown(COMBO_KEYS[2] as number);
		await Promise.resolve();
		await Promise.resolve();
		expect(captureCallCount).toBe(1);
		expect(synth.length).toBe(1);
	});

	test("re-dispatches after a key in the combo is released and re-pressed", async () => {
		const { client, synth } = makeClient();
		install(client);
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(1);
		// Release the non-modifier — combo no longer fully held → fired flag clears.
		fireKeyUp(COMBO_KEYS[2] as number);
		// Re-press it → combo fully held again → fire #2.
		fireKeyDown(COMBO_KEYS[2] as number);
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(2);
	});

	test("releasing a key NOT in the combo leaves the fired flag intact (no re-fire)", async () => {
		const { client, synth } = makeClient();
		install(client);
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(1);
		// Press + release an unrelated key while the combo is still fully held.
		fireKeyDown(UiohookKey.A);
		fireKeyUp(UiohookKey.A);
		// Re-deliver the combo's last key (still held) — must not re-fire.
		fireKeyDown(COMBO_KEYS[2] as number);
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(1);
	});
});

describe("setupTtsHotkey: gating guards", () => {
	test("no dispatch when tts.enabled is false", async () => {
		const { client, synth } = makeClient();
		install(client, { enabled: false });
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(captureCallCount).toBe(0);
		expect(synth.length).toBe(0);
	});

	test("no dispatch when no hotkey is configured (empty string)", async () => {
		const { client, synth } = makeClient();
		install(client, { hotkey: "" });
		// Pressing the keys that WOULD form the combo does nothing — combo is null.
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(captureCallCount).toBe(0);
		expect(synth.length).toBe(0);
		expect(logContains("no hotkey configured")).toBe(true);
	});

	test("no dispatch when the configured hotkey is unparseable", async () => {
		const { client, synth } = makeClient();
		consoleLogLines.length = 0;
		install(client, { hotkey: "LCtrl+NotAKey" });
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(0);
		expect(logContains("unparseable")).toBe(true);
	});

	test("non-string hotkey value is coerced to no-combo (loadHotkey type guard)", async () => {
		const { client, synth } = makeClient();
		install(client, { hotkey: 12_345 });
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(0);
	});

	test("whitespace-padded hotkey is trimmed before parsing", async () => {
		const { client, synth } = makeClient();
		install(client, { hotkey: `  ${COMBO}  ` });
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		// Trimmed → parses to the same combo → fires.
		expect(synth.length).toBe(1);
	});

	test("keydown is fully short-circuited while the paste guard is active", async () => {
		const { client, synth } = makeClient();
		install(client);
		pasteGuardActive = true;
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		// Guard blocks before pressed.add, so the combo never registers as held.
		expect(captureCallCount).toBe(0);
		expect(synth.length).toBe(0);
	});

	test("keydown is short-circuited (no fire) while a hotkey is being recorded", async () => {
		const { client, synth } = makeClient();
		install(client);
		anyHotkeyRecording = true;
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(0);
		// But pressed-state is still tracked: ending recording then re-pressing
		// the last key should now fire (combo was already held internally).
		anyHotkeyRecording = false;
		fireKeyDown(COMBO_KEYS[2] as number);
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(1);
	});

	test("paste guard active during keyup does not mutate pressed-state (early return)", async () => {
		const { client, synth } = makeClient();
		install(client);
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(1);
		// Release the combo key WHILE the paste guard is active → keyup early
		// returns, so pressed.delete never runs and firedThisHold stays true.
		pasteGuardActive = true;
		fireKeyUp(COMBO_KEYS[2] as number);
		pasteGuardActive = false;
		// Re-pressing the (never-released, per state) key must NOT re-fire.
		fireKeyDown(COMBO_KEYS[2] as number);
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(1);
	});

	test("keyup while a hotkey is being recorded does not clear the fired flag", async () => {
		const { client, synth } = makeClient();
		install(client);
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(1);
		anyHotkeyRecording = true;
		fireKeyUp(COMBO_KEYS[2] as number); // would clear fired, but recording blocks it
		anyHotkeyRecording = false;
		fireKeyDown(COMBO_KEYS[2] as number);
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(1);
	});
});

describe("setupTtsHotkey: stop gesture (combo + Backspace)", () => {
	test("combo + Backspace cancels TTS and suppresses the speak path", async () => {
		const { client, synth } = makeClient();
		install(client);
		consoleLogLines.length = 0;
		fireKeyDown(COMBO_KEYS[0] as number);
		fireKeyDown(COMBO_KEYS[1] as number);
		fireKeyDown(COMBO_KEYS[2] as number);
		// At this point speak already fired once. Now add Backspace → stop.
		await Promise.resolve();
		await Promise.resolve();
		const synthBeforeStop = synth.length;
		fireKeyDown(UiohookKey.Backspace);
		expect(cancelAllCount).toBe(1);
		await Promise.resolve();
		await Promise.resolve();
		// Stop does not enqueue any further synthesis.
		expect(synth.length).toBe(synthBeforeStop);
		expect(logContains("stop gesture")).toBe(true);
	});

	test("Backspace pressed FIRST (with combo) cancels and never speaks", async () => {
		const { client, synth } = makeClient();
		install(client);
		fireKeyDown(UiohookKey.Backspace);
		fireKeyDown(COMBO_KEYS[0] as number);
		fireKeyDown(COMBO_KEYS[1] as number);
		fireKeyDown(COMBO_KEYS[2] as number); // completes combo WITH backspace held
		expect(cancelAllCount).toBe(1);
		await Promise.resolve();
		await Promise.resolve();
		// firedThisHold was set by maybeStop before maybeFire could run → no speak.
		expect(synth.length).toBe(0);
		expect(captureCallCount).toBe(0);
	});

	test("Backspace WITHOUT the full combo does not cancel", () => {
		const { client } = makeClient();
		install(client);
		fireKeyDown(COMBO_KEYS[0] as number); // partial combo
		fireKeyDown(UiohookKey.Backspace);
		expect(cancelAllCount).toBe(0);
	});

	test("stop gesture is inert when tts.enabled is false", () => {
		const { client } = makeClient();
		install(client, { enabled: false });
		holdCombo();
		fireKeyDown(UiohookKey.Backspace);
		expect(cancelAllCount).toBe(0);
	});

	test("stop gesture is inert when no combo is configured", () => {
		const { client } = makeClient();
		install(client, { hotkey: "" });
		holdCombo();
		fireKeyDown(UiohookKey.Backspace);
		expect(cancelAllCount).toBe(0);
	});
});

describe("dispatchSpeak: selection + client edge cases", () => {
	test("empty selection text does NOT call ttsSynthesize", async () => {
		const { client, synth } = makeClient();
		install(client);
		captureResult = { text: "   ", source: "uia", originalClipboard: null };
		consoleLogLines.length = 0;
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(captureCallCount).toBe(1);
		expect(synth.length).toBe(0);
		expect(logContains("no selection captured")).toBe(true);
	});

	test("captureSelection rejection is swallowed and logged (Error branch)", async () => {
		const { client, synth } = makeClient();
		install(client);
		captureShouldReject = true;
		consoleLogLines.length = 0;
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(0);
		expect(logContains("captureSelection failed")).toBe(true);
		expect(logContains("UIA blew up")).toBe(true);
	});

	test("captureSelection rejection with a non-Error value is also swallowed", async () => {
		const { client, synth } = makeClient();
		install(client);
		captureRejectWithString = true;
		consoleLogLines.length = 0;
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(0);
		expect(logContains("captureSelection failed")).toBe(true);
	});
});

describe("setupTtsHotkey: store-change subscription (re-arm)", () => {
	test("a tts.hotkey change re-runs rebuildCombo and arms the NEW combo", async () => {
		const { client, synth } = makeClient();
		// Install with NO hotkey → combo is null, nothing fires.
		install(client, { hotkey: "" });
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(0);
		// Now configure a real hotkey and fire the store subscription.
		storeValues["tts.hotkey"] = COMBO;
		fireTtsStoreChange();
		// Re-press the combo from a clean state — the freshly-armed combo fires.
		fireKeyUp(COMBO_KEYS[0] as number);
		fireKeyUp(COMBO_KEYS[1] as number);
		fireKeyUp(COMBO_KEYS[2] as number);
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(1);
	});

	test("a tts.enabled change is part of the fingerprint and re-arms the listener", async () => {
		const { client, synth } = makeClient();
		// Install disabled — combo is parsed but maybeFire is gated off.
		install(client, { enabled: false });
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(0);
		// Flip enabled true, fire the subscription (fingerprint changed).
		storeValues["tts.enabled"] = true;
		fireTtsStoreChange();
		fireKeyUp(COMBO_KEYS[2] as number);
		fireKeyDown(COMBO_KEYS[2] as number);
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(1);
	});

	test("a no-op store change (identical fingerprint) does NOT rebuild the combo", async () => {
		const { client, synth } = makeClient();
		install(client);
		consoleLogLines.length = 0;
		// Fire the subscription WITHOUT changing tts.hotkey / tts.enabled. The
		// fingerprint matches → early return, so rebuildCombo is skipped (no
		// "armed hotkey" dbg line is re-emitted for this notification).
		fireTtsStoreChange();
		// The existing combo still works (it was armed at install, not re-armed).
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(1);
	});

	test("changing only an unrelated tts.* key (voice) leaves the fingerprint stable", async () => {
		const { client, synth } = makeClient();
		install(client);
		// voice/speed/lang are NOT part of the fingerprint — a change here fires
		// the subscription but must NOT trigger a rebuild (early return path).
		storeValues["tts.voice"] = "bf_emma";
		fireTtsStoreChange();
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(synth.length).toBe(1);
		// The new voice is still read at dispatch time (dispatchSpeak reads live).
		expect(synth[0]?.voice).toBe("bf_emma");
	});
});
