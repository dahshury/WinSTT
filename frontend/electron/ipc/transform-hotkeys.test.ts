import { afterAll, describe, expect, mock, test } from "bun:test";
import { electronMock } from "../../test/mocks/electron";
import { storeMock } from "../../test/mocks/store";

mock.module("electron", () => electronMock());

type UioListener = (event: { keycode: number }) => void;

const uioListeners: { keydown: UioListener[]; keyup: UioListener[] } = {
	keydown: [],
	keyup: [],
};

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
	UiohookKey: {
		Ctrl: 29,
		Shift: 42,
		Alt: 56,
		P: 25,
	},
}));

const storeValues: Record<string, unknown> = {};
const storeChangeListeners: Array<() => void> = [];
mock.module("../lib/store", () => {
	const base = storeMock();
	// Keep getStoreValue / store.get / store.set internally consistent and
	// backed by the SAME `storeValues` object. bun's `mock.module` registry is
	// process-global, so this mock can leak into sibling tests (e.g.
	// transforms.test.ts, which writes `llm.transforms` via store.set then
	// reads it via the real applyTransform's getStoreValue). A split backing
	// (set→base, get→storeValues) would silently drop those writes.
	const readKey = (key: string): unknown =>
		key in storeValues ? storeValues[key] : base.getStoreValue(key);
	return {
		...base,
		getStoreValue: readKey,
		store: {
			...base.store,
			get: readKey,
			set: (key: string, value: unknown) => {
				storeValues[key] = value;
			},
			onDidChange: (_key: string, cb: () => void) => {
				storeChangeListeners.push(cb);
				return () => {
					const idx = storeChangeListeners.indexOf(cb);
					if (idx !== -1) {
						storeChangeListeners.splice(idx, 1);
					}
				};
			},
		},
	};
});

let applyCallCount = 0;
let applyTransformShouldReject = false;
let applyTransformRejectWithString = false;

// Pull the REAL `./transforms` surface in via a distinct specifier (resolves
// to the same absolute file but is NOT keyed to the `./transforms` mock we
// install next). bun's `mock.module` registry is process-global, so a partial
// `{ applyTransform }` mock here would leak into transforms.test.ts (which
// `await import("./transforms")` and needs `__transforms_test_helpers__` /
// `setupTransforms`). Spreading the real module keeps the leak harmless —
// only `applyTransform` is overridden with this file's controllable stub.
const realTransforms = await import("../ipc/transforms");

mock.module("./transforms", () => ({
	...realTransforms,
	applyTransform: () => {
		applyCallCount += 1;
		if (applyTransformRejectWithString) {
			// Reject with a non-Error to exercise the String(err) branch in the
			// .catch handler's err instanceof Error check.
			return Promise.reject("string failure");
		}
		if (applyTransformShouldReject) {
			return Promise.reject(new Error("mock failure"));
		}
		return Promise.resolve({ before: "", after: "", source: "empty" });
	},
}));

const { __transform_hotkeys_test_helpers__: helpers, setupTransformHotkeys } = await import(
	"./transform-hotkeys"
);

// `./transforms` is a SIBLING module. We mock it above only to stub
// `applyTransform`, but bun's `mock.module` registry is process-global and
// persists into transforms.test.ts (which runs next alphabetically and tests
// the GENUINE module via `await import`). Re-register the real module after
// this file finishes so the sibling's `await import("../ipc/transforms")`
// resolves to the authentic surface (same pattern transforms.test.ts uses to
// restore `./llm` and `../ipc/hotkey`).
afterAll(() => {
	mock.module("./transforms", () => realTransforms);
});

function reset(): void {
	for (const key of Object.keys(storeValues)) {
		delete storeValues[key];
	}
	applyCallCount = 0;
	applyTransformShouldReject = false;
	applyTransformRejectWithString = false;
	uioListeners.keydown.length = 0;
	uioListeners.keyup.length = 0;
	storeChangeListeners.length = 0;
	helpers.resetForTesting();
}

function setHotkey(hotkey: string): void {
	storeValues["llm.transforms.hotkey"] = hotkey;
	// `loadHotkey()` now arms the combo ONLY while the transforms feature is
	// enabled (otherwise pressing Ctrl+Shift+T while off would spam a "feature
	// disabled" failure). Enable the feature here so the combo-building tests
	// below — which all expect a real combo from a non-empty hotkey — see the
	// armed state. The gate (`enabled === false` ⇒ no combo) is covered by its
	// own focused test that sets these two fields independently.
	storeValues["llm.transforms.enabled"] = true;
}

function setEnabled(enabled: boolean): void {
	storeValues["llm.transforms.enabled"] = enabled;
}

