import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { asInvalid } from "@test/lib/cast";
import { electronMock } from "@test/mocks/electron";

// ─── Mock infrastructure ────────────────────────────────────────────────
// onboarding-window.ts constructs `new BrowserWindow(...)`, reads the primary
// display's `workArea`, and forwards external links to `shell.openExternal`.
// The default electronMock()'s `screen.getPrimaryDisplay()` returns
// `{ workAreaSize, bounds }` but NO `workArea` — and centerOnPrimaryDisplay
// destructures `display.workArea`, so we override screen to include it.

type EvtCb = (...args: unknown[]) => void;

const createdWindows: MockBrowserWindow[] = [];

class MockBrowserWindow {
	static getAllWindows = () => [];

	opts: Record<string, unknown>;
	destroyed = false;
	destroyCalls = 0;
	closeCalls = 0;
	showCalls = 0;
	focusCalls = 0;
	loadUrlCalls: string[] = [];
	loadFileCalls: string[] = [];
	// Whether loadRendererPage's promise should reject (to drive logLoadError).
	loadRejects = false;
	listeners = new Map<string, EvtCb[]>();
	onceListeners = new Map<string, EvtCb[]>();
	webContents = {
		willNavigate: null as EvtCb | null,
		windowOpenHandler: null as ((d: { url: string }) => unknown) | null,
		on: (event: string, cb: EvtCb) => {
			if (event === "will-navigate") {
				this.webContents.willNavigate = cb;
			}
		},
		setWindowOpenHandler: (cb: (d: { url: string }) => unknown) => {
			this.webContents.windowOpenHandler = cb;
		},
	};

	constructor(opts: Record<string, unknown>) {
		this.opts = opts;
		createdWindows.push(this);
	}

	isDestroyed() {
		return this.destroyed;
	}
	destroy() {
		this.destroyCalls++;
		this.destroyed = true;
	}
	close() {
		this.closeCalls++;
		// Real Electron emits the `close` event when close() is invoked. The
		// production handler relies on the close listener seeing finishedOnce.
		this.emit("close");
	}
	show() {
		this.showCalls++;
	}
	focus() {
		this.focusCalls++;
	}
	on(event: string, cb: EvtCb) {
		const list = this.listeners.get(event) ?? [];
		list.push(cb);
		this.listeners.set(event, list);
	}
	once(event: string, cb: EvtCb) {
		const list = this.onceListeners.get(event) ?? [];
		list.push(cb);
		this.onceListeners.set(event, list);
	}
	loadURL(url: string) {
		this.loadUrlCalls.push(url);
		return this.loadRejects ? Promise.reject(new Error("load-url-failed")) : Promise.resolve();
	}
	loadFile(path: string) {
		this.loadFileCalls.push(path);
		return this.loadRejects ? Promise.reject(new Error("load-file-failed")) : Promise.resolve();
	}

	/** Fire all listeners registered for `event` (simulates Electron emitting). */
	emit(event: string): void {
		for (const cb of this.listeners.get(event) ?? []) {
			cb();
		}
	}
	/** Fire all once-listeners registered for `event`. */
	emitOnce(event: string): void {
		for (const cb of this.onceListeners.get(event) ?? []) {
			cb();
		}
	}
}

// Single boundary cast: at runtime the production code instantiates exactly
// this MockBrowserWindow class under the module mock.
const asElectronCtor = (Ctor: typeof MockBrowserWindow) =>
	Ctor as unknown as typeof import("electron").BrowserWindow;

const shellOpenExternalCalls: string[] = [];
let shellOpenExternalRejects = false;

