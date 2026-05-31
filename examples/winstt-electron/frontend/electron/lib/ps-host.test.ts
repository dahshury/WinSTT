import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Tests for the long-running PowerShell host (electron/lib/ps-host.ts).
 *
 * The module owns process-global state (the live `powershell.exe` child, a
 * pending-command map, a stdout line buffer). Every uncovered function reaches
 * I/O — `spawn`, the child's stdout/stderr/stdin streams — so we drive it
 * entirely through a controllable fake `spawn` from `node:child_process`.
 *
 * `process.platform` is read at CALL time inside every exported function, so we
 * pin it to "win32" for the duration of the suite (these run on any host).
 */

// --- debug-log: avoid pulling electron-log + its electron transitive deps. ---
const dbgLog: string[] = [];
mock.module("./debug-log", () => ({
	dbg: (_tag: string, ...args: unknown[]) => {
		dbgLog.push(args.map(String).join(" "));
	},
}));

// --- Fake child_process.spawn -------------------------------------------------
// Each spawn yields a FakeChild that exposes emit helpers so tests can drive
// stdout/stderr/error/exit deterministically (no real microtask races).
interface SpawnRecord {
	args: string[];
	child: FakeChild;
	cmd: string;
	opts: unknown;
}

interface FakeChild {
	emitError: (err: Error) => void;
	emitExit: (code: number | null, signal: string | null) => void;
	emitStderr: (s: string) => void;
	// Test-only drivers:
	emitStdout: (s: string) => void;
	exitCode: number | null;
	kill: () => boolean;
	killed: boolean;
	on: (ev: string, fn: (...a: unknown[]) => void) => void;
	stderr: { on: (ev: string, fn: (chunk: Buffer) => void) => void };
	stdin: FakeStdin | null;
	stdout: { on: (ev: string, fn: (chunk: Buffer) => void) => void };
}

interface FakeStdin {
	end: () => void;
	ended: boolean;
	throwOnEnd: boolean;
	throwOnWrite: boolean;
	write: (chunk: string) => boolean;
	writes: string[];
}

const spawnLog: SpawnRecord[] = [];
const spawnStub: {
	throwOnSpawn?: string | undefined;
	nullStdin: boolean;
	/** When true, the NEXT child's stdin throws on its first synchronous write. */
	throwOnSetupWrite: boolean;
} = { nullStdin: false, throwOnSetupWrite: false };

function makeFakeStdin(throwFirstWrite: boolean): FakeStdin {
	let firstWritePending = throwFirstWrite;
	const stdin: FakeStdin = {
		writes: [],
		throwOnWrite: false,
		throwOnEnd: false,
		ended: false,
		write(chunk: string) {
			if (firstWritePending) {
				firstWritePending = false;
				throw new Error("EPIPE-setup-write");
			}
			if (stdin.throwOnWrite) {
				throw new Error("EPIPE-write");
			}
			stdin.writes.push(chunk);
			return true;
		},
		end() {
			if (stdin.throwOnEnd) {
				throw new Error("EPIPE-end");
			}
			stdin.ended = true;
		},
	};
	return stdin;
}

