import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { debugLogMock } from "@test/mocks/debug-log";
import { electronMock } from "@test/mocks/electron";
import { storeMock } from "@test/mocks/store";

// ─── Why this file exists ──────────────────────────────────────────────
//
// `stt-process-deps.ts` is a one-line indirection re-export:
//
//   export { isSttProcessRunning, restartSttProcess } from "./stt-process";
//
// It exists so that other IPC modules (settings.ts) depend on this thin
// wrapper, letting `stt-process.test.ts` import the REAL ./stt-process
// without picking up settings.test.ts's stub of "./stt-process-deps".
//
// The contract this file must uphold:
//   1. It re-exports EXACTLY two symbols: isSttProcessRunning + restartSttProcess.
//   2. Each re-export is the SAME function reference as ./stt-process's export
//      (the indirection must NOT wrap, rename, or shadow them).
//   3. It must NOT leak any other ./stt-process export (killSttProcess,
//      setupSttProcessHandlers, tryAutoSpawnServer, markServerRunning, …).
//   4. The re-exports behave identically to the originals (same side-effects
//      on the shared module state).
//
// To import the wrapper we must first satisfy ./stt-process's module-load
// dependencies (electron, child_process, store, debug-log). We reuse the
// canonical shared mocks. Crucially we import BOTH ./stt-process and
// ./stt-process-deps through a non-stub specifier so we can compare the
// two surfaces by reference.

// ─── child_process: record + drive spawns ──────────────────────────────

interface SpawnCall {
	args: readonly string[];
	command: string;
	options: { cwd?: string; shell?: boolean; stdio?: string; windowsHide?: boolean };
}

interface FakeChild extends EventEmitter {
	kill: (signal?: string) => void;
	killCalls: string[];
	pid?: number | undefined;
	spawnfile?: string | undefined;
	stderr: EventEmitter | null;
	stdout: EventEmitter | null;
}

const spawnLog: SpawnCall[] = [];

function makeFakeChild(spawnfile: string, pid = 24_680): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.pid = pid;
	child.spawnfile = spawnfile;
	child.killCalls = [];
	child.kill = (signal?: string) => {
		child.killCalls.push(signal ?? "");
	};
	return child;
}

mock.module("node:child_process", () => ({
	spawn: (command: string, args: readonly string[] = [], options: SpawnCall["options"] = {}) => {
		spawnLog.push({ command, args, options });
		// taskkill (win32 orphan reclamation + kill) and the stt-server spawn
		// both flow through here; a default child satisfies all of them.
		return makeFakeChild(command);
	},
	// reclaimOrphanStttServers / waitForOrphanExit call spawnSync(tasklist,
	// taskkill). Return a benign result so the orphan-reclaim loop exits fast.
	spawnSync: () => ({ status: 128, stdout: "", stderr: "" }),
}));

// ─── electron ───────────────────────────────────────────────────────────
mock.module("electron", () => electronMock());

// ─── debug-log (silent) ──────────────────────────────────────────────────
mock.module("../lib/debug-log", () => debugLogMock());

// ─── store ────────────────────────────────────────────────────────────────
const sharedStoreMock = storeMock();
mock.module("../lib/store", () => sharedStoreMock);

// ─── Import BOTH the wrapper and the real module ──────────────────────────
// Use distinct relative specifiers that resolve to the same absolute files
// but bypass settings.test.ts's process-global stub of "./stt-process-deps".
const deps = await import("../ipc/stt-process-deps");
const real = await import("../ipc/stt-process");

// ─── Helpers ──────────────────────────────────────────────────────────────

function ensureIdle(): void {
	// killSttProcess zeroes module state synchronously regardless of platform.
	real.killSttProcess();
}

beforeEach(() => {
	ensureIdle();
	spawnLog.length = 0;
	process.env.STT_SERVER_DIR = "/mock/server";
});

afterEach(() => {
	ensureIdle();
	spawnLog.length = 0;
});

// ─── 1. Export surface ────────────────────────────────────────────────────

describe("stt-process-deps export surface", () => {
	test("exports isSttProcessRunning as a function", () => {
		expect(typeof deps.isSttProcessRunning).toBe("function");
	});

	test("exports restartSttProcess as a function", () => {
		expect(typeof deps.restartSttProcess).toBe("function");
	});

	test("exports EXACTLY the two re-exported symbols (no extra leakage)", () => {
		// The wrapper must NOT widen the public surface of ./stt-process.
		// Object.keys on a re-export module reflects only the named exports.
		const keys = Object.keys(deps).sort();
		expect(keys).toEqual(["isSttProcessRunning", "restartSttProcess"]);
	});

	test("does NOT leak killSttProcess from ./stt-process", () => {
		expect((deps as Record<string, unknown>).killSttProcess).toBeUndefined();
	});

	test("does NOT leak setupSttProcessHandlers from ./stt-process", () => {
		expect((deps as Record<string, unknown>).setupSttProcessHandlers).toBeUndefined();
	});

	test("does NOT leak tryAutoSpawnServer from ./stt-process", () => {
		expect((deps as Record<string, unknown>).tryAutoSpawnServer).toBeUndefined();
	});

	test("does NOT leak markServerRunning from ./stt-process", () => {
		expect((deps as Record<string, unknown>).markServerRunning).toBeUndefined();
	});

	test("does NOT leak the __stt_process_test_helpers__ aggregator", () => {
		expect((deps as Record<string, unknown>).__stt_process_test_helpers__).toBeUndefined();
	});
});