// Build ONE electron mock handle and reuse it across every `import "electron"`.
// The production module captures its `ipcMain` reference at load time; we need
// the SAME `ipcMain._listeners` map to read back the registered handleFinish.
const electronHandle = {
	...electronMock(),
	BrowserWindow: asElectronCtor(MockBrowserWindow),
	screen: {
		getPrimaryDisplay: () => ({
			workArea: { x: 0, y: 0, width: 1920, height: 1080 },
			workAreaSize: { width: 1920, height: 1080 },
			bounds: { x: 0, y: 0, width: 1920, height: 1080 },
			scaleFactor: 1,
		}),
		getAllDisplays: () => [],
	},
	shell: {
		openExternal: (url: string) => {
			shellOpenExternalCalls.push(url);
			return shellOpenExternalRejects
				? Promise.reject(new Error("open-external-failed"))
				: Promise.resolve();
		},
	},
};

mock.module("electron", () => electronHandle);

// Spy on store.set so we can assert the exact keys/values written, in order.
const storeSetCalls: Array<{ key: string; value: unknown }> = [];
const storeData: Record<string, unknown> = {};

mock.module("../lib/store", () => ({
	store: {
		set: (key: string, value: unknown) => {
			storeSetCalls.push({ key, value });
			storeData[key] = value;
		},
		get: (key: string) => storeData[key],
	},
}));

// Capture dbg() output. test/preload.ts installs a console-transport buffer
// that captures every electron-log level, so dbg("onboarding", …) lands here.
const logLines = (globalThis as unknown as { __testLogLines: string[] }).__testLogLines;
function logContains(needle: string): boolean {
	return logLines.some((line) => line.includes(needle));
}

const onboarding = await import("./onboarding-window");
const { createOnboardingWindow, setupOnboardingHandlers } = onboarding;

// IPC channel literal — mirror of IPC.ONBOARDING_FINISH so a typo in the
// production constant is caught against the spec value.
const ONBOARDING_FINISH = "onboarding:finish";

// ─── Test scaffolding ───────────────────────────────────────────────────
// The module holds `onboardingWindow` / `onFinishCallback` / `finishedOnce`
// at module scope. We funnel every test through one setup → teardown cycle so
// no module-level state leaks between tests.
let activeTeardown: (() => void) | null = null;
let finishCallbackCount = 0;

function setup(): void {
	finishCallbackCount = 0;
	activeTeardown = setupOnboardingHandlers({
		onFinish: () => {
			finishCallbackCount++;
		},
	});
}

// `finishedOnce` is module-level state that is reset to `false` ONLY inside
// `createOnboardingWindow`. Several tests fire a finish (which flips it true)
// without re-creating a window, so to isolate each test we reset the flag via
// the public API: create a throwaway window (resets the flag), destroy it (so
// `isWindowAlive(onboardingWindow)` is false again), then null the module's
// window reference by running a setup/teardown cycle.
function resetModuleState(): void {
	const teardown = setupOnboardingHandlers({ onFinish: () => undefined });
	createOnboardingWindow(); // flips finishedOnce → false
	teardown(); // destroys the window + nulls onboardingWindow + nulls callback
}

beforeEach(() => {
	resetModuleState(); // clears the leaked `finishedOnce` flag
	createdWindows.length = 0;
	storeSetCalls.length = 0;
	for (const k of Object.keys(storeData)) {
		delete storeData[k];
	}
	shellOpenExternalCalls.length = 0;
	shellOpenExternalRejects = false;
	logLines.length = 0;
});

afterEach(() => {
	activeTeardown?.();
	activeTeardown = null;
});

const fakeEvent = {} as unknown;

// ─── Public API surface ─────────────────────────────────────────────────

describe("onboarding-window public API", () => {
	test("exports createOnboardingWindow + setupOnboardingHandlers", () => {
		expect(typeof createOnboardingWindow).toBe("function");
		expect(typeof setupOnboardingHandlers).toBe("function");
	});
});

// ─── createOnboardingWindow ─────────────────────────────────────────────