function makeFakeChild(): FakeChild {
	const stdoutHandlers: Array<(chunk: Buffer) => void> = [];
	const stderrHandlers: Array<(chunk: Buffer) => void> = [];
	const procHandlers = new Map<string, Array<(...a: unknown[]) => void>>();
	const stdinThrows = spawnStub.throwOnSetupWrite;
	spawnStub.throwOnSetupWrite = false;
	const child: FakeChild = {
		stdin: spawnStub.nullStdin ? null : makeFakeStdin(stdinThrows),
		stdout: {
			on: (_ev: string, fn: (chunk: Buffer) => void) => {
				stdoutHandlers.push(fn);
			},
		},
		stderr: {
			on: (_ev: string, fn: (chunk: Buffer) => void) => {
				stderrHandlers.push(fn);
			},
		},
		on: (ev: string, fn: (...a: unknown[]) => void) => {
			const list = procHandlers.get(ev) ?? [];
			list.push(fn);
			procHandlers.set(ev, list);
		},
		kill: () => {
			child.killed = true;
			return true;
		},
		killed: false,
		exitCode: null,
		emitStdout: (s: string) => {
			for (const fn of stdoutHandlers) {
				fn(Buffer.from(s));
			}
		},
		emitStderr: (s: string) => {
			for (const fn of stderrHandlers) {
				fn(Buffer.from(s));
			}
		},
		emitError: (err: Error) => {
			for (const fn of procHandlers.get("error") ?? []) {
				fn(err);
			}
		},
		emitExit: (code: number | null, signal: string | null) => {
			child.exitCode = code;
			for (const fn of procHandlers.get("exit") ?? []) {
				fn(code, signal);
			}
		},
	};
	return child;
}

mock.module("node:child_process", () => ({
	spawn: (cmd: string, args: string[], opts: unknown) => {
		if (spawnStub.throwOnSpawn) {
			const msg = spawnStub.throwOnSpawn;
			spawnStub.throwOnSpawn = undefined;
			throw new Error(msg);
		}
		const child = makeFakeChild();
		spawnLog.push({ cmd, args, opts, child });
		return child;
	},
}));

const { runPsCommand, shutdownPsHost } = await import("./ps-host");

const READY_MARKER = "__WINSTT_PS_READY__";
const DONE_MARKER_PREFIX = "__WINSTT_PS_DONE__:";
const VALUE_MARKER_PREFIX = "__WINSTT_PS_VAL__:";

const realPlatform = process.platform;

function setPlatform(value: string): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

// Restore the real platform after the suite — the mutation is process-global
// and would otherwise leak into other test files run in the same process.
afterAll(() => {
	setPlatform(realPlatform);
});

/** The most-recently spawned fake child. */
function lastChild(): FakeChild {
	const rec = spawnLog.at(-1);
	if (!rec) {
		throw new Error("no spawn recorded");
	}
	return rec.child;
}

/** Yield once so an awaited microtask (ensurePs resolution) settles. */
function tick(): Promise<void> {
	return Promise.resolve();
}

/**
 * The module's `nextId` counter is process-global and never resets between
 * tests, so command ids are unpredictable across the suite. Recover the id a
 * command was actually assigned by parsing the DONE sentinel it wrote to stdin.
 */
function lastCommandId(child: FakeChild): number {
	const written = child.stdin?.writes.join("") ?? "";
	const matches = [...written.matchAll(/__WINSTT_PS_DONE__:(\d+)/g)];
	const last = matches.at(-1);
	if (!last) {
		throw new Error(`no DONE sentinel in stdin writes: ${written}`);
	}
	return Number.parseInt(last[1] ?? "", 10);
}

/** Emit a DONE marker for the given command id. */
function emitDoneFor(child: FakeChild, id: number): void {
	child.emitStdout(`${DONE_MARKER_PREFIX}${id}\n`);
}

/** Yield microtasks until the child's stdin write count exceeds `prevLen`. */
async function waitForWrite(child: FakeChild, prevLen: number): Promise<void> {
	for (let i = 0; i < 5 && (child.stdin?.writes.length ?? 0) <= prevLen; i += 1) {
		await tick();
	}
}

/**
 * Dispatch a command and resolve once its stdin write has landed. `runPsCommand`
 * does `await ensurePs()` before writing, so the write is always a microtask
 * (or two) after the call returns — yield until the DONE sentinel appears.
 */
async function dispatch(
	child: FakeChild,
	command: string,
	opts?: { expectValue?: boolean; timeoutMs?: number }
): Promise<{ promise: Promise<{ ok: boolean; value: string | null }>; id: number }> {
	const before = child.stdin?.writes.length ?? 0;
	const promise = runPsCommand(command, opts);
	// Wait for the command's stdin write to flush (after the awaited ensurePs).
	await waitForWrite(child, before);
	return { promise, id: lastCommandId(child) };
}