describe("transform-hotkeys: combo matching", () => {
	test("rebuildCombo clears the combo when the hotkey is empty", () => {
		reset();
		setHotkey("");
		helpers.rebuildCombo();
		expect(helpers.getCombo()).toBeNull();
	});

	test("rebuildCombo clears the combo when the hotkey is unparseable", () => {
		reset();
		setHotkey("LCtrl+NotAKey");
		helpers.rebuildCombo();
		expect(helpers.getCombo()).toBeNull();
	});

	test("rebuildCombo registers a parseable hotkey", () => {
		reset();
		setHotkey("LCtrl+LShift+P");
		helpers.rebuildCombo();
		const combo = helpers.getCombo();
		expect(combo).not.toBeNull();
		expect(combo?.size).toBe(3);
	});

	test("rebuildCombo leaves the combo unarmed when the feature is disabled even with a hotkey set", () => {
		// The hotkey string is always present (schema default Ctrl+Shift+T), but a
		// disabled feature must NOT capture the global combo: Ctrl+Shift+T is a
		// common shortcut (reopen-closed-tab) and `applyTransform` would broadcast
		// a "feature disabled" failure on every press. `loadHotkey()` returns ""
		// while `llm.transforms.enabled !== true`, so no combo is armed.
		reset();
		// A valid, parseable hotkey is present — only the disabled flag suppresses it.
		storeValues["llm.transforms.hotkey"] = "LCtrl+LShift+P";
		setEnabled(false);
		helpers.rebuildCombo();
		expect(helpers.getCombo()).toBeNull();

		// Flipping enabled to true arms the same hotkey into a real combo.
		setEnabled(true);
		helpers.rebuildCombo();
		const combo = helpers.getCombo();
		expect(combo).not.toBeNull();
		expect(combo?.size).toBe(3);
	});

	test("fires applyTransform when the full combo becomes held", () => {
		reset();
		setHotkey("LCtrl+LShift+P");
		helpers.rebuildCombo();
		const combo = helpers.getCombo();
		expect(combo).not.toBeNull();
		if (!combo) {
			return;
		}
		const keys = Array.from(combo);
		// Press them in sequence; the last keydown should trigger the fire.
		helpers.handleKeyDown({ keycode: keys[0] as number });
		expect(applyCallCount).toBe(0);
		helpers.handleKeyDown({ keycode: keys[1] as number });
		expect(applyCallCount).toBe(0);
		helpers.handleKeyDown({ keycode: keys[2] as number });
		expect(applyCallCount).toBe(1);
	});

	test("does NOT re-fire while combo stays held (auto-repeat guard)", () => {
		reset();
		setHotkey("LCtrl+LShift+P");
		helpers.rebuildCombo();
		const combo = helpers.getCombo();
		if (!combo) {
			return;
		}
		const keys = Array.from(combo);
		helpers.handleKeyDown({ keycode: keys[0] as number });
		helpers.handleKeyDown({ keycode: keys[1] as number });
		helpers.handleKeyDown({ keycode: keys[2] as number });
		// Simulate a stuck auto-repeat key — same keydown re-arrives.
		helpers.handleKeyDown({ keycode: keys[2] as number });
		helpers.handleKeyDown({ keycode: keys[2] as number });
		expect(applyCallCount).toBe(1);
	});

	test("re-fires after releasing and re-pressing", () => {
		reset();
		setHotkey("LCtrl+LShift+P");
		helpers.rebuildCombo();
		const combo = helpers.getCombo();
		if (!combo) {
			return;
		}
		const keys = Array.from(combo);
		// First fire
		for (const k of keys) {
			helpers.handleKeyDown({ keycode: k as number });
		}
		expect(applyCallCount).toBe(1);
		// Release one
		helpers.handleKeyUp({ keycode: keys[2] as number });
		// Re-press the released key
		helpers.handleKeyDown({ keycode: keys[2] as number });
		expect(applyCallCount).toBe(2);
	});

	test("handleKeyUp clears fired flag once combo is no longer fully held", () => {
		reset();
		setHotkey("LCtrl+LShift+P");
		helpers.rebuildCombo();
		const combo = helpers.getCombo();
		if (!combo) {
			return;
		}
		const keys = Array.from(combo);
		for (const k of keys) {
			helpers.handleKeyDown({ keycode: k as number });
		}
		expect(helpers.getFired()).toBe(true);
		helpers.handleKeyUp({ keycode: keys[0] as number });
		expect(helpers.getFired()).toBe(false);
	});

	test("handleKeyUp leaves fired flag intact when combo is still fully held", () => {
		reset();
		setHotkey("LCtrl+LShift+P");
		helpers.rebuildCombo();
		const combo = helpers.getCombo();
		if (!combo) {
			return;
		}
		const keys = Array.from(combo);
		for (const k of keys) {
			helpers.handleKeyDown({ keycode: k as number });
		}
		// Releasing a key NOT in the combo must not touch the fired flag.
		helpers.handleKeyUp({ keycode: 9999 });
		expect(helpers.getFired()).toBe(true);
	});

	test("handleKeyDown/Up are short-circuited while the paste guard is active", async () => {
		// Synthetic keystrokes from `winstt-paste.exe --type` arrive at the
		// uiohook listener at 2 events per char. Without the guard check this
		// handler does `pressed.add` + `maybeFireCombo` per event — a 500-char
		// transcript = 1000 needless iterations. Verify the early-return path
		// (1) doesn't grow the `pressed` set with synthetic keycodes, and (2)
		// doesn't accidentally fire the combo while the guard is active.
		const { setPasteGuard } = await import("./hotkey");
		reset();
		setHotkey("LCtrl+LShift+P");
		helpers.rebuildCombo();
		const combo = helpers.getCombo();
		if (!combo) {
			return;
		}
		const keys = Array.from(combo);
		const pressedBefore = helpers.getPressed().size;
		const firedBefore = helpers.getFired();
		setPasteGuard(true);
		try {
			for (const k of keys) {
				helpers.handleKeyDown({ keycode: k as number });
			}
			expect(helpers.getPressed().size).toBe(pressedBefore);
			expect(applyCallCount).toBe(0);
			expect(helpers.getFired()).toBe(firedBefore);
			for (const k of keys) {
				helpers.handleKeyUp({ keycode: k as number });
			}
			expect(helpers.getPressed().size).toBe(pressedBefore);
		} finally {
			setPasteGuard(false);
		}
	});
});