describe("createOnboardingWindow", () => {
	test("constructs exactly one BrowserWindow with the expected geometry/flags", () => {
		setup();
		const win = createOnboardingWindow();
		expect(createdWindows.length).toBe(1);
		expect(win).toBe(createdWindows[0] as unknown as Electron.BrowserWindow);

		const opts = createdWindows[0]?.opts ?? {};
		expect(opts.title).toBe("Welcome to WinSTT");
		expect(opts.width).toBe(720);
		expect(opts.height).toBe(620);
		expect(opts.minWidth).toBe(600);
		expect(opts.minHeight).toBe(560);
		expect(opts.frame).toBe(false);
		expect(opts.show).toBe(false);
		expect(opts.resizable).toBe(true);
		expect(opts.maximizable).toBe(false);
		expect(opts.fullscreenable).toBe(false);
		expect(opts.backgroundColor).toBe("#09090b");
		// Centered: workArea 1920×1080, window 720×620 → x=(1920-720)/2=600,
		// y=(1080-620)/2=230.
		expect(opts.x).toBe(600);
		expect(opts.y).toBe(230);
		// webPreferences hardening.
		const wp = opts.webPreferences as Record<string, unknown>;
		expect(wp.contextIsolation).toBe(true);
		expect(wp.nodeIntegration).toBe(false);
		expect(wp.sandbox).toBe(true);
	});

	test("sets an icon on win32 and omits it on other platforms (getWindowIconPath branches)", () => {
		const original = process.platform;
		const setPlatform = (p: NodeJS.Platform) =>
			Object.defineProperty(process, "platform", { value: p, configurable: true });
		try {
			// win32 → icon present.
			setPlatform("win32");
			resetModuleState();
			createdWindows.length = 0;
			setup();
			createOnboardingWindow();
			expect(typeof createdWindows[0]?.opts.icon).toBe("string");
			expect(String(createdWindows[0]?.opts.icon)).toContain("icon.ico");
			activeTeardown?.();
			activeTeardown = null;

			// non-win32 → getWindowIconPath returns undefined, so `icon` is absent.
			setPlatform("linux");
			resetModuleState();
			createdWindows.length = 0;
			setup();
			createOnboardingWindow();
			expect("icon" in (createdWindows[0]?.opts ?? {})).toBe(false);
		} finally {
			Object.defineProperty(process, "platform", { value: original, configurable: true });
		}
	});

	test("uses the packaged resources icon path when app.isPackaged (win32)", () => {
		const originalPlatform = process.platform;
		const originalPackaged = electronHandle.app.isPackaged;
		const originalResourcesPath = process.resourcesPath;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		electronHandle.app.isPackaged = true;
		Object.defineProperty(process, "resourcesPath", {
			value: "/mock/resources",
			configurable: true,
		});
		try {
			resetModuleState();
			createdWindows.length = 0;
			setup();
			createOnboardingWindow();
			const icon = String(createdWindows[0]?.opts.icon);
			expect(icon).toContain("resources");
			expect(icon).toContain("renderer");
			expect(icon).toContain("icon.ico");
		} finally {
			Object.defineProperty(process, "platform", {
				value: originalPlatform,
				configurable: true,
			});
			electronHandle.app.isPackaged = originalPackaged;
			Object.defineProperty(process, "resourcesPath", {
				value: originalResourcesPath,
				configurable: true,
			});
		}
	});

	test("returns the existing window on a second call (idempotent, no double-construct)", () => {
		setup();
		const first = createOnboardingWindow();
		const second = createOnboardingWindow();
		expect(second).toBe(first);
		expect(createdWindows.length).toBe(1);
	});

	test("rebuilds when the previous window was destroyed (isWindowAlive false branch)", () => {
		setup();
		createOnboardingWindow();
		expect(createdWindows.length).toBe(1);
		// Destroy it the way teardown would, then re-open.
		createdWindows[0]?.destroy();
		const next = createOnboardingWindow();
		expect(createdWindows.length).toBe(2);
		expect(next).toBe(createdWindows[1] as unknown as Electron.BrowserWindow);
	});

	test("wires will-navigate, window-open, ready-to-show, and close listeners", () => {
		setup();
		createOnboardingWindow();
		const w = createdWindows[0];
		expect(w?.webContents.willNavigate).toBeTypeOf("function");
		expect(w?.webContents.windowOpenHandler).toBeTypeOf("function");
		expect(w?.onceListeners.get("ready-to-show")?.length).toBe(1);
		expect(w?.listeners.get("close")?.length).toBe(1);
	});

	test("ready-to-show shows then focuses the window", () => {
		setup();
		createOnboardingWindow();
		const w = createdWindows[0];
		expect(w?.showCalls).toBe(0);
		w?.emitOnce("ready-to-show");
		expect(w?.showCalls).toBe(1);
		expect(w?.focusCalls).toBe(1);
	});

	test("loads the onboarding renderer page (dev path → loadURL)", () => {
		setup();
		createOnboardingWindow();
		const w = createdWindows[0];
		// app.isPackaged is false and WINSTT_E2E unset → loadURL(dev URL).
		expect(w?.loadUrlCalls.length).toBe(1);
		expect(w?.loadUrlCalls[0]).toContain("windows/onboarding.html");
	});

	test("logs (does not throw) when the renderer page fails to load", async () => {
		setup();
		// Pre-arm the next constructed window to reject its load.
		// We can't reach the instance before construction, so construct, then
		// re-trigger: instead, flip the static and rebuild.
		MockBrowserWindow.prototype.loadURL = function loadURL(this: MockBrowserWindow, url: string) {
			this.loadUrlCalls.push(url);
			return Promise.reject(new Error("load-url-failed"));
		};
		try {
			createOnboardingWindow();
			// Let the rejected promise's .catch(logLoadError) run.
			await Promise.resolve();
			await Promise.resolve();
			expect(logContains("Failed to load onboarding window")).toBe(true);
			expect(logContains("load-url-failed")).toBe(true);
		} finally {
			// Restore so later tests get the resolving variant.
			MockBrowserWindow.prototype.loadURL = function loadURL(this: MockBrowserWindow, url: string) {
				this.loadUrlCalls.push(url);
				return Promise.resolve();
			};
		}
	});
});