/** Bring a freshly-spawned host to READY and drain the warm-up command. */
async function readyHost(): Promise<FakeChild> {
	const warm = runPsCommand("Warm");
	const child = lastChild();
	child.emitStdout(`${READY_MARKER}\n`);
	// Let the awaited ensurePs continue so the warm-up command writes to stdin.
	await waitForWrite(child, 1);
	emitDoneFor(child, lastCommandId(child));
	await warm;
	// Clear the warm-up's stdin writes so id-parsing in tests sees only the
	// command under test.
	if (child.stdin) {
		child.stdin.writes.length = 0;
	}
	return child;
}

beforeEach(() => {
	// Tear down any live host between tests so module-local state can't leak.
	setPlatform("win32");
	shutdownPsHost();
	spawnLog.length = 0;
	dbgLog.length = 0;
	spawnStub.throwOnSpawn = undefined;
	spawnStub.nullStdin = false;
	spawnStub.throwOnSetupWrite = false;
});

describe("non-win32 early returns", () => {
	test("runPsCommand resolves { ok:false, value:null } and never spawns", async () => {
		setPlatform("linux");
		spawnLog.length = 0;
		const result = await runPsCommand("Get-Foo");
		expect(result).toEqual({ ok: false, value: null });
		expect(spawnLog.length).toBe(0);
	});

	test("shutdownPsHost is a safe no-op when nothing is running", () => {
		setPlatform("linux");
		expect(() => shutdownPsHost()).not.toThrow();
	});
});

