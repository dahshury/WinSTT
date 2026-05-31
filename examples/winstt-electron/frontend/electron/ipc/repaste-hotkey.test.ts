import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { debugLogMock } from "@test/mocks/debug-log";
import { electronMock } from "@test/mocks/electron";

mock.module("../lib/debug-log", () => debugLogMock());

// ── Controllable electron globalShortcut mock ──────────────────────
interface RegisteredShortcut {
	accelerator: string;
	handler: () => void;
}
let registered: RegisteredShortcut | null = null;
let registerReturns = true;
let registerThrows = false;
let unregisterThrows = false;
const registerCalls: string[] = [];
const unregisterCalls: string[] = [];

// Spread `electronMock()` so the process-global mock leak this installs is
// semantically complete — partial shims would make every later test importing
// `app` / `BrowserWindow` / etc. from `electron` throw "Export named X not
// found". Only `globalShortcut` needs a custom impl here.
const base = electronMock();
mock.module("electron", () => ({
	...base,
	globalShortcut: {
		register: (accelerator: string, handler: () => void): boolean => {
			registerCalls.push(accelerator);
			if (registerThrows) {
				throw new Error("boom");
			}
			if (!registerReturns) {
				return false;
			}
			registered = { accelerator, handler };
			return true;
		},
		unregister: (accelerator: string): void => {
			unregisterCalls.push(accelerator);
			if (unregisterThrows) {
				throw new Error("unregister boom");
			}
			if (registered?.accelerator === accelerator) {
				registered = null;
			}
		},
	},
}));

// ── Controllable store mock (only what repaste-hotkey reads) ────────
// Spread `storeMock()` so the process-global mock leak this installs is
// semantically complete — partial shims would make every later test
// importing `getStoreValue` / `setStoreSecret` / etc. from `../lib/store`
// throw "Export named X not found". Only `store.get` / `store.onDidChange`
// need a custom impl here so the test can drive the hotkey value.
const baseStore = (await import("@test/mocks/store")).storeMock();
let repasteHotkeyValue = "LCtrl+LShift+V";
let storeChangeCb: (() => void) | null = null;
mock.module("../lib/store", () => ({
	...baseStore,
	store: {
		...baseStore.store,
		get: (key: string): unknown =>
			key === "general.repasteHotkey" ? repasteHotkeyValue : baseStore.store.get(key),
		onDidChange: (_key: string, cb: () => void) => {
			storeChangeCb = cb;
			return () => {
				storeChangeCb = null;
			};
		},
	},
}));

// ── pasteText capture ──────────────────────────────────────────────
// Spy on the real `pasteText` rather than mock-module-replacing the whole
// `../lib/paste` file. mock.module would install a process-global
// replacement that bun 1.3.6 can't isolate per file, poisoning
// `electron/lib/paste.test.ts` — that file imports the real `./paste` SUT
// and would crash with the stubbed `pasteText` instead of the real one.
// spyOn on the namespace flips the binding only for THIS file's lifetime
// and is restored in afterAll below.
const pasteCalls: string[] = [];
const pasteNs = await import("../lib/paste");
const pasteTextSpy = spyOn(pasteNs, "pasteText").mockImplementation((text: string) => {
	pasteCalls.push(text);
});

const { setupRepasteHotkey } = await import("./repaste-hotkey");
const { setLastTranscription, __resetLastTranscriptionForTesting__ } = await import(
	"../lib/last-transcription"
);

function fireStoreChange(): void {
	storeChangeCb?.();
}

let handle: { dispose: () => void } | null = null;

beforeEach(() => {
	registered = null;
	registerReturns = true;
	registerThrows = false;
	unregisterThrows = false;
	registerCalls.length = 0;
	unregisterCalls.length = 0;
	pasteCalls.length = 0;
	repasteHotkeyValue = "LCtrl+LShift+V";
	storeChangeCb = null;
	__resetLastTranscriptionForTesting__();
});

afterEach(() => {
	// Always tear down so the module's install latch / registration reset
	// between tests (mock.module state is process-global in bun).
	handle?.dispose();
	handle = null;
});

describe("setupRepasteHotkey", () => {
	test("registers the converted Electron accelerator on setup", () => {
		handle = setupRepasteHotkey();
		expect(registerCalls).toEqual(["Control+Shift+V"]);
		expect(registered?.accelerator).toBe("Control+Shift+V");
	});

	test("triggering the shortcut re-pastes the last transcription with trailing space", () => {
		setLastTranscription("hello there");
		handle = setupRepasteHotkey();
		registered?.handler();
		expect(pasteCalls).toEqual(["hello there "]);
	});

	test("triggering with no recorded transcription pastes nothing", () => {
		handle = setupRepasteHotkey();
		registered?.handler();
		expect(pasteCalls).toEqual([]);
	});

	test("empty hotkey leaves the shortcut unregistered (feature off)", () => {
		repasteHotkeyValue = "";
		handle = setupRepasteHotkey();
		expect(registerCalls).toEqual([]);
		expect(registered).toBeNull();
	});

	test("unconvertible hotkey is not registered", () => {
		repasteHotkeyValue = "LCtrl+CapsLock";
		handle = setupRepasteHotkey();
		expect(registerCalls).toEqual([]);
	});

	test("a failed register does not leave a dangling accelerator", () => {
		registerReturns = false;
		handle = setupRepasteHotkey();
		expect(registerCalls).toEqual(["Control+Shift+V"]);
		expect(registered).toBeNull();
		// dispose must not try to unregister something that never took.
		handle.dispose();
		handle = null;
		expect(unregisterCalls).toEqual([]);
	});

	test("a throwing register is swallowed", () => {
		registerThrows = true;
		expect(() => {
			handle = setupRepasteHotkey();
		}).not.toThrow();
		expect(registered).toBeNull();
	});

	test("changing the persisted hotkey rebinds (old unregistered, new registered)", () => {
		handle = setupRepasteHotkey();
		expect(registered?.accelerator).toBe("Control+Shift+V");
		repasteHotkeyValue = "LCtrl+LAlt+R";
		fireStoreChange();
		expect(unregisterCalls).toContain("Control+Shift+V");
		expect(registered?.accelerator).toBe("Control+Alt+R");
	});

	test("an unrelated general-settings change does not rebind", () => {
		handle = setupRepasteHotkey();
		registerCalls.length = 0;
		// Value unchanged → fingerprint identical → no rebuild.
		fireStoreChange();
		expect(registerCalls).toEqual([]);
	});

	test("a throwing unregister during rebind is swallowed", () => {
		handle = setupRepasteHotkey();
		unregisterThrows = true;
		repasteHotkeyValue = "LCtrl+LAlt+R";
		expect(() => {
			fireStoreChange();
		}).not.toThrow();
		// Despite the unregister throw, the new accelerator still registers.
		expect(registered?.accelerator).toBe("Control+Alt+R");
	});

	test("dispose unregisters the active accelerator", () => {
		handle = setupRepasteHotkey();
		handle.dispose();
		handle = null;
		expect(unregisterCalls).toContain("Control+Shift+V");
	});

	test("setup is idempotent — a second call does not double-register", () => {
		handle = setupRepasteHotkey();
		const again = setupRepasteHotkey();
		expect(registerCalls).toEqual(["Control+Shift+V"]);
		// The second handle still disposes cleanly.
		again.dispose();
		handle = null;
	});
});

// Restore the spy so `electron/lib/paste.test.ts` sees the real `pasteText`
// when it imports its SUT — bun shares module bindings across test files,
// so without this the stubbed impl would persist and break the paste suite.
afterAll(() => {
	pasteTextSpy.mockRestore();
});