// ─── window-open handler (external links) ───────────────────────────────

describe("window-open handler", () => {
	test("forwards http(s) links to shell.openExternal and denies the in-app open", () => {
		setup();
		createOnboardingWindow();
		const handler = createdWindows[0]?.webContents.windowOpenHandler;
		const res = handler?.({ url: "https://winstt.app/docs" });
		expect(res).toEqual({ action: "deny" });
		expect(shellOpenExternalCalls).toEqual(["https://winstt.app/docs"]);
	});

	test("denies non-http schemes WITHOUT calling shell.openExternal", () => {
		setup();
		createOnboardingWindow();
		const handler = createdWindows[0]?.webContents.windowOpenHandler;
		const res = handler?.({ url: "javascript:alert(1)" });
		expect(res).toEqual({ action: "deny" });
		expect(shellOpenExternalCalls.length).toBe(0);
	});

	test("swallows a rejected shell.openExternal (no unhandled rejection)", async () => {
		setup();
		shellOpenExternalRejects = true;
		createOnboardingWindow();
		const handler = createdWindows[0]?.webContents.windowOpenHandler;
		expect(() => handler?.({ url: "http://example.com" })).not.toThrow();
		await Promise.resolve();
		expect(shellOpenExternalCalls).toEqual(["http://example.com"]);
	});
});

// ─── will-navigate guard ────────────────────────────────────────────────

describe("will-navigate guard", () => {
	test("prevents navigation to a disallowed (external) URL", () => {
		setup();
		createOnboardingWindow();
		let prevented = 0;
		const ev = { preventDefault: () => prevented++ } as unknown as Electron.Event;
		createdWindows[0]?.webContents.willNavigate?.(ev, "http://evil.test/phish");
		expect(prevented).toBe(1);
	});

	test("allows navigation to the dev-server origin (no preventDefault)", () => {
		setup();
		createOnboardingWindow();
		let prevented = 0;
		const ev = { preventDefault: () => prevented++ } as unknown as Electron.Event;
		createdWindows[0]?.webContents.willNavigate?.(
			ev,
			"http://localhost:3000/windows/onboarding.html"
		);
		expect(prevented).toBe(0);
	});
});