describe("startPs + ensurePs (via runPsCommand)", () => {
	test("spawns powershell.exe with the expected flags and writes the setup script to stdin", async () => {
		const pending = runPsCommand("Write-Host hi");
		// startPs spawned the host synchronously.
		expect(spawnLog.length).toBe(1);
		const rec = spawnLog[0];
		expect(rec?.cmd).toBe("powershell.exe");
		expect(rec?.args).toEqual([
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			"-",
		]);
		expect(rec?.opts).toEqual({ windowsHide: true });
		// The SETUP_SCRIPT was written to stdin (begins the Add-Type compile).
		const child = rec?.child;
		expect(child?.stdin?.writes[0]).toContain("Add-Type");

		// Drive setup ready → command done so the awaited promise settles and
		// the test doesn't leak a 5s command timer.
		child?.emitStdout(`${READY_MARKER}\n`);
		if (child) {
			await waitForWrite(child, 1);
			emitDoneFor(child, lastCommandId(child));
		}
		await pending;
	});

	test("READY_MARKER resolves setup; a subsequent runPsCommand reuses the live host", async () => {
		const p1 = runPsCommand("Cmd-One");
		const child = lastChild();
		child.emitStdout(`${READY_MARKER}\n`);
		await waitForWrite(child, 1);
		emitDoneFor(child, lastCommandId(child));
		await p1;

		// Second command must NOT spawn a new process (ensurePs short-circuits).
		const spawnsBefore = spawnLog.length;
		if (child.stdin) {
			child.stdin.writes.length = 0;
		}
		const p2 = runPsCommand("Cmd-Two");
		expect(spawnLog.length).toBe(spawnsBefore);
		await waitForWrite(child, 0);
		emitDoneFor(child, lastCommandId(child));
		await p2;
	});

	test("setup timeout kills the host and resolves the command false", async () => {
		// Use fake timers so the 15s spawn timeout fires deterministically.
		const realSetTimeout = globalThis.setTimeout;
		const timers: Array<{ fn: () => void; ms: number }> = [];
		(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
			fn: () => void,
			ms: number
		) => {
			timers.push({ fn, ms });
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		try {
			const pending = runPsCommand("Never-Ready");
			const child = lastChild();
			// The setup timer is the 15_000ms one. Fire it manually.
			const setupTimer = timers.find((t) => t.ms === 15_000);
			expect(setupTimer).toBeDefined();
			setupTimer?.fn();
			expect(child.killed).toBe(true);
			const result = await pending;
			expect(result).toEqual({ ok: false, value: null });
			expect(dbgLog.some((l) => l.includes("setup timeout"))).toBe(true);
		} finally {
			(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
		}
	});

	test("spawn 'error' event aborts setup and resolves false", async () => {
		const pending = runPsCommand("Boom");
		const child = lastChild();
		child.emitError(new Error("spawn ENOENT"));
		const result = await pending;
		expect(result).toEqual({ ok: false, value: null });
		expect(dbgLog.some((l) => l.includes("spawn error"))).toBe(true);
	});

	test("setup stdin write failure resolves setup false", async () => {
		// The SETUP_SCRIPT write happens synchronously inside startPs, so the
		// child's stdin must throw on its first write — armed via the stub.
		const realSpawnLogLen = spawnLog.length;
		const pending = runPsCommandWithThrowingSetupWrite("Will-Fail");
		expect(spawnLog.length).toBeGreaterThan(realSpawnLogLen);
		const result = await pending;
		expect(result).toEqual({ ok: false, value: null });
		expect(dbgLog.some((l) => l.includes("setup stdin write failed"))).toBe(true);
	});

	test("stderr data is logged (trimmed, capped) without affecting setup", async () => {
		const pending = runPsCommand("With-Stderr");
		const child = lastChild();
		child.emitStderr("   diagnostic chatter   \n");
		child.emitStdout(`${READY_MARKER}\n`);
		await tick();
		emitDoneFor(child, lastCommandId(child));
		await pending;
		expect(dbgLog.some((l) => l.includes("stderr:") && l.includes("diagnostic chatter"))).toBe(
			true
		);
	});

	test("blank stderr chunk is ignored (no log line)", async () => {
		const pending = runPsCommand("Blank-Stderr");
		const child = lastChild();
		dbgLog.length = 0;
		child.emitStderr("   \n");
		child.emitStdout(`${READY_MARKER}\n`);
		await tick();
		emitDoneFor(child, lastCommandId(child));
		await pending;
		expect(dbgLog.some((l) => l.includes("stderr:"))).toBe(false);
	});

	test("startPs's own non-win32 guard returns false without spawning", async () => {
		// runPsCommand's top guard reads process.platform once (line 417); if that
		// passes, ensurePs → startPs reads it again (line 309). Pin a counting
		// getter that reports win32 for the FIRST read (so runPsCommand proceeds)
		// and a non-win32 platform for the SECOND read (so startPs's own guard,
		// the only otherwise-unreachable branch, returns Promise.resolve(false)).
		const realDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		let reads = 0;
		Object.defineProperty(process, "platform", {
			configurable: true,
			get() {
				reads += 1;
				// First read = runPsCommand's guard (must be win32 to proceed),
				// second read = startPs's guard (non-win32 to hit the early return).
				return reads === 1 ? "win32" : "linux";
			},
		});
		const spawnsBefore = spawnLog.length;
		try {
			const result = await runPsCommand("Reach-StartPs-Guard");
			expect(result).toEqual({ ok: false, value: null });
			// startPs bailed before spawn(), so no new powershell.exe was launched.
			expect(spawnLog.length).toBe(spawnsBefore);
			// Both guards were consulted: runPsCommand's, then startPs's.
			expect(reads).toBeGreaterThanOrEqual(2);
		} finally {
			if (realDescriptor) {
				Object.defineProperty(process, "platform", realDescriptor);
			}
			setPlatform("win32");
		}
	});
});

describe("processStdoutLine / processStdoutLines (via post-ready stdout)", () => {
	test("VALUE marker then DONE marker resolves the command with the value", async () => {
		const child = await readyHost();
		const { promise, id } = await dispatch(child, "Get-Volume", { expectValue: true });
		child.emitStdout(`${VALUE_MARKER_PREFIX}${id}:0.42\n${DONE_MARKER_PREFIX}${id}\n`);
		expect(await promise).toEqual({ ok: true, value: "0.42" });
	});

	test("DONE without a preceding VALUE resolves value:null", async () => {
		const child = await readyHost();
		const { promise, id } = await dispatch(child, "Set-Volume 0.5");
		emitDoneFor(child, id);
		expect(await promise).toEqual({ ok: true, value: null });
	});

	test("VALUE marker with NO colon after the prefix is ignored (early return)", async () => {
		const child = await readyHost();
		const { promise, id } = await dispatch(child, "Quirk", { expectValue: true });
		// A malformed value line: prefix immediately followed by text, no ':' sep.
		child.emitStdout(`${VALUE_MARKER_PREFIX}noColonHere\n`);
		// The command is still pending — value stayed null. Now finish it.
		emitDoneFor(child, id);
		// Malformed VALUE was dropped → value remains null.
		expect(await promise).toEqual({ ok: true, value: null });
	});

	test("VALUE marker for an unknown id is dropped (no pending entry)", async () => {
		const child = await readyHost();
		const { promise, id } = await dispatch(child, "Known", { expectValue: true });
		// A stray VALUE for an id with no pending entry — req is undefined, skipped.
		child.emitStdout(`${VALUE_MARKER_PREFIX}999999:orphan\n`);
		// Now the real id gets its value + done.
		child.emitStdout(`${VALUE_MARKER_PREFIX}${id}:real\n${DONE_MARKER_PREFIX}${id}\n`);
		expect(await promise).toEqual({ ok: true, value: "real" });
	});

	test("DONE marker for an unknown id is ignored (no throw, no resolve)", async () => {
		const child = await readyHost();
		const { promise, id } = await dispatch(child, "Outstanding");
		// Stray DONE for an id we never issued.
		child.emitStdout(`${DONE_MARKER_PREFIX}424242\n`);
		// The real command is still pending; resolve it.
		emitDoneFor(child, id);
		expect(await promise).toEqual({ ok: true, value: null });
	});

	test("multiple lines in one chunk are all processed; blank lines skipped", async () => {
		const child = await readyHost();
		const a = await dispatch(child, "A", { expectValue: true });
		const b = await dispatch(child, "B", { expectValue: true });
		// One chunk carrying both commands' value+done, plus blank lines between.
		child.emitStdout(
			`${VALUE_MARKER_PREFIX}${a.id}:av\n\n${DONE_MARKER_PREFIX}${a.id}\n   \n${VALUE_MARKER_PREFIX}${b.id}:bv\n${DONE_MARKER_PREFIX}${b.id}\n`
		);
		expect(await a.promise).toEqual({ ok: true, value: "av" });
		expect(await b.promise).toEqual({ ok: true, value: "bv" });
	});

	test("a value line split ACROSS two chunks is buffered then resolved", async () => {
		const child = await readyHost();
		const { promise, id } = await dispatch(child, "Split", { expectValue: true });
		// First chunk has no trailing newline — buffered, not yet processed.
		child.emitStdout(`${VALUE_MARKER_PREFIX}${id}:par`);
		// Second chunk completes the value line and the done line.
		child.emitStdout(`tial\n${DONE_MARKER_PREFIX}${id}\n`);
		expect(await promise).toEqual({ ok: true, value: "partial" });
	});
});

describe("runPsCommand command dispatch", () => {
	test("expectValue=true wraps the command in a VALUE-marker WriteLine", async () => {
		const child = await readyHost();
		const { promise, id } = await dispatch(child, "[Audio]::GetVolume()", { expectValue: true });
		const written = child.stdin?.writes.join("") ?? "";
		expect(written).toContain(`${VALUE_MARKER_PREFIX}${id}:`);
		expect(written).toContain("[Audio]::GetVolume()");
		expect(written).toContain(`${DONE_MARKER_PREFIX}${id}`);
		child.emitStdout(`${VALUE_MARKER_PREFIX}${id}:0.9\n${DONE_MARKER_PREFIX}${id}\n`);
		await promise;
	});

	test("expectValue=false writes the raw command (no VALUE wrapper)", async () => {
		const child = await readyHost();
		const { promise, id } = await dispatch(child, "[Pasta]::Paste()");
		const written = child.stdin?.writes.join("") ?? "";
		expect(written).toContain("[Pasta]::Paste()");
		expect(written).not.toContain(VALUE_MARKER_PREFIX);
		expect(written).toContain(`${DONE_MARKER_PREFIX}${id}`);
		emitDoneFor(child, id);
		await promise;
	});

	test("command times out → resolves false AND tears down the wedged host", async () => {
		const realSetTimeout = globalThis.setTimeout;
		const timers: Array<{ fn: () => void; ms: number }> = [];
		(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
			fn: () => void,
			ms: number
		) => {
			timers.push({ fn, ms });
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		try {
			// Inline ready-up (the shared readyHost relies on the real setTimeout,
			// which we've replaced for this test). The setup timer never fires.
			const warm = runPsCommand("Warm");
			const child = lastChild();
			child.emitStdout(`${READY_MARKER}\n`);
			await waitForWrite(child, 1);
			emitDoneFor(child, lastCommandId(child));
			await warm;
			if (child.stdin) {
				child.stdin.writes.length = 0;
			}

			const p = runPsCommand("Hang-Forever", { timeoutMs: 1234 });
			// The command body (timer arm + stdin write) runs after the awaited
			// ensurePs — yield until the 1234ms timer has been registered.
			for (let i = 0; i < 5 && !timers.some((t) => t.ms === 1234); i += 1) {
				await tick();
			}
			// Fire the command timeout timer (the 1234ms one).
			const cmdTimer = timers.find((t) => t.ms === 1234);
			expect(cmdTimer).toBeDefined();
			cmdTimer?.fn();
			const result = await p;
			expect(result).toEqual({ ok: false, value: null });
			expect(dbgLog.some((l) => l.includes("command timed out"))).toBe(true);
			// shutdownPsHost killed the wedged child.
			expect(child.killed).toBe(true);
		} finally {
			(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
		}
	});

	test("a single command timeout recycles the host WITHOUT force-failing healthy siblings", async () => {
		// Regression: previously the timeout path called shutdownPsHost(), whose
		// failAllPending() loop force-resolved EVERY other in-flight command to
		// {ok:false} — one slow command collaterally killed all siblings. The fix
		// recycles the host (kills the wedged child + clears globals so the next
		// call respawns) but leaves the siblings pending on their own timeout.
		const realSetTimeout = globalThis.setTimeout;
		const timers: Array<{ fn: () => void; ms: number; fired: boolean }> = [];
		(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
			fn: () => void,
			ms: number
		) => {
			const entry = { fn, ms, fired: false };
			timers.push(entry);
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		try {
			// Inline ready-up (shared readyHost needs the real setTimeout).
			const warm = runPsCommand("Warm");
			const child = lastChild();
			child.emitStdout(`${READY_MARKER}\n`);
			await waitForWrite(child, 1);
			emitDoneFor(child, lastCommandId(child));
			await warm;
			if (child.stdin) {
				child.stdin.writes.length = 0;
			}

			// Command A (the one that will time out, 1111ms) and B (healthy
			// sibling, 9999ms) are both in-flight on the same host.
			const pA = runPsCommand("Slow-A", { timeoutMs: 1111 });
			for (let i = 0; i < 5 && !timers.some((t) => t.ms === 1111); i += 1) {
				await tick();
			}
			const idA = lastCommandId(child);
			const beforeB = child.stdin?.writes.length ?? 0;
			let bSettled = false;
			const pB = runPsCommand("Healthy-B", { timeoutMs: 9999 }).then((r) => {
				bSettled = true;
				return r;
			});
			await waitForWrite(child, beforeB);
			const idB = lastCommandId(child);
			expect(idB).not.toBe(idA);

			// Fire ONLY A's timeout.
			const aTimer = timers.find((t) => t.ms === 1111 && !t.fired);
			expect(aTimer).toBeDefined();
			if (aTimer) {
				aTimer.fired = true;
				aTimer.fn();
			}
			expect(await pA).toEqual({ ok: false, value: null });
			expect(dbgLog.some((l) => l.includes("recycling PS"))).toBe(true);
			// The wedged child was recycled (killed).
			expect(child.killed).toBe(true);

			// On a real ChildProcess `kill()` triggers an async `exit` event. Emit
			// it here: the exit handler must recognize the recycled instance and
			// SKIP failAllPending(), so the still-pending sibling B survives.
			child.emitExit(null, "SIGTERM");

			// Critical assertion: B was NOT collaterally force-failed — neither by
			// the timeout path nor by the recycled child's exit event. Give the
			// microtask queue a chance to flush — B must still be pending.
			await tick();
			await tick();
			expect(bSettled).toBe(false);

			// B keeps its own timeout timer as its safety net — firing it resolves
			// B false on its own terms (no collateral cancellation involved).
			const bTimer = timers.find((t) => t.ms === 9999 && !t.fired);
			expect(bTimer).toBeDefined();
			if (bTimer) {
				bTimer.fired = true;
				bTimer.fn();
			}
			expect(await pB).toEqual({ ok: false, value: null });
		} finally {
			(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
		}
	});

	test("a stale sibling timeout does NOT kill a fresh host spawned after recycle", async () => {
		// Regression guard: after command A recycles its host and a NEW host is
		// spawned for fresh work, A's (or another sibling's) late-firing timeout
		// must not kill the new healthy host — recyclePsHost(expected) no-ops when
		// the live process isn't the one the command was issued on.
		const realSetTimeout = globalThis.setTimeout;
		const timers: Array<{ fn: () => void; ms: number; fired: boolean }> = [];
		(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
			fn: () => void,
			ms: number
		) => {
			const entry = { fn, ms, fired: false };
			timers.push(entry);
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		try {
			const warm = runPsCommand("Warm");
			const child1 = lastChild();
			child1.emitStdout(`${READY_MARKER}\n`);
			await waitForWrite(child1, 1);
			emitDoneFor(child1, lastCommandId(child1));
			await warm;

			// Command on host #1, then recycle host #1 by timing it out.
			const pA = runPsCommand("On-Host-1", { timeoutMs: 1000 });
			for (let i = 0; i < 5 && !timers.some((t) => t.ms === 1000); i += 1) {
				await tick();
			}
			const aTimer = timers.find((t) => t.ms === 1000 && !t.fired);
			if (aTimer) {
				aTimer.fired = true;
				aTimer.fn();
			}
			await pA;
			expect(child1.killed).toBe(true);

			// A fresh host (#2) is spawned for new work.
			const spawnsBefore = spawnLog.length;
			const pNew = runPsCommand("On-Host-2", { timeoutMs: 2000 });
			expect(spawnLog.length).toBe(spawnsBefore + 1);
			const child2 = lastChild();
			child2.emitStdout(`${READY_MARKER}\n`);
			await waitForWrite(child2, 1);
			emitDoneFor(child2, lastCommandId(child2));
			await pNew;
			// child2 (the fresh host) was never touched by the stale recycle.
			expect(child2.killed).toBe(false);
		} finally {
			(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
		}
	});

	test("stdin write failure (mid-command) resolves false and clears the pending entry", async () => {
		const child = await readyHost();
		// Arm the command-write to throw.
		if (child.stdin) {
			child.stdin.throwOnWrite = true;
		}
		const result = await runPsCommand("Will-EPIPE");
		expect(result).toEqual({ ok: false, value: null });
		expect(dbgLog.some((l) => l.includes("stdin write failed"))).toBe(true);
	});

	test("ensurePs failing (spawn error) makes runPsCommand resolve false before dispatch", async () => {
		// Kick a fresh host: first runPsCommand spawns, we immediately error it.
		const p = runPsCommand("Cmd");
		const child = lastChild();
		child.emitError(new Error("spawn blew up"));
		const result = await p;
		expect(result).toEqual({ ok: false, value: null });
	});
});

describe("exit handling + failAllPending", () => {
	test("host exit fails all in-flight commands and clears the live process", async () => {
		const child = await readyHost();

		// Issue a command and let its write land (so it's registered in the
		// pending map) but DON'T resolve it — leave it pending so the exit
		// handler's failAllPending loop actually iterates over it.
		const { promise: inflight } = await dispatch(child, "Pending");
		// The host dies underneath it.
		child.emitExit(1, null);
		const result = await inflight;
		// failAllPending resolved it false.
		expect(result).toEqual({ ok: false, value: null });
		expect(dbgLog.some((l) => l.includes("exited code=1"))).toBe(true);

		// Because psProcess was cleared, the next command spawns a NEW host.
		const spawnsBefore = spawnLog.length;
		const p2 = runPsCommand("AfterDeath");
		expect(spawnLog.length).toBe(spawnsBefore + 1);
		const child2 = lastChild();
		child2.emitStdout(`${READY_MARKER}\n`);
		await waitForWrite(child2, 1);
		emitDoneFor(child2, lastCommandId(child2));
		await p2;
	});

	test("exit with a signal (null code) logs the signal name", async () => {
		const child = await readyHost();
		child.emitExit(null, "SIGTERM");
		expect(dbgLog.some((l) => l.includes("signal=SIGTERM"))).toBe(true);
	});
});

describe("shutdownPsHost", () => {
	test("ends stdin, kills the child, and fails all pending commands", async () => {
		const child = await readyHost();

		// Let the command's write land so it's in the pending map before we
		// shut down — exercises failAllPending's loop body (clearTimeout +
		// resolve(false)).
		const { promise: inflight } = await dispatch(child, "Pending");
		shutdownPsHost();
		const result = await inflight;
		expect(result).toEqual({ ok: false, value: null });
		expect(child.stdin?.ended).toBe(true);
		expect(child.killed).toBe(true);
	});

	test("is idempotent — second call is a harmless no-op", async () => {
		await readyHost();
		shutdownPsHost();
		expect(() => shutdownPsHost()).not.toThrow();
	});

	test("does NOT call kill when the child is already killed", async () => {
		const child = await readyHost();
		// Pre-kill the child, then assert shutdown does not re-kill it.
		child.killed = true;
		let killCalls = 0;
		const realKill = child.kill;
		child.kill = () => {
			killCalls += 1;
			return realKill();
		};
		shutdownPsHost();
		expect(killCalls).toBe(0);
	});

	test("swallows errors thrown by stdin.end and kill", async () => {
		const child = await readyHost();
		if (child.stdin) {
			child.stdin.throwOnEnd = true;
		}
		child.kill = () => {
			throw new Error("kill failed");
		};
		expect(() => shutdownPsHost()).not.toThrow();
	});
});

// --- Helper that arms a throwing setup-write -------------------------------
// startPs writes the SETUP_SCRIPT synchronously right after spawn, so the
// child's stdin must throw on its first `write`. The spawn mock reads
// `spawnStub.throwOnSetupWrite` when constructing the child's stdin.
function runPsCommandWithThrowingSetupWrite(cmd: string): Promise<{
	ok: boolean;
	value: string | null;
}> {
	spawnStub.throwOnSetupWrite = true;
	return runPsCommand(cmd);
}