// ─── 2. Reference identity with the real module ──────────────────────────
//
// This is the load-bearing assertion. If the indirection ever stops being a
// pure re-export (e.g. someone wraps it in a closure, or re-aliases a
// different function), reference equality breaks and these fail. It proves
// the wrapper is genuinely transparent and that consumers (settings.ts) get
// the canonical implementation, not a copy.

describe("stt-process-deps re-export identity", () => {
	test("deps.isSttProcessRunning IS the same reference as ./stt-process's export", () => {
		expect(deps.isSttProcessRunning).toBe(real.isSttProcessRunning);
	});

	test("deps.restartSttProcess IS the same reference as ./stt-process's export", () => {
		expect(deps.restartSttProcess).toBe(real.restartSttProcess);
	});
});

// ─── 3. Behavioural: isSttProcessRunning ──────────────────────────────────

describe("isSttProcessRunning (via the wrapper)", () => {
	test("returns false when no STT process has been spawned", () => {
		ensureIdle();
		expect(deps.isSttProcessRunning()).toBe(false);
	});

	test("returns true after the underlying module spawns a process", () => {
		ensureIdle();
		expect(deps.isSttProcessRunning()).toBe(false);
		// Drive the shared module state by spawning via the real module's API.
		real.tryAutoSpawnServer();
		expect(spawnLog.length).toBeGreaterThanOrEqual(1);
		// The wrapper reads the SAME module-level sttProcess variable.
		expect(deps.isSttProcessRunning()).toBe(true);
	});

	test("returns false again after the process is killed", () => {
		ensureIdle();
		real.tryAutoSpawnServer();
		expect(deps.isSttProcessRunning()).toBe(true);
		real.killSttProcess();
		expect(deps.isSttProcessRunning()).toBe(false);
	});

	test("agrees with ./stt-process's isSttProcessRunning at every step", () => {
		ensureIdle();
		expect(deps.isSttProcessRunning()).toBe(real.isSttProcessRunning());
		real.tryAutoSpawnServer();
		expect(deps.isSttProcessRunning()).toBe(real.isSttProcessRunning());
		expect(deps.isSttProcessRunning()).toBe(true);
		real.killSttProcess();
		expect(deps.isSttProcessRunning()).toBe(real.isSttProcessRunning());
		expect(deps.isSttProcessRunning()).toBe(false);
	});
});

// ─── 4. Behavioural: restartSttProcess ────────────────────────────────────

describe("restartSttProcess (via the wrapper)", () => {
	test("spawns a fresh STT server process when none is running", () => {
		ensureIdle();
		spawnLog.length = 0;
		deps.restartSttProcess();
		// At least one spawn targeting the configured server dir must have run.
		const sttSpawns = spawnLog.filter((c) => c.options.cwd === "/mock/server");
		expect(sttSpawns.length).toBe(1);
		// And the module now reports a live process.
		expect(deps.isSttProcessRunning()).toBe(true);
	});

	test("kills the running process and spawns a replacement", () => {
		ensureIdle();
		real.tryAutoSpawnServer();
		const initialSttSpawns = spawnLog.filter((c) => c.options.cwd === "/mock/server").length;
		expect(initialSttSpawns).toBe(1);
		spawnLog.length = 0;
		deps.restartSttProcess();
		// A fresh stt-server spawn happened after the restart.
		const afterRestart = spawnLog.filter((c) => c.options.cwd === "/mock/server").length;
		expect(afterRestart).toBe(1);
		expect(deps.isSttProcessRunning()).toBe(true);
	});

	test("does not throw when the spawn dir is missing (error is swallowed)", () => {
		ensureIdle();
		delete process.env.STT_SERVER_DIR;
		(electronMock().app as { isPackaged: boolean }).isPackaged = false;
		try {
			// restartSttProcess catches spawn failures internally and never throws.
			expect(() => deps.restartSttProcess()).not.toThrow();
			// With no resolvable server dir in dev mode, no process is alive.
			expect(deps.isSttProcessRunning()).toBe(false);
		} finally {
			process.env.STT_SERVER_DIR = "/mock/server";
		}
	});

	test("the wrapped restart produces the SAME observable effect as the real one", () => {
		ensureIdle();
		spawnLog.length = 0;
		// Call through the wrapper.
		deps.restartSttProcess();
		const viaWrapper = spawnLog.filter((c) => c.options.cwd === "/mock/server").length;
		ensureIdle();
		spawnLog.length = 0;
		// Call through the real module.
		real.restartSttProcess();
		const viaReal = spawnLog.filter((c) => c.options.cwd === "/mock/server").length;
		expect(viaWrapper).toBe(viaReal);
		expect(viaWrapper).toBe(1);
	});
});