// ─── close listener (the "skip via X" path) ─────────────────────────────

describe("close listener (skip path)", () => {
	test("closing via the OS chrome marks onboarded with track='' completed-skip + fires onFinish", () => {
		setup();
		createOnboardingWindow();
		const w = createdWindows[0];
		expect(finishCallbackCount).toBe(0);

		w?.emit("close");

		// Three store writes, in order: onboarded=true, onboardedAt=<ts>, track="".
		expect(storeSetCalls.map((c) => c.key)).toEqual([
			"general.onboarded",
			"general.onboardedAt",
			"general.onboardedTrack",
		]);
		expect(storeData["general.onboarded"]).toBe(true);
		expect(typeof storeData["general.onboardedAt"]).toBe("number");
		expect(storeData["general.onboardedTrack"]).toBe("");
		// onFinish fired exactly once.
		expect(finishCallbackCount).toBe(1);
	});

	test("a second close is a no-op (finishedOnce guard prevents double onFinish)", () => {
		setup();
		createOnboardingWindow();
		const w = createdWindows[0];
		w?.emit("close");
		storeSetCalls.length = 0;
		w?.emit("close");
		expect(storeSetCalls.length).toBe(0);
		expect(finishCallbackCount).toBe(1);
	});

	test("close does NOT fire onFinish if no handlers were set up (onFinishCallback null)", () => {
		// Drive createOnboardingWindow WITHOUT setupOnboardingHandlers — the
		// optional-chained callback must no-op. We must still tear down the
		// orphaned window manually since activeTeardown is null here.
		const win = createOnboardingWindow();
		const w = win as unknown as MockBrowserWindow;
		expect(() => w.emit("close")).not.toThrow();
		// Store still gets the skip write even without a callback.
		expect(storeData["general.onboarded"]).toBe(true);
		// Manual cleanup (no teardown registered).
		w.destroy();
		// Re-run setup so the module's `onboardingWindow` is cleared for the
		// next test via afterEach teardown.
		setup();
	});
});

// ─── handleFinish via the IPC listener ──────────────────────────────────
// setupOnboardingHandlers registers handleFinish through ipcMain.on against
// the process-global electron mock. We retrieve it from that mock's listener
// map and invoke it the way the real ipcMain would.

function getFinishListener(): ((event: unknown, payload: unknown) => void) | undefined {
	// handleFinish is registered on the shared electronHandle.ipcMain — the same
	// instance the production module captured at load time.
	return electronHandle.ipcMain._listeners.get(ONBOARDING_FINISH)?.[0] as
		| ((event: unknown, payload: unknown) => void)
		| undefined;
}

