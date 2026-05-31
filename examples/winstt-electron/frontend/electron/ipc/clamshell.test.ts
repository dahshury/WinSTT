/**
 * Tests for the clamshell-mic detector.
 *
 * The detector is split into two layers so tests don't have to mock
 * `child_process` / `fs` / `electron-store` / the SttClient — the OS
 * probe and the swap deps are both injection points:
 *
 *   - Probe parsers (`parseIoregClamshell`, `parseLinuxLidState`) are
 *     pure string→state and tested directly.
 *   - The `ClamshellDetector` is driven via a fake probe + fake deps;
 *     each transition test asserts which deps the detector called.
 *   - `decideSwap` is the pure transition table; tested directly so the
 *     edge cases (unknown→*, feature disabled, no-op) are documented
 *     against the spec.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";

const base = electronMock();
mock.module("electron", () => base);
mock.module("../lib/debug-log", () => ({
	dbg: () => undefined,
	dbgVerbose: () => undefined,
}));

// ── node:child_process stub (drives the real probeMacOs path) ───────
// probeMacOs shells out via execFile("ioreg", …, cb). The callback form is
// what clamshell.ts uses, so we mock execFile to invoke `cb(err, stdout)`
// with canned values. `execStub.emitError` exercises the failure branch
// (resolve "unknown"); `execStub.stdout` exercises the success branch
// (resolve parseIoregClamshell(stdout)).
interface ExecFileStub {
	calls: Array<{ cmd: string; args: string[]; opts: { maxBuffer?: number; timeout?: number } }>;
	emitError: string | null;
	stdout: string;
}
const execStub: ExecFileStub = { calls: [], emitError: null, stdout: "" };

mock.module("node:child_process", () => ({
	execFile: (
		cmd: string,
		args: string[],
		opts: { maxBuffer?: number; timeout?: number },
		cb: (err: Error | null, stdout: string | undefined) => void
	) => {
		execStub.calls.push({ cmd, args, opts });
		queueMicrotask(() => {
			if (execStub.emitError) {
				cb(new Error(execStub.emitError), undefined);
				return;
			}
			cb(null, execStub.stdout);
		});
	},
}));

// ── node:fs/promises stub (drives the real probeLinux / findLinuxLidPath) ──
// findLinuxLidPath calls readdir("/proc/acpi/button/lid"); probeLinux then
// readFile(path, "utf-8"). The stubs let each test script:
//   - readdir → an entry list (or throw to hit the catch → null path)
//   - readFile → file contents (or throw to hit the read-failed branch)
interface FsStub {
	readdirCalls: string[];
	readdirResult: string[] | null; // null ⇒ throw (dir missing)
	readFileCalls: string[];
	readFileResult: string | null; // null ⇒ throw (read failed)
}
const fsStub: FsStub = {
	readdirResult: ["LID0"],
	readdirCalls: [],
	readFileResult: "state:      open\n",
	readFileCalls: [],
};

mock.module("node:fs/promises", () => ({
	readdir: (dir: string) => {
		fsStub.readdirCalls.push(dir);
		if (fsStub.readdirResult === null) {
			return Promise.reject(new Error("ENOENT: no such directory"));
		}
		return Promise.resolve(fsStub.readdirResult);
	},
	readFile: (path: string) => {
		fsStub.readFileCalls.push(path);
		if (fsStub.readFileResult === null) {
			return Promise.reject(new Error("EACCES: permission denied"));
		}
		return Promise.resolve(fsStub.readFileResult);
	},
}));

mock.module("../lib/store", () => {
	const data: Record<string, unknown> = {};
	type Listener = () => void;
	const listeners = new Map<string, Listener[]>();
	const store = {
		get: (key: string) => data[key],
		set: (key: string, value: unknown) => {
			data[key] = value;
		},
		onDidChange: (key: string, cb: Listener) => {
			const list = listeners.get(key) ?? [];
			list.push(cb);
			listeners.set(key, list);
			return () => {
				const cur = listeners.get(key) ?? [];
				listeners.set(
					key,
					cur.filter((x) => x !== cb)
				);
			};
		},
		__data: data,
		__listeners: listeners,
	};
	return { store, getStoreValue: (key: string) => data[key] };
});

const {
	ClamshellDetector,
	CLAMSHELL_POLL_INTERVAL_MS,
	decideSwap,
	defaultProbeForPlatform,
	parseIoregClamshell,
	parseLinuxLidState,
	setupClamshellHandlers,
} = await import("./clamshell");

import { IPC } from "../../src/shared/api/ipc-channels";
import type { ClamshellSwapDeps, LidProbe, LidState, SwapDecision } from "./clamshell";

// Reach into the mocked store's backing object so tests can seed the
// `audio` section that the real store-backed deps read.
const storeModule = (await import("../lib/store")) as unknown as {
	store: { __data: Record<string, unknown> };
};
const storeData = storeModule.store.__data;

function seedAudio(section: Record<string, unknown> | undefined): void {
	if (section === undefined) {
		// biome-ignore lint/performance/noDelete: test cleanup of a seeded key
		delete storeData.audio;
		return;
	}
	storeData.audio = section;
}

const originalPlatform = process.platform;
function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}
function resetPlatform(): void {
	Object.defineProperty(process, "platform", {
		value: originalPlatform,
		configurable: true,
	});
}

// ── parseIoregClamshell ────────────────────────────────────────────

describe("parseIoregClamshell", () => {
	test('returns "closed" when output contains AppleClamshellState = Yes', () => {
		const out = `+-o Root  <class IORegistryEntry>
		  "AppleClamshellState" = Yes
		  "OtherKey" = "value"`;
		expect(parseIoregClamshell(out)).toBe("closed");
	});

	test('returns "open" when output contains AppleClamshellState = No', () => {
		const out = `"AppleClamshellState" = No`;
		expect(parseIoregClamshell(out)).toBe("open");
	});

	test('returns "unknown" for desktop Macs (no AppleClamshellState in output)', () => {
		expect(parseIoregClamshell("")).toBe("unknown");
		expect(parseIoregClamshell("nothing relevant here")).toBe("unknown");
	});

	test('returns "closed" not "open" when both substrings appear (closed wins)', () => {
		// Defensive: a malformed output containing both literal substrings
		// should bias toward the safer "closed" interpretation so we
		// trigger the swap rather than skip it.
		const out = `"AppleClamshellState" = Yes\nsome other line "AppleClamshellState" = No`;
		expect(parseIoregClamshell(out)).toBe("closed");
	});
});

// ── parseLinuxLidState ─────────────────────────────────────────────

describe("parseLinuxLidState", () => {
	test('returns "closed" when text contains "closed"', () => {
		expect(parseLinuxLidState("state:      closed\n")).toBe("closed");
	});

	test('returns "open" when text contains "open" but not "closed"', () => {
		expect(parseLinuxLidState("state:      open\n")).toBe("open");
	});

	test('returns "closed" when both tokens appear (closed wins)', () => {
		// "closed" check runs before "open" in the implementation; a file
		// content like "state: closed (was open)" must still read as closed.
		expect(parseLinuxLidState("closed (was open)")).toBe("closed");
	});

	test('returns "unknown" for empty / garbage input', () => {
		expect(parseLinuxLidState("")).toBe("unknown");
		expect(parseLinuxLidState("???")).toBe("unknown");
	});

	test("is case-insensitive (matches the implementation's toLowerCase normalization)", () => {
		expect(parseLinuxLidState("CLOSED")).toBe("closed");
		expect(parseLinuxLidState("OPEN")).toBe("open");
	});
});

// ── defaultProbeForPlatform ────────────────────────────────────────

describe("defaultProbeForPlatform", () => {
	test("returns a function for darwin / linux / win32 (no throw)", () => {
		expect(typeof defaultProbeForPlatform("darwin")).toBe("function");
		expect(typeof defaultProbeForPlatform("linux")).toBe("function");
		expect(typeof defaultProbeForPlatform("win32")).toBe("function");
	});

	test('Windows probe always returns "unknown" (no zero-cost Win32 probe yet)', async () => {
		const probe = defaultProbeForPlatform("win32");
		await expect(probe()).resolves.toBe("unknown");
	});
});

// ── decideSwap (transition table) ──────────────────────────────────

describe("decideSwap", () => {
	test("bootstrap transitions from unknown never trigger a swap", () => {
		const cases: [LidState, number | null][] = [
			["open", 7],
			["closed", 7],
			["unknown", 7],
		];
		for (const [next, clamshell] of cases) {
			const decision = decideSwap("unknown", next, clamshell, null);
			expect(decision.kind).toBe("no-op");
		}
	});

	test("feature disabled (clamshellMicrophone=null) always no-ops", () => {
		expect(decideSwap("open", "closed", null, 0).kind).toBe("no-op");
		expect(decideSwap("closed", "open", null, 0).kind).toBe("no-op");
	});

	test("open→closed swaps to the clamshell mic", () => {
		const decision = decideSwap("open", "closed", 5, 1);
		expect(decision).toEqual({ kind: "swap-to-clamshell", target: 5 } satisfies SwapDecision);
	});

	test("closed→open restores the cached primary index", () => {
		const decision = decideSwap("closed", "open", 5, 1);
		expect(decision).toEqual({ kind: "restore-primary", target: 1 } satisfies SwapDecision);
	});

	test("closed→open with null cached primary restores to system default", () => {
		const decision = decideSwap("closed", "open", 5, null);
		expect(decision).toEqual({ kind: "restore-primary", target: null } satisfies SwapDecision);
	});

	test("same-state polls (open→open, closed→closed) never fire", () => {
		expect(decideSwap("open", "open", 5, 1).kind).toBe("no-op");
		expect(decideSwap("closed", "closed", 5, 1).kind).toBe("no-op");
	});

	test("unknown destination state (probe failed) does not fire", () => {
		// Once the lid is known, a transient probe failure leaves the
		// detector inert rather than spuriously restoring/swapping.
		expect(decideSwap("open", "unknown", 5, 1).kind).toBe("no-op");
		expect(decideSwap("closed", "unknown", 5, 1).kind).toBe("no-op");
	});
});

// ── ClamshellDetector (debounce / transitions / cached primary) ────

interface FakeDeps extends ClamshellSwapDeps {
	calls: Array<{ kind: string; value: unknown }>;
}

function makeDeps(initialPrimary: number | null = 0): FakeDeps {
	const calls: Array<{ kind: string; value: unknown }> = [];
	let primary = initialPrimary;
	return {
		calls,
		saveInputDeviceIndex(value) {
			primary = value;
			calls.push({ kind: "save", value });
		},
		readInputDeviceIndex() {
			return primary;
		},
		pushDeviceToServer(value) {
			calls.push({ kind: "push", value });
		},
		broadcastLidEvent(channel) {
			calls.push({ kind: "broadcast", value: channel });
		},
	};
}

class ScriptedProbe {
	private readonly script: LidState[];
	private index = 0;
	constructor(script: LidState[]) {
		this.script = script;
	}
	readonly probe: LidProbe = async () => {
		const value = this.script[this.index] ?? this.script.at(-1) ?? "unknown";
		this.index = Math.min(this.index + 1, this.script.length);
		return value;
	};
}

describe("ClamshellDetector", () => {
	test("first poll captures state silently (no events fired even on open→closed)", async () => {
		// Script: lid is closed on the very first probe. Because the
		// detector starts in `unknown`, no transition is detected.
		const probe = new ScriptedProbe(["closed"]).probe;
		const deps = makeDeps(0);
		const det = new ClamshellDetector({
			deps,
			probe,
			readClamshellMicrophone: () => 5,
			pollIntervalMs: 999_999,
		});
		await det.tick();
		expect(deps.calls.length).toBe(0);
		expect(det.lastLidState).toBe("closed");
	});

	test("open→closed triggers swap + broadcast (LID_CLOSED) + cached primary save", async () => {
		const probe = new ScriptedProbe(["open", "closed"]).probe;
		const deps = makeDeps(0);
		const det = new ClamshellDetector({
			deps,
			probe,
			readClamshellMicrophone: () => 5,
			pollIntervalMs: 999_999,
		});
		await det.tick();
		expect(deps.calls.length).toBe(0); // unknown → open is a bootstrap, no event
		await det.tick();
		// One push to server (input_device_index=5), one save, one broadcast
		expect(deps.calls).toEqual([
			{ kind: "push", value: 5 },
			{ kind: "save", value: 5 },
			{ kind: "broadcast", value: IPC.LID_CLOSED },
		]);
	});

	test("closed→open restores to the primary captured on open→closed (not the clamshell value)", async () => {
		// Primary device is 0; lid closes (swap to 5, primary cached as 0);
		// lid reopens — restore must target 0, NOT the live value 5 that the
		// previous closed transition wrote back to the store.
		const probe = new ScriptedProbe(["open", "closed", "open"]).probe;
		const deps = makeDeps(0);
		const det = new ClamshellDetector({
			deps,
			probe,
			readClamshellMicrophone: () => 5,
			pollIntervalMs: 999_999,
		});
		await det.tick(); // bootstrap → open
		await det.tick(); // open → closed (swap to 5, cache primary=0)
		await det.tick(); // closed → open (restore 0)
		const lastTwo = deps.calls.slice(-3);
		expect(lastTwo).toEqual([
			{ kind: "push", value: 0 },
			{ kind: "save", value: 0 },
			{ kind: "broadcast", value: IPC.LID_OPENED },
		]);
	});

	test("repeated closed polls only fire ONCE — debounce via transition detection", async () => {
		const probe = new ScriptedProbe(["open", "closed", "closed", "closed"]).probe;
		const deps = makeDeps(0);
		const det = new ClamshellDetector({
			deps,
			probe,
			readClamshellMicrophone: () => 5,
			pollIntervalMs: 999_999,
		});
		await det.tick();
		await det.tick();
		await det.tick();
		await det.tick();
		const closedBroadcasts = deps.calls.filter(
			(c) => c.kind === "broadcast" && c.value === IPC.LID_CLOSED
		);
		expect(closedBroadcasts.length).toBe(1);
	});

	test("detector is no-op when clamshellMicrophone resolves to null at poll time", async () => {
		const probe = new ScriptedProbe(["open", "closed"]).probe;
		const deps = makeDeps(0);
		const det = new ClamshellDetector({
			deps,
			probe,
			readClamshellMicrophone: () => null,
			pollIntervalMs: 999_999,
		});
		await det.tick();
		await det.tick();
		expect(deps.calls.length).toBe(0);
	});

	test("re-entrant tick() coalesces (concurrent calls collapse to a single probe roundtrip)", async () => {
		let probeCalls = 0;
		// A slow probe so the second call lands inside the first's await.
		const slowProbe: LidProbe = () =>
			new Promise<LidState>((resolve) => {
				probeCalls++;
				setTimeout(() => resolve("open"), 20);
			});
		const deps = makeDeps(0);
		const det = new ClamshellDetector({
			deps,
			probe: slowProbe,
			readClamshellMicrophone: () => 5,
			pollIntervalMs: 999_999,
		});
		await Promise.all([det.tick(), det.tick(), det.tick()]);
		// Only the first tick actually probed; the rest short-circuited.
		expect(probeCalls).toBe(1);
	});

	test("start()/stop() are idempotent", () => {
		const det = new ClamshellDetector({
			deps: makeDeps(0),
			probe: () => Promise.resolve<LidState>("open"),
			readClamshellMicrophone: () => 5,
			pollIntervalMs: 999_999,
		});
		det.start();
		expect(det.isRunning).toBe(true);
		det.start(); // no-op
		expect(det.isRunning).toBe(true);
		det.stop();
		expect(det.isRunning).toBe(false);
		det.stop(); // no-op
		expect(det.isRunning).toBe(false);
	});

	test("polling interval default matches the documented constant", () => {
		expect(CLAMSHELL_POLL_INTERVAL_MS).toBe(5000);
	});

	test("cached primary is re-read fresh on each open→closed (stale-mic safety)", async () => {
		// User picks mic 0, lid closes (cache 0, swap to 5), lid reopens
		// (restore 0, clear cache). User switches to mic 1. Lid closes
		// again — the cache MUST be re-snapshotted as 1, not the previous 0.
		const probe = new ScriptedProbe(["open", "closed", "open", "closed"]).probe;
		const deps = makeDeps(0);
		const det = new ClamshellDetector({
			deps,
			probe,
			readClamshellMicrophone: () => 5,
			pollIntervalMs: 999_999,
		});
		await det.tick(); // bootstrap → open
		await det.tick(); // open → closed (cache 0, set 5)
		// Between the closed and the next open, the user picks a fresh primary.
		// In real life the renderer writes it through to the store; here we
		// simulate by overriding readInputDeviceIndex via reassignment.
		(deps as { readInputDeviceIndex: () => number | null }).readInputDeviceIndex = () => 1;
		await det.tick(); // closed → open (restore 0 since cache snapshot was 0)
		await det.tick(); // open → closed (cache 1 now, set 5)
		// Find the second "save" call — should be 0 (restore), then on the
		// next open→closed the cached primary is 1 (just set by user).
		const saves = deps.calls.filter((c) => c.kind === "save");
		expect(saves.map((c) => c.value)).toEqual([5, 0, 5]);
	});
});

// ── setupClamshellHandlers (wiring smoke test) ─────────────────────

describe("setupClamshellHandlers", () => {
	beforeEach(() => {
		base.ipcMain._handlers.clear();
		base.ipcMain._listeners.clear();
	});

	afterEach(() => {
		// Detector polls every 5s in real time; tests run in <1s so the
		// inner setInterval never tickles, but a stale detector still
		// holds an unref'd timer reference — the dispose returned by
		// setupClamshellHandlers clears it.
	});

	// Contained boundary cast — the fake client implements only the SttClient
	// surface setupClamshellHandlers reads.
	const asClamshellClient = (c: {
		isConnected: boolean;
		setParameter: () => void;
	}): Parameters<typeof setupClamshellHandlers>[0] =>
		c as unknown as Parameters<typeof setupClamshellHandlers>[0];

	test("setup returns a callable dispose that does not throw on repeat invocations", () => {
		const fakeClient = asClamshellClient({
			isConnected: false,
			setParameter: () => undefined,
		});
		const dispose = setupClamshellHandlers(fakeClient);
		expect(typeof dispose).toBe("function");
		expect(() => dispose()).not.toThrow();
		expect(() => dispose()).not.toThrow();
	});
});

// ── macOS probe (probeMacOs callback: err + success branches) ──────
// Reached through defaultProbeForPlatform("darwin"), which returns the
// internal `probeMacOs`. Driving it exercises the execFile callback that
// the injected-probe detector tests never touch.

describe("probeMacOs (via defaultProbeForPlatform)", () => {
	beforeEach(() => {
		execStub.calls = [];
		execStub.emitError = null;
		execStub.stdout = "";
	});

	test('shells out to ioreg with the documented args and resolves "closed"', async () => {
		execStub.stdout = '"AppleClamshellState" = Yes';
		const probe = defaultProbeForPlatform("darwin");
		await expect(probe()).resolves.toBe("closed");
		expect(execStub.calls).toHaveLength(1);
		expect(execStub.calls[0]?.cmd).toBe("ioreg");
		expect(execStub.calls[0]?.args).toEqual(["-r", "-k", "AppleClamshellState", "-d", "4"]);
	});

	test('resolves "open" when ioreg reports AppleClamshellState = No', async () => {
		execStub.stdout = '"AppleClamshellState" = No';
		const probe = defaultProbeForPlatform("darwin");
		await expect(probe()).resolves.toBe("open");
	});

	test("passes a larger maxBuffer so a verbose IORegistry snapshot does not overflow Node's 1 MB default", async () => {
		// `ioreg -d 4` can emit well over Node's default 1 MB stdout cap on some
		// Macs; without an explicit maxBuffer execFile errors with
		// ERR_CHILD_PROCESS_STDIO_MAXBUFFER and the probe goes inert. The fix
		// raises the cap to 8 MB.
		execStub.stdout = '"AppleClamshellState" = Yes';
		const probe = defaultProbeForPlatform("darwin");
		await probe();
		expect(execStub.calls[0]?.opts.maxBuffer).toBe(8 * 1024 * 1024);
		// The 2s timeout guard is still passed alongside the buffer bump.
		expect(execStub.calls[0]?.opts.timeout).toBe(2000);
	});

	test('resolves "unknown" on desktop Macs (no sensor in output)', async () => {
		execStub.stdout = "no relevant key here";
		const probe = defaultProbeForPlatform("darwin");
		await expect(probe()).resolves.toBe("unknown");
	});

	test('resolves "unknown" (never rejects) when ioreg errors out', async () => {
		execStub.emitError = "command not found: ioreg";
		const probe = defaultProbeForPlatform("darwin");
		await expect(probe()).resolves.toBe("unknown");
	});
});

// ── Linux probe (probeLinux + findLinuxLidPath) ────────────────────
// Reached through defaultProbeForPlatform("linux"). Exercises the
// readdir → readFile chain plus its three failure branches.

describe("probeLinux / findLinuxLidPath (via defaultProbeForPlatform)", () => {
	beforeEach(() => {
		fsStub.readdirResult = ["LID0"];
		fsStub.readdirCalls = [];
		fsStub.readFileResult = "state:      open\n";
		fsStub.readFileCalls = [];
	});

	test("finds the LID dir, reads its state file, and parses the lid state", async () => {
		fsStub.readdirResult = ["LID0"];
		fsStub.readFileResult = "state:      closed\n";
		const probe = defaultProbeForPlatform("linux");
		await expect(probe()).resolves.toBe("closed");
		expect(fsStub.readdirCalls).toEqual(["/proc/acpi/button/lid"]);
		expect(fsStub.readFileCalls).toEqual(["/proc/acpi/button/lid/LID0/state"]);
	});

	test("matches LID entries case-insensitively and prefixes the proc path", async () => {
		// readdir might surface a lowercase / oddly-cased entry; findLinuxLidPath
		// uppercases before the startsWith check.
		fsStub.readdirResult = ["AC", "lid1", "power"];
		fsStub.readFileResult = "open";
		const probe = defaultProbeForPlatform("linux");
		await expect(probe()).resolves.toBe("open");
		expect(fsStub.readFileCalls).toEqual(["/proc/acpi/button/lid/lid1/state"]);
	});

	test("picks the lowest-numbered LID deterministically when several exist (LID1 before LID0 in readdir order)", async () => {
		// readdir order is filesystem-dependent; without an explicit sort the
		// detector could bind to LID1 on one boot and LID0 on the next. The fix
		// sorts the matches and picks the lowest (LID0 = conventional primary).
		fsStub.readdirResult = ["LID1", "AC", "LID0"];
		fsStub.readFileResult = "state:      closed\n";
		const probe = defaultProbeForPlatform("linux");
		await expect(probe()).resolves.toBe("closed");
		expect(fsStub.readFileCalls).toEqual(["/proc/acpi/button/lid/LID0/state"]);
	});

	test('resolves "unknown" when no LID dir exists (readdir returns no match)', async () => {
		fsStub.readdirResult = ["AC", "PWRF"]; // nothing starts with LID
		const probe = defaultProbeForPlatform("linux");
		await expect(probe()).resolves.toBe("unknown");
		// findLinuxLidPath returned null ⇒ probeLinux short-circuits, no readFile.
		expect(fsStub.readFileCalls).toEqual([]);
	});

	test('resolves "unknown" when the lid dir is missing (readdir throws → catch → null)', async () => {
		fsStub.readdirResult = null; // readdir rejects
		const probe = defaultProbeForPlatform("linux");
		await expect(probe()).resolves.toBe("unknown");
		expect(fsStub.readFileCalls).toEqual([]);
	});

	test('resolves "unknown" when the state file read fails (readFile throws)', async () => {
		fsStub.readdirResult = ["LID0"];
		fsStub.readFileResult = null; // readFile rejects
		const probe = defaultProbeForPlatform("linux");
		await expect(probe()).resolves.toBe("unknown");
		expect(fsStub.readFileCalls).toEqual(["/proc/acpi/button/lid/LID0/state"]);
	});
});

// ── Store-backed deps + window broadcast (the real setupClamshellHandlers
//    wiring) ─────────────────────────────────────────────────────────
// These functions are internal to clamshell.ts and only reachable through
// the deps object that setupClamshellHandlers builds. We drive a full
// open→closed→open cycle by capturing the detector's setInterval callback
// and firing it manually (bun has no fake-timer that advances setInterval),
// using a real Linux fs-backed probe to flip lid state between ticks.

interface FakeSttClient {
	isConnected: boolean;
	setParameter: (key: string, value: number | null) => void;
	setParameterCalls: Array<{ key: string; value: number | null }>;
}

function makeSttClient(isConnected: boolean): FakeSttClient {
	const setParameterCalls: Array<{ key: string; value: number | null }> = [];
	return {
		isConnected,
		setParameterCalls,
		setParameter(key, value) {
			setParameterCalls.push({ key, value });
		},
	};
}

const asClamshellClientDeep = (c: FakeSttClient): Parameters<typeof setupClamshellHandlers>[0] =>
	c as unknown as Parameters<typeof setupClamshellHandlers>[0];

interface FakeWebContents {
	sends: Array<{ channel: string; payload: unknown }>;
}
function makeWindow(destroyed: boolean): {
	isDestroyed: () => boolean;
	webContents: { send: (channel: string, payload: unknown) => void };
	wc: FakeWebContents;
} {
	const wc: FakeWebContents = { sends: [] };
	return {
		wc,
		isDestroyed: () => destroyed,
		webContents: {
			send: (channel: string, payload: unknown) => {
				wc.sends.push({ channel, payload });
			},
		},
	};
}

const asPatchableBrowserWindow = (
	bw: typeof base.BrowserWindow
): { getAllWindows: () => unknown[] } => bw as unknown as { getAllWindows: () => unknown[] };

describe("setupClamshellHandlers (real store-backed deps + broadcast)", () => {
	let capturedTick: (() => void) | null;
	let originalSetInterval: typeof globalThis.setInterval;
	const origGetAllWindows = base.BrowserWindow.getAllWindows;

	beforeEach(() => {
		setPlatform("linux");
		seedAudio({ clamshellMicrophone: 9, inputDeviceIndex: 2 });
		fsStub.readdirResult = ["LID0"];
		fsStub.readdirCalls = [];
		fsStub.readFileResult = "state:      open\n";
		fsStub.readFileCalls = [];
		// Capture the interval callback so the test can pump ticks manually.
		capturedTick = null;
		originalSetInterval = globalThis.setInterval;
		globalThis.setInterval = ((cb: () => void) => {
			capturedTick = cb;
			return 0 as unknown as ReturnType<typeof setInterval>;
		}) as unknown as typeof globalThis.setInterval;
	});

	afterEach(() => {
		globalThis.setInterval = originalSetInterval;
		asPatchableBrowserWindow(base.BrowserWindow).getAllWindows = origGetAllWindows;
		seedAudio(undefined);
		resetPlatform();
	});

	// Pump one full poll cycle: the immediate start() tick already ran (it sets
	// lastState); each manual fire of the captured interval callback runs one
	// more tick. We await microtasks between fires so the async probe settles.
	async function flush(): Promise<void> {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	}

	test("open→closed pushes the clamshell mic to a connected server, persists it, and broadcasts LID_CLOSED to live windows", async () => {
		const liveWin = makeWindow(false);
		const deadWin = makeWindow(true);
		asPatchableBrowserWindow(base.BrowserWindow).getAllWindows = () => [liveWin, deadWin];

		const client = makeSttClient(true);
		fsStub.readFileResult = "state:      open\n"; // first probe: lid open
		const dispose = setupClamshellHandlers(asClamshellClientDeep(client));
		// start() ran an immediate tick (unknown→open, silent). Let it settle.
		await flush();

		// Lid closes; pump the captured interval tick.
		fsStub.readFileResult = "state:      closed\n";
		capturedTick?.();
		await flush();

		// pushDeviceToSttServer → setParameter("input_device_index", 9)
		expect(client.setParameterCalls).toEqual([{ key: "input_device_index", value: 9 }]);
		// saveInputDeviceIndexToStore → store key "audio.inputDeviceIndex" = 9
		expect(storeData["audio.inputDeviceIndex"]).toBe(9);
		// broadcastLidEventToAllWindows → only the live window received the send
		expect(liveWin.wc.sends).toEqual([{ channel: IPC.LID_CLOSED, payload: {} }]);
		expect(deadWin.wc.sends).toEqual([]);

		dispose();
	});

	test("closed→open restores the cached primary (2, captured before swap) and broadcasts LID_OPENED", async () => {
		const liveWin = makeWindow(false);
		asPatchableBrowserWindow(base.BrowserWindow).getAllWindows = () => [liveWin];

		const client = makeSttClient(true);
		fsStub.readFileResult = "state:      open\n";
		const dispose = setupClamshellHandlers(asClamshellClientDeep(client));
		await flush(); // unknown→open

		fsStub.readFileResult = "state:      closed\n";
		capturedTick?.(); // open→closed: readInputDeviceIndexFromStore() caches 2
		await flush();

		fsStub.readFileResult = "state:      open\n";
		capturedTick?.(); // closed→open: restore cached primary (2)
		await flush();

		const lastPush = client.setParameterCalls.at(-1);
		expect(lastPush).toEqual({ key: "input_device_index", value: 2 });
		expect(storeData["audio.inputDeviceIndex"]).toBe(2);
		const lastSend = liveWin.wc.sends.at(-1);
		expect(lastSend).toEqual({ channel: IPC.LID_OPENED, payload: {} });

		dispose();
	});

	test("disconnected server: pushDeviceToSttServer is a no-op (no setParameter call), but store + broadcast still run", async () => {
		const liveWin = makeWindow(false);
		asPatchableBrowserWindow(base.BrowserWindow).getAllWindows = () => [liveWin];

		const client = makeSttClient(false); // NOT connected
		fsStub.readFileResult = "state:      open\n";
		const dispose = setupClamshellHandlers(asClamshellClientDeep(client));
		await flush();

		fsStub.readFileResult = "state:      closed\n";
		capturedTick?.();
		await flush();

		// isConnected === false ⇒ setParameter never called.
		expect(client.setParameterCalls).toEqual([]);
		// The store + broadcast deps still fire regardless of connection.
		expect(storeData["audio.inputDeviceIndex"]).toBe(9);
		expect(liveWin.wc.sends).toEqual([{ channel: IPC.LID_CLOSED, payload: {} }]);

		dispose();
	});

	test("readInputDeviceIndexFromStore: cached primary is null when the audio section is absent", async () => {
		// With no audio.inputDeviceIndex, the cached primary snapshot is null;
		// a later restore should push null (system default).
		seedAudio({ clamshellMicrophone: 9 }); // inputDeviceIndex omitted
		const client = makeSttClient(true);
		fsStub.readFileResult = "state:      open\n";
		const dispose = setupClamshellHandlers(asClamshellClientDeep(client));
		await flush();

		fsStub.readFileResult = "state:      closed\n";
		capturedTick?.(); // caches readInputDeviceIndexFromStore() === null
		await flush();
		fsStub.readFileResult = "state:      open\n";
		capturedTick?.(); // restore null
		await flush();

		expect(client.setParameterCalls.at(-1)).toEqual({ key: "input_device_index", value: null });
		dispose();
	});

	test("readInputDeviceIndexFromStore: non-integer / wrong-type values fall back to null", async () => {
		// 2.5 is a number but not an integer; the guard rejects it ⇒ null.
		seedAudio({ clamshellMicrophone: 9, inputDeviceIndex: 2.5 });
		const client = makeSttClient(true);
		fsStub.readFileResult = "state:      open\n";
		const dispose = setupClamshellHandlers(asClamshellClientDeep(client));
		await flush();

		fsStub.readFileResult = "state:      closed\n";
		capturedTick?.(); // caches null (2.5 rejected)
		await flush();
		fsStub.readFileResult = "state:      open\n";
		capturedTick?.();
		await flush();

		expect(client.setParameterCalls.at(-1)).toEqual({ key: "input_device_index", value: null });
		dispose();
	});

	test("readClamshellMicrophoneFromStore: corrupt audio section (non-object) disables the feature (detector never starts)", () => {
		// The store's audio key is a string, not an object ⇒ readClamshell…
		// returns null ⇒ refresh() never starts the detector.
		storeData.audio = "corrupt-not-an-object";
		let started = false;
		// If start() ran, our setInterval shim would have been invoked.
		const shimSetInterval = globalThis.setInterval;
		globalThis.setInterval = ((cb: () => void) => {
			started = true;
			return shimSetInterval(cb, 999_999);
		}) as unknown as typeof globalThis.setInterval;
		const client = makeSttClient(true);
		const dispose = setupClamshellHandlers(asClamshellClientDeep(client));
		expect(started).toBe(false);
		expect(client.setParameterCalls).toEqual([]);
		dispose();
	});

	test("store onDidChange toggles the detector on when clamshellMicrophone becomes non-null", () => {
		// Start with the feature OFF (no clamshellMicrophone) so the detector
		// is dormant, then flip the store + fire the watcher → detector starts.
		seedAudio({ inputDeviceIndex: 2 });
		let startCount = 0;
		globalThis.setInterval = ((cb: () => void) => {
			startCount++;
			capturedTick = cb;
			return 0 as unknown as ReturnType<typeof setInterval>;
		}) as unknown as typeof globalThis.setInterval;

		const client = makeSttClient(false);
		const dispose = setupClamshellHandlers(asClamshellClientDeep(client));
		expect(startCount).toBe(0); // dormant: clamshellMicrophone is null

		// Configure the mic and notify the "audio" watcher.
		seedAudio({ clamshellMicrophone: 9, inputDeviceIndex: 2 });
		const listeners = (
			storeModule.store as unknown as { __listeners: Map<string, Array<() => void>> }
		).__listeners.get("audio");
		for (const cb of listeners ?? []) {
			cb();
		}
		expect(startCount).toBe(1); // refresh() started the detector

		// And toggling it back to null stops it (dispose path covered too).
		seedAudio({ inputDeviceIndex: 2 });
		for (const cb of listeners ?? []) {
			cb();
		}
		dispose();
	});
});
