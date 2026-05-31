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

// ── tts shim (triggerTtsCancelAll + triggerTtsSpeakText) ───────────
// The hotkey no longer dispatches synthesis itself — it captures the selection
// then hands the TEXT to `triggerTtsSpeakText`, which (in production) routes
// through the SAME source-aware dispatcher the renderer "Speak" button uses
// (local Kokoro or cloud ElevenLabs). The voice / lang / speed / model resolution
// lives there, NOT here, so the hotkey suite only asserts WHICH text was handed
// off and that the gating is correct.
let cancelAllCount = 0;
const speakTexts: string[] = [];
mock.module("./tts", () => ({
	triggerTtsCancelAll: () => {
		cancelAllCount += 1;
	},
	triggerTtsSpeakText: (text: string) => {
		speakTexts.push(text);
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
// `setupTtsHotkey(sttClient)` only uses the client as a "setup ran" guard now
// (synthesis is dispatched through `triggerTtsSpeakText`), so a bare stub object
// is enough. The cast mirrors the production signature.
type SetupArg = Parameters<typeof setupTtsHotkey>[0];
const DUMMY_CLIENT: SetupArg = {} as unknown as SetupArg;

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
function install(opts: { hotkey?: string | unknown; enabled?: boolean } = {}): void {
	if ("hotkey" in opts) {
		storeValues["tts.hotkey"] = opts.hotkey;
	} else {
		storeValues["tts.hotkey"] = COMBO;
	}
	storeValues["tts.enabled"] = opts.enabled ?? true;
	active = setupTtsHotkey(DUMMY_CLIENT);
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
	speakTexts.length = 0;
	pasteGuardActive = false;
	anyHotkeyRecording = false;
});

describe("setupTtsHotkey: install / lifecycle", () => {
	test("installs keydown + keyup listeners and a tts store subscription", () => {
		install();
		expect(uioListeners.keydown.length).toBe(1);
		expect(uioListeners.keyup.length).toBe(1);
		expect((storeChangeListeners.get("tts") ?? []).length).toBe(1);
	});

	test("returns a handle whose dispose() detaches both listeners and the subscription", () => {
		install();
		const handle = active;
		expect(handle).not.toBeNull();
		handle?.dispose();
		active = null;
		expect(uioListeners.keydown.length).toBe(0);
		expect(uioListeners.keyup.length).toBe(0);
		expect((storeChangeListeners.get("tts") ?? []).length).toBe(0);
	});

	test("is idempotent — a second call does not double-register listeners", () => {
		install();
		// Second call while installed: returns a handle but installs nothing new.
		const second = setupTtsHotkey(DUMMY_CLIENT);
		expect(uioListeners.keydown.length).toBe(1);
		expect(uioListeners.keyup.length).toBe(1);
		expect((storeChangeListeners.get("tts") ?? []).length).toBe(1);
		second.dispose();
	});

	test("dispose() twice is a safe no-op (second call detaches nothing)", () => {
		install();
		const handle = active;
		active = null;
		handle?.dispose();
		expect(uioListeners.keydown.length).toBe(0);
		expect(() => handle?.dispose()).not.toThrow();
		expect(uioListeners.keydown.length).toBe(0);
	});

	test("re-install after dispose works (listenerInstalled is reset by cleanup)", () => {
		install();
		active?.dispose();
		active = null;
		uioListeners.keydown.length = 0;
		uioListeners.keyup.length = 0;
		// Fresh install must register again — proves cleanup() flipped
		// listenerInstalled back to false.
		install();
		expect(uioListeners.keydown.length).toBe(1);
		expect(uioListeners.keyup.length).toBe(1);
	});
});

describe("setupTtsHotkey: combo firing (happy path)", () => {
	test("hands the text off only once the FULL combo is held", async () => {
		install();
		fireKeyDown(COMBO_KEYS[0] as number);
		fireKeyDown(COMBO_KEYS[1] as number);
		expect(captureCallCount).toBe(0);
		fireKeyDown(COMBO_KEYS[2] as number); // completes the combo
		expect(captureCallCount).toBe(1);
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(1);
		expect(speakTexts[0]).toBe("hello world");
	});

	test("passes the captured selection text verbatim (trimming/params live downstream)", async () => {
		install();
		// Whitespace is preserved on the wire — the hotkey only checks the trimmed
		// text is non-empty; the actual trim/voice/speed handling is in tts.ts.
		captureResult = { text: "  read me  ", source: "uia", originalClipboard: null };
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(1);
		expect(speakTexts[0]).toBe("  read me  ");
	});
});

describe("setupTtsHotkey: single-shot per hold (auto-repeat guard)", () => {
	test("does NOT re-dispatch while the combo stays held (OS auto-repeat)", async () => {
		install();
		holdCombo();
		// Auto-repeat re-delivers the last key several times.
		fireKeyDown(COMBO_KEYS[2] as number);
		fireKeyDown(COMBO_KEYS[2] as number);
		await Promise.resolve();
		await Promise.resolve();
		expect(captureCallCount).toBe(1);
		expect(speakTexts.length).toBe(1);
	});

	test("re-dispatches after a key in the combo is released and re-pressed", async () => {
		install();
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(1);
		// Release the non-modifier — combo no longer fully held → fired flag clears.
		fireKeyUp(COMBO_KEYS[2] as number);
		// Re-press it → combo fully held again → fire #2.
		fireKeyDown(COMBO_KEYS[2] as number);
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(2);
	});

	test("releasing a key NOT in the combo leaves the fired flag intact (no re-fire)", async () => {
		install();
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(1);
		// Press + release an unrelated key while the combo is still fully held.
		fireKeyDown(UiohookKey.A);
		fireKeyUp(UiohookKey.A);
		// Re-deliver the combo's last key (still held) — must not re-fire.
		fireKeyDown(COMBO_KEYS[2] as number);
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(1);
	});
});

describe("setupTtsHotkey: gating guards", () => {
	test("no dispatch when tts.enabled is false", async () => {
		install({ enabled: false });
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(captureCallCount).toBe(0);
		expect(speakTexts.length).toBe(0);
	});

	test("no dispatch when no hotkey is configured (empty string)", async () => {
		install({ hotkey: "" });
		// Pressing the keys that WOULD form the combo does nothing — combo is null.
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(captureCallCount).toBe(0);
		expect(speakTexts.length).toBe(0);
		expect(logContains("no hotkey configured")).toBe(true);
	});

	test("no dispatch when the configured hotkey is unparseable", async () => {
		consoleLogLines.length = 0;
		install({ hotkey: "LCtrl+NotAKey" });
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(0);
		expect(logContains("unparseable")).toBe(true);
	});

	test("non-string hotkey value is coerced to no-combo (loadHotkey type guard)", async () => {
		install({ hotkey: 12_345 });
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(0);
	});

	test("whitespace-padded hotkey is trimmed before parsing", async () => {
		install({ hotkey: `  ${COMBO}  ` });
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		// Trimmed → parses to the same combo → fires.
		expect(speakTexts.length).toBe(1);
	});

	test("keydown is fully short-circuited while the paste guard is active", async () => {
		install();
		pasteGuardActive = true;
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		// Guard blocks before pressed.add, so the combo never registers as held.
		expect(captureCallCount).toBe(0);
		expect(speakTexts.length).toBe(0);
	});

	test("keydown is short-circuited (no fire) while a hotkey is being recorded", async () => {
		install();
		anyHotkeyRecording = true;
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(0);
		// But pressed-state is still tracked: ending recording then re-pressing
		// the last key should now fire (combo was already held internally).
		anyHotkeyRecording = false;
		fireKeyDown(COMBO_KEYS[2] as number);
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(1);
	});

	test("paste guard active during keyup does not mutate pressed-state (early return)", async () => {
		install();
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(1);
		// Release the combo key WHILE the paste guard is active → keyup early
		// returns, so pressed.delete never runs and firedThisHold stays true.
		pasteGuardActive = true;
		fireKeyUp(COMBO_KEYS[2] as number);
		pasteGuardActive = false;
		// Re-pressing the (never-released, per state) key must NOT re-fire.
		fireKeyDown(COMBO_KEYS[2] as number);
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(1);
	});

	test("keyup while a hotkey is being recorded does not clear the fired flag", async () => {
		install();
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(1);
		anyHotkeyRecording = true;
		fireKeyUp(COMBO_KEYS[2] as number); // would clear fired, but recording blocks it
		anyHotkeyRecording = false;
		fireKeyDown(COMBO_KEYS[2] as number);
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(1);
	});
});

describe("setupTtsHotkey: stop gesture (combo + Backspace)", () => {
	test("combo + Backspace cancels TTS and suppresses the speak path", async () => {
		install();
		consoleLogLines.length = 0;
		fireKeyDown(COMBO_KEYS[0] as number);
		fireKeyDown(COMBO_KEYS[1] as number);
		fireKeyDown(COMBO_KEYS[2] as number);
		// At this point speak already fired once. Now add Backspace → stop.
		await Promise.resolve();
		await Promise.resolve();
		const spokenBeforeStop = speakTexts.length;
		fireKeyDown(UiohookKey.Backspace);
		expect(cancelAllCount).toBe(1);
		await Promise.resolve();
		await Promise.resolve();
		// Stop does not enqueue any further synthesis.
		expect(speakTexts.length).toBe(spokenBeforeStop);
		expect(logContains("stop gesture")).toBe(true);
	});

	test("Backspace pressed FIRST (with combo) cancels and never speaks", async () => {
		install();
		fireKeyDown(UiohookKey.Backspace);
		fireKeyDown(COMBO_KEYS[0] as number);
		fireKeyDown(COMBO_KEYS[1] as number);
		fireKeyDown(COMBO_KEYS[2] as number); // completes combo WITH backspace held
		expect(cancelAllCount).toBe(1);
		await Promise.resolve();
		await Promise.resolve();
		// firedThisHold was set by maybeStop before maybeFire could run → no speak.
		expect(speakTexts.length).toBe(0);
		expect(captureCallCount).toBe(0);
	});

	test("Backspace WITHOUT the full combo does not cancel", () => {
		install();
		fireKeyDown(COMBO_KEYS[0] as number); // partial combo
		fireKeyDown(UiohookKey.Backspace);
		expect(cancelAllCount).toBe(0);
	});

	test("stop gesture is inert when tts.enabled is false", () => {
		install({ enabled: false });
		holdCombo();
		fireKeyDown(UiohookKey.Backspace);
		expect(cancelAllCount).toBe(0);
	});

	test("stop gesture is inert when no combo is configured", () => {
		install({ hotkey: "" });
		holdCombo();
		fireKeyDown(UiohookKey.Backspace);
		expect(cancelAllCount).toBe(0);
	});
});

describe("dispatchSpeak: selection edge cases", () => {
	test("empty selection text does NOT hand any text off", async () => {
		install();
		captureResult = { text: "   ", source: "uia", originalClipboard: null };
		consoleLogLines.length = 0;
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(captureCallCount).toBe(1);
		expect(speakTexts.length).toBe(0);
		expect(logContains("no selection captured")).toBe(true);
	});

	test("captureSelection rejection is swallowed and logged (Error branch)", async () => {
		install();
		captureShouldReject = true;
		consoleLogLines.length = 0;
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(0);
		expect(logContains("captureSelection failed")).toBe(true);
		expect(logContains("UIA blew up")).toBe(true);
	});

	test("captureSelection rejection with a non-Error value is also swallowed", async () => {
		install();
		captureRejectWithString = true;
		consoleLogLines.length = 0;
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(0);
		expect(logContains("captureSelection failed")).toBe(true);
	});
});

describe("setupTtsHotkey: store-change subscription (re-arm)", () => {
	test("a tts.hotkey change re-runs rebuildCombo and arms the NEW combo", async () => {
		// Install with NO hotkey → combo is null, nothing fires.
		install({ hotkey: "" });
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(0);
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
		expect(speakTexts.length).toBe(1);
	});

	test("a tts.enabled change is part of the fingerprint and re-arms the listener", async () => {
		// Install disabled — combo is parsed but maybeFire is gated off.
		install({ enabled: false });
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(0);
		// Flip enabled true, fire the subscription (fingerprint changed).
		storeValues["tts.enabled"] = true;
		fireTtsStoreChange();
		fireKeyUp(COMBO_KEYS[2] as number);
		fireKeyDown(COMBO_KEYS[2] as number);
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(1);
	});

	test("a no-op store change (identical fingerprint) does NOT rebuild the combo", async () => {
		install();
		consoleLogLines.length = 0;
		// Fire the subscription WITHOUT changing tts.hotkey / tts.enabled. The
		// fingerprint matches → early return, so rebuildCombo is skipped (no
		// "armed hotkey" dbg line is re-emitted for this notification).
		fireTtsStoreChange();
		// The existing combo still works (it was armed at install, not re-armed).
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(1);
	});

	test("changing only an unrelated tts.* key (voice) leaves the fingerprint stable", async () => {
		install();
		// voice/speed/lang are NOT part of the fingerprint — a change here fires
		// the subscription but must NOT trigger a rebuild (early return path).
		storeValues["tts.voice"] = "bf_emma";
		fireTtsStoreChange();
		holdCombo();
		await Promise.resolve();
		await Promise.resolve();
		expect(speakTexts.length).toBe(1);
	});
});