describe("transform-hotkeys: applyTransform rejection", () => {
	test("swallows applyTransform rejection without crashing", async () => {
		reset();
		applyTransformShouldReject = true;
		setHotkey("LCtrl+LShift+P");
		helpers.rebuildCombo();
		const combo = helpers.getCombo();
		if (!combo) {
			return;
		}
		for (const k of Array.from(combo)) {
			helpers.handleKeyDown({ keycode: k as number });
		}
		expect(applyCallCount).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(helpers.getFired()).toBe(true);
	});

	test("rejection .catch logs a non-Error value via String() branch", async () => {
		reset();
		applyTransformRejectWithString = true;
		setHotkey("LCtrl+LShift+P");
		helpers.rebuildCombo();
		const combo = helpers.getCombo();
		if (!combo) {
			return;
		}
		for (const k of Array.from(combo)) {
			helpers.handleKeyDown({ keycode: k as number });
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(applyCallCount).toBe(1);
	});
});

describe("transform-hotkeys: setup / cleanup lifecycle", () => {
	test("setupTransformHotkeys installs uIOhook listeners and a store subscription", () => {
		reset();
		setHotkey("LCtrl+LShift+P");
		const handle = setupTransformHotkeys();
		expect(uioListeners.keydown.length).toBe(1);
		expect(uioListeners.keyup.length).toBe(1);
		expect(storeChangeListeners.length).toBe(1);
		expect(helpers.getCombo()).not.toBeNull();
		handle.dispose();
		expect(uioListeners.keydown.length).toBe(0);
		expect(uioListeners.keyup.length).toBe(0);
		expect(storeChangeListeners.length).toBe(0);
	});

	test("setupTransformHotkeys is idempotent on a second call", () => {
		reset();
		setHotkey("LCtrl+LShift+P");
		const first = setupTransformHotkeys();
		const second = setupTransformHotkeys();
		expect(uioListeners.keydown.length).toBe(1);
		expect(uioListeners.keyup.length).toBe(1);
		expect(storeChangeListeners.length).toBe(1);
		first.dispose();
		second.dispose();
		expect(uioListeners.keydown.length).toBe(0);
	});

	test("store change re-runs rebuildCombo via the subscription callback", () => {
		reset();
		setHotkey("LCtrl+LShift+P");
		const handle = setupTransformHotkeys();
		expect(helpers.getCombo()).not.toBeNull();
		// Mutate the hotkey to empty and fire the change notification.
		setHotkey("");
		for (const cb of storeChangeListeners.slice()) {
			cb();
		}
		expect(helpers.getCombo()).toBeNull();
		handle.dispose();
	});

	test("dispose() called twice — second call is a safe no-op", () => {
		reset();
		setHotkey("");
		const handle = setupTransformHotkeys();
		handle.dispose();
		expect(() => handle.dispose()).not.toThrow();
		expect(uioListeners.keydown.length).toBe(0);
	});

	test("end-to-end: a keydown emitted via uIOhook fires the registered transform", () => {
		reset();
		setHotkey("LCtrl+LShift+P");
		const handle = setupTransformHotkeys();
		const combo = helpers.getCombo();
		if (!combo) {
			handle.dispose();
			return;
		}
		const keys = Array.from(combo);
		const listener = uioListeners.keydown[0];
		expect(listener).toBeDefined();
		if (!listener) {
			handle.dispose();
			return;
		}
		for (const k of keys) {
			listener({ keycode: k as number });
		}
		expect(applyCallCount).toBe(1);
		handle.dispose();
	});
});
