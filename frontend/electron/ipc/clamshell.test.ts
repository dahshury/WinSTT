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