describe("handleFinish (IPC: onboarding:finish)", () => {
	test("setupOnboardingHandlers registers a listener on the finish channel", () => {
		setup();
		expect(getFinishListener()).toBeTypeOf("function");
	});

	test("re-arming setup without teardown does NOT stack a duplicate finish listener (idempotent)", () => {
		// Regression guard: ipcMain.on silently appends, so setup() off()s first.
		// Two setups back-to-back → still exactly one handleFinish listener.
		const t1 = setupOnboardingHandlers({ onFinish: () => undefined });
		const t2 = setupOnboardingHandlers({ onFinish: () => undefined });
		expect(electronHandle.ipcMain._listeners.get(ONBOARDING_FINISH)?.length).toBe(1);
		t1();
		t2();
	});

	test("teardown resets finishedOnce so a finish after re-arm is recorded (not stale-blocked)", () => {
		// First session: a valid finish flips module-level finishedOnce → true.
		setup();
		createOnboardingWindow();
		getFinishListener()?.(fakeEvent, { completed: true, track: "local" });
		expect(storeSetCalls.length).toBe(3);
		// Teardown must clear finishedOnce (its only other reset is inside
		// createOnboardingWindow). Re-arm WITHOUT a fresh window so we isolate
		// the teardown reset: a second valid finish must still be recorded
		// (3 more writes) instead of being silently dropped by a stale `true`.
		activeTeardown?.();
		setup();
		getFinishListener()?.(fakeEvent, { completed: true, track: "cloud" });
		expect(storeSetCalls.length).toBe(6);
		expect(storeData["general.onboardedTrack"]).toBe("cloud");
	});

	test("valid payload writes onboarded state, closes the window, and fires onFinish once", () => {
		setup();
		createOnboardingWindow();
		const w = createdWindows[0];
		const finish = getFinishListener();

		finish?.(fakeEvent, { completed: true, track: "local" });

		expect(storeSetCalls.map((c) => c.key)).toEqual([
			"general.onboarded",
			"general.onboardedAt",
			"general.onboardedTrack",
		]);
		expect(storeData["general.onboarded"]).toBe(true);
		expect(storeData["general.onboardedTrack"]).toBe("local");
		// The window is closed (handleFinish calls close(), NOT destroy()).
		expect(w?.closeCalls).toBe(1);
		expect(w?.destroyCalls).toBe(0);
		// close() fires the close listener, but because finishedOnce is already
		// true the listener does NOT re-write the store (still exactly 3 writes).
		expect(storeSetCalls.length).toBe(3);
		expect(finishCallbackCount).toBe(1);
		// dbg trace fired with the chosen track.
		expect(logContains("wizard finished")).toBe(true);
		expect(logContains("track=local")).toBe(true);
	});

	test("closing the window after a FINISH does not double-fire onFinish (finishedOnce)", () => {
		setup();
		createOnboardingWindow();
		const w = createdWindows[0];
		const finish = getFinishListener();
		finish?.(fakeEvent, { completed: true, track: "cloud" });
		const callsAfterFinish = finishCallbackCount;
		const writesAfterFinish = storeSetCalls.length;
		// Simulate the OS firing `close` after our own .close() call.
		w?.emit("close");
		expect(finishCallbackCount).toBe(callsAfterFinish);
		expect(storeSetCalls.length).toBe(writesAfterFinish);
	});

	test("accepts track='' (empty) as a valid finish payload", () => {
		setup();
		createOnboardingWindow();
		const finish = getFinishListener();
		finish?.(fakeEvent, { completed: false, track: "" });
		expect(storeData["general.onboarded"]).toBe(true);
		expect(storeData["general.onboardedTrack"]).toBe("");
		expect(finishCallbackCount).toBe(1);
	});

	test("accepts track='cloud' completed=false", () => {
		setup();
		createOnboardingWindow();
		const finish = getFinishListener();
		finish?.(fakeEvent, { completed: false, track: "cloud" });
		expect(storeData["general.onboardedTrack"]).toBe("cloud");
		expect(finishCallbackCount).toBe(1);
	});

	test("a second valid finish is ignored (finishedOnce returns early)", () => {
		setup();
		createOnboardingWindow();
		const finish = getFinishListener();
		finish?.(fakeEvent, { completed: true, track: "local" });
		storeSetCalls.length = 0;
		finish?.(fakeEvent, { completed: true, track: "cloud" });
		expect(storeSetCalls.length).toBe(0);
		// track stays at the first value; second call did not overwrite.
		expect(storeData["general.onboardedTrack"]).toBe("local");
		expect(finishCallbackCount).toBe(1);
	});

	test("finish with no live window still writes store + fires onFinish (isWindowAlive false branch)", () => {
		setup();
		// No createOnboardingWindow() → onboardingWindow stays null.
		const finish = getFinishListener();
		finish?.(fakeEvent, { completed: true, track: "local" });
		expect(storeData["general.onboarded"]).toBe(true);
		expect(finishCallbackCount).toBe(1);
	});
});

// ─── malformed payload rejection (isFinishPayload guard) ────────────────

