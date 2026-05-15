import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "../../test/mocks/electron";

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
mock.module("../lib/store", () => ({
	getStoreValue: (key: string) => storeValues[key],
	store: {
		get: (k: string) => storeValues[k],
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
}));

const applyCalls: string[] = [];
let applyTransformShouldReject = false;
let applyTransformRejectWithString = false;
mock.module("./transforms", () => ({
	applyTransform: (id: string) => {
		applyCalls.push(id);
		if (applyTransformRejectWithString) {
			// Reject with a non-Error to exercise the String(err) branch in the
			// .catch handler's err instanceof Error check.
			return Promise.reject("string failure");
		}
		if (applyTransformShouldReject) {
			return Promise.reject(new Error(`mock failure: ${id}`));
		}
		return Promise.resolve({ transformId: id, before: "", after: "", source: "empty" });
	},
}));

const { __transform_hotkeys_test_helpers__: helpers, setupTransformHotkeys } = await import(
	"./transform-hotkeys"
);

function reset(): void {
	for (const key of Object.keys(storeValues)) {
		delete storeValues[key];
	}
	applyCalls.length = 0;
	applyTransformShouldReject = false;
	applyTransformRejectWithString = false;
	uioListeners.keydown.length = 0;
	uioListeners.keyup.length = 0;
	storeChangeListeners.length = 0;
	helpers.resetForTesting();
}

describe("transform-hotkeys: combo matching", () => {
	test("rebuildCombos ignores transforms with empty hotkey", () => {
		reset();
		storeValues["llm.transforms"] = [
			{ id: "a", hotkey: "" },
			{ id: "b", hotkey: "LCtrl+LShift+P" },
		];
		helpers.rebuildCombos();
		expect(helpers.getCombos().length).toBe(1);
		expect(helpers.getCombos()[0]?.transformId).toBe("b");
	});

	test("rebuildCombos drops unparseable hotkeys", () => {
		reset();
		storeValues["llm.transforms"] = [
			{ id: "a", hotkey: "LCtrl+NotAKey" },
			{ id: "b", hotkey: "LCtrl+LShift+P" },
		];
		helpers.rebuildCombos();
		const ids = helpers.getCombos().map((c) => c.transformId);
		expect(ids).toEqual(["b"]);
	});

	test("fires applyTransform when full combo becomes held", () => {
		reset();
		storeValues["llm.transforms"] = [{ id: "polish", hotkey: "LCtrl+LShift+P" }];
		helpers.rebuildCombos();
		const combo = helpers.getCombos()[0];
		expect(combo).toBeDefined();
		if (!combo) {
			return;
		}
		const keys = Array.from(combo.combo);
		// Press them in sequence; the last keydown should trigger the fire.
		helpers.handleKeyDown({ keycode: keys[0] as number });
		expect(applyCalls.length).toBe(0);
		helpers.handleKeyDown({ keycode: keys[1] as number });
		expect(applyCalls.length).toBe(0);
		helpers.handleKeyDown({ keycode: keys[2] as number });
		expect(applyCalls).toEqual(["polish"]);
	});

	test("does NOT re-fire while combo stays held (auto-repeat guard)", () => {
		reset();
		storeValues["llm.transforms"] = [{ id: "polish", hotkey: "LCtrl+LShift+P" }];
		helpers.rebuildCombos();
		const combo = helpers.getCombos()[0];
		if (!combo) {
			return;
		}
		const keys = Array.from(combo.combo);
		helpers.handleKeyDown({ keycode: keys[0] as number });
		helpers.handleKeyDown({ keycode: keys[1] as number });
		helpers.handleKeyDown({ keycode: keys[2] as number });
		// Simulate a stuck auto-repeat key — same keydown re-arrives.
		helpers.handleKeyDown({ keycode: keys[2] as number });
		helpers.handleKeyDown({ keycode: keys[2] as number });
		expect(applyCalls.length).toBe(1);
	});

	test("re-fires after releasing and re-pressing", () => {
		reset();
		storeValues["llm.transforms"] = [{ id: "polish", hotkey: "LCtrl+LShift+P" }];
		helpers.rebuildCombos();
		const combo = helpers.getCombos()[0];
		if (!combo) {
			return;
		}
		const keys = Array.from(combo.combo);
		// First fire
		for (const k of keys) {
			helpers.handleKeyDown({ keycode: k as number });
		}
		expect(applyCalls.length).toBe(1);
		// Release one
		helpers.handleKeyUp({ keycode: keys[2] as number });
		// Re-press the released key
		helpers.handleKeyDown({ keycode: keys[2] as number });
		expect(applyCalls.length).toBe(2);
	});

	test("multiple transforms with valid combos register independently", () => {
		reset();
		storeValues["llm.transforms"] = [
			{ id: "polish", hotkey: "LCtrl+LShift+P" },
			// The second uses different modifiers to dodge UiohookKey-mock gaps —
			// the only thing this test cares about is "two combos register".
			{ id: "engineer", hotkey: "LCtrl+LAlt+P" },
		];
		helpers.rebuildCombos();
		expect(helpers.getCombos().length).toBe(2);
	});

	test("handleKeyUp clears fired flag once combo is no longer fully held", () => {
		reset();
		storeValues["llm.transforms"] = [{ id: "polish", hotkey: "LCtrl+LShift+P" }];
		helpers.rebuildCombos();
		const combo = helpers.getCombos()[0];
		if (!combo) {
			return;
		}
		const keys = Array.from(combo.combo);
		for (const k of keys) {
			helpers.handleKeyDown({ keycode: k as number });
		}
		expect(helpers.getFired().has("polish")).toBe(true);
		// Release one key — flag must clear because combo is no longer fully held.
		helpers.handleKeyUp({ keycode: keys[0] as number });
		expect(helpers.getFired().has("polish")).toBe(false);
	});

	test("handleKeyUp leaves fired flag intact when combo is still fully held", () => {
		reset();
		storeValues["llm.transforms"] = [{ id: "polish", hotkey: "LCtrl+LShift+P" }];
		helpers.rebuildCombos();
		const combo = helpers.getCombos()[0];
		if (!combo) {
			return;
		}
		const keys = Array.from(combo.combo);
		for (const k of keys) {
			helpers.handleKeyDown({ keycode: k as number });
		}
		// Releasing a key NOT in the combo must not touch the fired flag.
		helpers.handleKeyUp({ keycode: 9999 });
		expect(helpers.getFired().has("polish")).toBe(true);
	});

	test("handleKeyUp is a no-op for transforms that never fired", () => {
		reset();
		storeValues["llm.transforms"] = [{ id: "polish", hotkey: "LCtrl+LShift+P" }];
		helpers.rebuildCombos();
		const combo = helpers.getCombos()[0];
		if (!combo) {
			return;
		}
		const keys = Array.from(combo.combo);
		helpers.handleKeyDown({ keycode: keys[0] as number });
		// Combo never fully held → never fired → keyup should hit the early-continue.
		helpers.handleKeyUp({ keycode: keys[0] as number });
		expect(helpers.getFired().size).toBe(0);
	});
});

describe("transform-hotkeys: applyTransform rejection", () => {
	test("swallows applyTransform rejection without crashing", async () => {
		reset();
		applyTransformShouldReject = true;
		storeValues["llm.transforms"] = [{ id: "polish", hotkey: "LCtrl+LShift+P" }];
		helpers.rebuildCombos();
		const combo = helpers.getCombos()[0];
		if (!combo) {
			return;
		}
		const keys = Array.from(combo.combo);
		for (const k of keys) {
			helpers.handleKeyDown({ keycode: k as number });
		}
		expect(applyCalls).toEqual(["polish"]);
		// Flush the rejection through the microtask queue so the .catch handler runs.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(helpers.getFired().has("polish")).toBe(true);
	});

	test("rejection .catch logs a non-Error value via String() branch", async () => {
		reset();
		applyTransformRejectWithString = true;
		storeValues["llm.transforms"] = [{ id: "polish", hotkey: "LCtrl+LShift+P" }];
		helpers.rebuildCombos();
		const combo = helpers.getCombos()[0];
		if (!combo) {
			return;
		}
		for (const k of Array.from(combo.combo)) {
			helpers.handleKeyDown({ keycode: k as number });
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(applyCalls).toEqual(["polish"]);
	});
});

describe("transform-hotkeys: setup / cleanup lifecycle", () => {
	test("setupTransformHotkeys installs uIOhook listeners and a store subscription", () => {
		reset();
		storeValues["llm.transforms"] = [{ id: "polish", hotkey: "LCtrl+LShift+P" }];
		const handle = setupTransformHotkeys();
		expect(uioListeners.keydown.length).toBe(1);
		expect(uioListeners.keyup.length).toBe(1);
		expect(storeChangeListeners.length).toBe(1);
		expect(helpers.getCombos().length).toBe(1);
		handle.dispose();
		// Cleanup must remove every listener and the store subscription.
		expect(uioListeners.keydown.length).toBe(0);
		expect(uioListeners.keyup.length).toBe(0);
		expect(storeChangeListeners.length).toBe(0);
	});

	test("setupTransformHotkeys is idempotent on a second call", () => {
		reset();
		storeValues["llm.transforms"] = [{ id: "polish", hotkey: "LCtrl+LShift+P" }];
		const first = setupTransformHotkeys();
		const second = setupTransformHotkeys();
		// Second call must not install additional listeners.
		expect(uioListeners.keydown.length).toBe(1);
		expect(uioListeners.keyup.length).toBe(1);
		expect(storeChangeListeners.length).toBe(1);
		// Both handles must dispose cleanly (second is a no-op after first).
		first.dispose();
		second.dispose();
		expect(uioListeners.keydown.length).toBe(0);
	});

	test("store change re-runs rebuildCombos via the subscription callback", () => {
		reset();
		storeValues["llm.transforms"] = [{ id: "polish", hotkey: "LCtrl+LShift+P" }];
		const handle = setupTransformHotkeys();
		expect(helpers.getCombos().length).toBe(1);
		// Mutate the store and fire the change notification.
		storeValues["llm.transforms"] = [
			{ id: "polish", hotkey: "LCtrl+LShift+P" },
			{ id: "engineer", hotkey: "LCtrl+LAlt+P" },
		];
		for (const cb of storeChangeListeners.slice()) {
			cb();
		}
		expect(helpers.getCombos().length).toBe(2);
		handle.dispose();
	});

	test("dispose() called twice — second call is a safe no-op", () => {
		reset();
		storeValues["llm.transforms"] = [];
		const handle = setupTransformHotkeys();
		handle.dispose();
		// Second dispose hits the !listenerInstalled early-return guard.
		expect(() => handle.dispose()).not.toThrow();
		expect(uioListeners.keydown.length).toBe(0);
	});

	test("end-to-end: a keydown emitted via uIOhook fires the registered transform", () => {
		reset();
		storeValues["llm.transforms"] = [{ id: "polish", hotkey: "LCtrl+LShift+P" }];
		const handle = setupTransformHotkeys();
		const combo = helpers.getCombos()[0];
		if (!combo) {
			handle.dispose();
			return;
		}
		const keys = Array.from(combo.combo);
		const listener = uioListeners.keydown[0];
		expect(listener).toBeDefined();
		if (!listener) {
			handle.dispose();
			return;
		}
		for (const k of keys) {
			listener({ keycode: k as number });
		}
		expect(applyCalls).toEqual(["polish"]);
		handle.dispose();
	});
});