describe("handleFinish malformed-payload guard", () => {
	const cases: Array<{ name: string; payload: unknown }> = [
		{ name: "null", payload: null },
		{ name: "undefined", payload: undefined },
		{ name: "non-object string", payload: "garbage" },
		{ name: "non-object number", payload: 42 },
		{ name: "missing completed", payload: { track: "local" } },
		{ name: "completed not a boolean", payload: { completed: "yes", track: "local" } },
		{ name: "invalid track value", payload: { completed: true, track: "premium" } },
		{ name: "track is a number", payload: { completed: true, track: 0 } },
		{ name: "missing track", payload: { completed: true } },
	];

	for (const { name, payload } of cases) {
		test(`rejects ${name} — no store writes, no onFinish, logs "malformed"`, () => {
			setup();
			createOnboardingWindow();
			const finish = getFinishListener();
			finish?.(fakeEvent, payload);
			expect(storeSetCalls.length).toBe(0);
			expect(finishCallbackCount).toBe(0);
		});
	}

	test("emits the 'malformed finish payload' dbg trace on bad input", () => {
		setup();
		const finish = getFinishListener();
		finish?.(fakeEvent, asInvalid<unknown>({ completed: 1, track: "local" }));
		expect(logContains("malformed finish payload")).toBe(true);
	});

	test("a rejected payload does NOT consume the finishedOnce slot (later valid finish still works)", () => {
		setup();
		createOnboardingWindow();
		const finish = getFinishListener();
		finish?.(fakeEvent, { completed: true, track: "premium" }); // rejected
		expect(storeSetCalls.length).toBe(0);
		finish?.(fakeEvent, { completed: true, track: "local" }); // valid
		expect(storeData["general.onboardedTrack"]).toBe("local");
		expect(finishCallbackCount).toBe(1);
	});
});

// ─── setupOnboardingHandlers teardown ───────────────────────────────────

describe("setupOnboardingHandlers teardown", () => {
	test("returns a function and unregisters the finish listener", () => {
		const teardown = setupOnboardingHandlers({ onFinish: () => undefined });
		expect(typeof teardown).toBe("function");
		expect(getFinishListener()).toBeTypeOf("function");
		teardown();
		expect(getFinishListener()).toBeUndefined();
		// Keep afterEach happy.
		activeTeardown = null;
	});

	test("teardown destroys a live onboarding window and nulls module state", () => {
		const teardown = setupOnboardingHandlers({ onFinish: () => undefined });
		createOnboardingWindow();
		const w = createdWindows[0];
		expect(w?.destroyed).toBe(false);
		teardown();
		expect(w?.destroyCalls).toBe(1);
		expect(w?.destroyed).toBe(true);
		// After teardown the next create builds a fresh window (state was nulled).
		const teardown2 = setupOnboardingHandlers({ onFinish: () => undefined });
		createOnboardingWindow();
		expect(createdWindows.length).toBe(2);
		teardown2();
		activeTeardown = null;
	});

	test("teardown is safe when there is no window (isWindowAlive false branch)", () => {
		const teardown = setupOnboardingHandlers({ onFinish: () => undefined });
		expect(() => teardown()).not.toThrow();
		activeTeardown = null;
	});

	test("teardown does NOT destroy an already-destroyed window twice", () => {
		const teardown = setupOnboardingHandlers({ onFinish: () => undefined });
		createOnboardingWindow();
		const w = createdWindows[0];
		w?.destroy(); // already destroyed
		expect(w?.destroyCalls).toBe(1);
		teardown();
		// isWindowAlive sees destroyed=true → no second destroy().
		expect(w?.destroyCalls).toBe(1);
		activeTeardown = null;
	});

	test("after teardown nulls onFinishCallback, a subsequent close cannot fire the old callback", () => {
		let count = 0;
		const teardown = setupOnboardingHandlers({
			onFinish: () => {
				count++;
			},
		});
		const win = createOnboardingWindow();
		const w = win as unknown as MockBrowserWindow;
		teardown(); // destroys window + nulls onFinishCallback
		// The destroyed window's close listener (if somehow re-fired) sees
		// finishedOnce=false but onFinishCallback=null → optional-chain no-op.
		w.emit("close");
		expect(count).toBe(0);
		activeTeardown = null;
	});
});
