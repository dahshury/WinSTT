import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "../../test/mocks/electron";

const guardLog: boolean[] = [];
mock.module("../ipc/hotkey", () => ({
	setPasteGuard: (active: boolean) => {
		guardLog.push(active);
	},
}));

let lastClipboard = "";
let clipboardThrowOnNext = false;
const emptyImage = { isEmpty: () => true } as unknown as Electron.NativeImage;
mock.module("electron", () => {
	const base = electronMock();
	base.clipboard = {
		writeText: (text: string) => {
			if (clipboardThrowOnNext) {
				clipboardThrowOnNext = false;
				throw new Error("simulated clipboard failure");
			}
			lastClipboard = text;
		},
		readText: () => lastClipboard,
		clear: () => {
			lastClipboard = "";
		},
		// captureClipboardSnapshot / restoreClipboardSnapshot use these as
		// part of the multi-format save/restore. The text-only mock surface
		// is sufficient — the test asserts on `lastClipboard` only.
		readHTML: () => "",
		readRTF: () => "",
		readImage: () => emptyImage,
		write: (payload: { text?: string }) => {
			if (typeof payload.text === "string") {
				lastClipboard = payload.text;
			}
		},
	} as unknown as Electron.Clipboard;
	// Don't replace `base.app` — other test files share this process-global
	// mock and rely on full app surface (getPath, on, etc).
	(base.app as unknown as { isPackaged: boolean }).isPackaged = false;
	return base;
});

// Pretend the binary always exists so paste.ts gets past its existsSync check.
// Spread the real `node:fs` so other test files (which share the process-global
// mock registry) don't break when they import readFileSync, statSync, etc.
import * as realFs from "node:fs";

mock.module("node:fs", () => ({
	...realFs,
	existsSync: () => true,
}));

// Stub the native helper. Capture spawn invocations and let tests toggle outcome.
interface SpawnArgs {
	args: string[];
	cmd: string;
	stdin: string;
}
const spawnLog: SpawnArgs[] = [];
const spawnStub: {
	emitError?: string | undefined;
	exitCode: number;
	hangs: boolean;
	stderr?: string | undefined;
	throwOnSpawn?: string | undefined;
	/** When set, the Nth spawn uses this exit code instead of `exitCode`. */
	exitCodeSequence?: number[] | undefined;
} = {
	exitCode: 0,
	hangs: false,
};
mock.module("node:child_process", () => ({
	spawn: (cmd: string, args: string[]) => {
		const record: SpawnArgs = { cmd, args, stdin: "" };
		spawnLog.push(record);
		if (spawnStub.throwOnSpawn) {
			const msg = spawnStub.throwOnSpawn;
			spawnStub.throwOnSpawn = undefined;
			throw new Error(msg);
		}
		const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
		const stderrHandlers: Array<(chunk: Buffer) => void> = [];
		const stdinHandlers = new Map<string, Array<(...a: unknown[]) => void>>();
		const stdin = {
			on: (ev: string, fn: (...a: unknown[]) => void) => {
				const list = stdinHandlers.get(ev) ?? [];
				list.push(fn);
				stdinHandlers.set(ev, list);
			},
			end: (text: string) => {
				record.stdin += text;
			},
		};
		const child = {
			stdout: {
				on: () => undefined,
			},
			stderr: {
				on: (_ev: string, fn: (chunk: Buffer) => void) => {
					stderrHandlers.push(fn);
				},
			},
			// Only expose stdin when the caller passed `--type` — mirrors the
			// real spawnInto() which sets stdio[0] = "pipe" only in that case.
			stdin: args.includes("--type") ? stdin : null,
			on: (ev: string, fn: (...a: unknown[]) => void) => {
				const list = handlers.get(ev) ?? [];
				list.push(fn);
				handlers.set(ev, list);
			},
			kill: () => undefined,
		};
		const spawnIndex = spawnLog.length - 1;
		// Fire the configured outcome on next microtask so the await in
		// runBinary actually awaits something.
		queueMicrotask(() => {
			if (spawnStub.hangs) {
				return;
			}
			if (spawnStub.stderr) {
				for (const fn of stderrHandlers) {
					fn(Buffer.from(spawnStub.stderr));
				}
			}
			if (spawnStub.emitError) {
				for (const fn of handlers.get("error") ?? []) {
					fn(new Error(spawnStub.emitError));
				}
			}
			const exit = spawnStub.exitCodeSequence?.[spawnIndex] ?? spawnStub.exitCode;
			for (const fn of handlers.get("close") ?? []) {
				fn(exit);
			}
		});
		return child;
	},
}));

const {
	pasteText,
	flushPastePending,
	__resetPasteForTesting__,
	__setCooldownUntilForTesting__,
	__getCooldownUntilForTesting__,
	__getLastSpawnFinishedAtForTesting__,
	__setLastSpawnFinishedAtForTesting__,
	__makeBinaryRunForTesting__,
	finishBinaryRun,
	killBinaryOnTimeout,
	closeBinaryRun,
	writeClipboard,
	enforcePaceGap,
	computePaceWait,
	isSlowPaste,
	handleBinaryResult,
	decideSpawnTarget,
	shouldSkipPaste,
	makeBinaryRun,
	spawnInto,
	attachChildHandlers,
	startBinaryRun,
} = await import("./paste");

import { beforeEach } from "bun:test";

beforeEach(() => {
	__resetPasteForTesting__();
	spawnStub.exitCode = 0;
	spawnStub.hangs = false;
	spawnStub.emitError = undefined;
	spawnStub.stderr = undefined;
	spawnStub.throwOnSpawn = undefined;
	spawnStub.exitCodeSequence = undefined;
	clipboardThrowOnNext = false;
});

describe("pasteText", () => {
	test("module imports without throwing under mocked deps", () => {
		expect(typeof pasteText).toBe("function");
		expect(typeof flushPastePending).toBe("function");
	});

	test("is a no-op when text is empty", async () => {
		const beforeGuards = guardLog.length;
		const beforeSpawns = spawnLog.length;
		lastClipboard = "";
		pasteText("");
		await flushPastePending();
		expect(lastClipboard).toBe("");
		expect(guardLog.length).toBe(beforeGuards);
		expect(spawnLog.length).toBe(beforeSpawns);
	});

	test("on win32: skips clipboard, toggles guard, spawns winstt-paste.exe --type with text on stdin", async () => {
		if (process.platform !== "win32") {
			return;
		}
		guardLog.length = 0;
		spawnLog.length = 0;
		lastClipboard = "user-prior-content";
		spawnStub.exitCode = 0;
		spawnStub.hangs = false;
		spawnStub.emitError = undefined;
		pasteText("hello world");
		await flushPastePending();
		// CRITICAL: the user's clipboard must NOT be touched in the success path.
		expect(lastClipboard).toBe("user-prior-content");
		expect(guardLog).toEqual([true, false]);
		expect(spawnLog.length).toBe(1);
		expect(spawnLog[0]?.cmd).toContain("winstt-paste.exe");
		expect(spawnLog[0]?.args).toEqual(["--type"]);
		expect(spawnLog[0]?.stdin).toBe("hello world");
	});

	test("paste guard is cleared even when the binary fails", async () => {
		if (process.platform !== "win32") {
			return;
		}
		guardLog.length = 0;
		spawnStub.exitCode = 1;
		spawnStub.hangs = false;
		spawnStub.emitError = undefined;
		pasteText("oops");
		await flushPastePending();
		// CRITICAL: guard MUST end in `false` even when paste fails — otherwise
		// the uiohook hotkey handler stays blocked and the app appears frozen.
		expect(guardLog.at(-1)).toBe(false);
	});

	test("does not throw for repeated invocations", async () => {
		spawnStub.exitCode = 0;
		expect(() => {
			pasteText("a");
			pasteText("b");
			pasteText("c");
		}).not.toThrow();
		await flushPastePending();
	});

	test("on win32: serial pastes never touch the clipboard and guard cleanly toggles", async () => {
		if (process.platform !== "win32") {
			return;
		}
		guardLog.length = 0;
		spawnLog.length = 0;
		lastClipboard = "";
		spawnStub.exitCode = 0;
		pasteText("alpha");
		pasteText("beta");
		pasteText("gamma");
		await flushPastePending();
		expect(guardLog).toEqual([true, false, true, false, true, false]);
		// Each spawn used --type mode, so clipboard never received the text.
		expect(lastClipboard).toBe("");
		expect(spawnLog.length).toBe(3);
		expect(spawnLog.map((s) => s.stdin)).toEqual(["alpha", "beta", "gamma"]);
	});

	test("on win32: --type failure falls back to clipboard + Ctrl+V and restores", async () => {
		if (process.platform !== "win32") {
			return;
		}
		spawnLog.length = 0;
		lastClipboard = "original-clipboard";
		// First spawn (--type) fails, second spawn (Ctrl+V fallback) succeeds.
		spawnStub.exitCodeSequence = [1, 0];
		pasteText("transcript");
		await flushPastePending();
		// Two spawns: one --type, one Ctrl+V (no args).
		expect(spawnLog.length).toBe(2);
		expect(spawnLog[0]?.args).toEqual(["--type"]);
		expect(spawnLog[0]?.stdin).toBe("transcript");
		expect(spawnLog[1]?.args).toEqual([]);
		// The fallback writes the transcript onto the clipboard then restores
		// the user's original value. Final state: original is back.
		expect(lastClipboard).toBe("original-clipboard");
	});

	test("on win32: cooldown drops the paste silently — clipboard untouched, no spawn", async () => {
		if (process.platform !== "win32") {
			return;
		}
		spawnLog.length = 0;
		lastClipboard = "user-content";
		// First paste: BOTH --type and the clipboard fallback fail. Cooldown trips.
		spawnStub.exitCodeSequence = [1, 1];
		pasteText("first");
		await flushPastePending();
		// 2 spawns (type + fallback). Clipboard restored to original.
		expect(spawnLog.length).toBe(2);
		expect(lastClipboard).toBe("user-content");

		// Second paste arrives within cooldown — we drop it entirely.
		spawnLog.length = 0;
		spawnStub.exitCodeSequence = undefined;
		spawnStub.exitCode = 0;
		pasteText("second");
		await flushPastePending();
		// No spawn AND no clipboard write — the user's clipboard stays intact.
		expect(spawnLog.length).toBe(0);
		expect(lastClipboard).toBe("user-content");
	});
});

describe("getBinaryCandidate (dev path branch)", () => {
	test("on win32: when app.isPackaged=false, the dev path includes 'electron/native/bin/winstt-paste.exe'", async () => {
		if (process.platform !== "win32") {
			return;
		}
		// Lock down the dev path components — "..", "electron", "native",
		// "bin", "winstt-paste.exe". Mutating any of these strings would
		// produce a different path; assert all five segments appear in order.
		const electron = await import("electron");
		const original = (electron.app as unknown as { isPackaged: boolean }).isPackaged;
		(electron.app as unknown as { isPackaged: boolean }).isPackaged = false;
		try {
			__resetPasteForTesting__();
			spawnLog.length = 0;
			spawnStub.exitCode = 0;
			pasteText("dev-mode");
			await flushPastePending();
			expect(spawnLog.length).toBe(1);
			const cmd = (spawnLog[0]?.cmd ?? "").replace(/\\/g, "/");
			expect(cmd).toMatch(/native\/bin\/winstt-paste\.exe$/);
			expect(cmd).toMatch(/electron\/electron\/native\/bin\/winstt-paste\.exe$/);
		} finally {
			(electron.app as unknown as { isPackaged: boolean }).isPackaged = original;
			__resetPasteForTesting__();
		}
	});
});

describe("getBinary cache short-circuit", () => {
	test("getBinary caches the resolved path so resolveBinary runs once", async () => {
		if (process.platform !== "win32") {
			return;
		}
		__resetPasteForTesting__();
		spawnLog.length = 0;
		spawnStub.exitCode = 0;
		pasteText("first");
		await flushPastePending();
		pasteText("second");
		await flushPastePending();
		expect(spawnLog.length).toBe(2);
		// Both calls should use the SAME binary path (cached).
		expect(spawnLog[0]?.cmd).toBe(spawnLog[1]?.cmd);
	});
});

describe("getBinaryCandidate (packaged path branch)", () => {
	test("on win32: when app.isPackaged=true, spawns from process.resourcesPath/native/bin/winstt-paste.exe", async () => {
		if (process.platform !== "win32") {
			return;
		}
		const electron = await import("electron");
		const original = (electron.app as unknown as { isPackaged: boolean }).isPackaged;
		(electron.app as unknown as { isPackaged: boolean }).isPackaged = true;
		const originalRes = (process as unknown as { resourcesPath: string }).resourcesPath;
		(process as unknown as { resourcesPath: string }).resourcesPath = "C:/mock/resources";
		try {
			__resetPasteForTesting__();
			spawnLog.length = 0;
			spawnStub.exitCode = 0;
			pasteText("packaged");
			await flushPastePending();
			expect(spawnLog.length).toBe(1);
			const cmd = spawnLog[0]?.cmd ?? "";
			expect(cmd).toContain("native");
			expect(cmd).toContain("bin");
			expect(cmd).toContain("winstt-paste.exe");
			expect(cmd.replace(/\\/g, "/")).toContain("C:/mock/resources");
		} finally {
			(electron.app as unknown as { isPackaged: boolean }).isPackaged = original;
			(process as unknown as { resourcesPath: string }).resourcesPath = originalRes;
			__resetPasteForTesting__();
		}
	});
});

describe("shouldSkipPaste", () => {
	test("returns true for empty text", () => {
		expect(shouldSkipPaste("")).toBe(true);
	});

	test("returns true on non-win32 platforms", () => {
		const original = process.platform;
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		try {
			expect(shouldSkipPaste("hi")).toBe(true);
		} finally {
			Object.defineProperty(process, "platform", { value: original, configurable: true });
		}
	});

	test("returns false for non-empty text on win32", () => {
		if (process.platform !== "win32") {
			return;
		}
		expect(shouldSkipPaste("hi")).toBe(false);
	});
});

describe("pasteText (non-win32 early return)", () => {
	test("on non-win32 platforms pasteText is a no-op without spawning", async () => {
		const original = process.platform;
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		const beforeSpawns = spawnLog.length;
		try {
			pasteText("ignored");
			await flushPastePending();
			expect(spawnLog.length).toBe(beforeSpawns);
		} finally {
			Object.defineProperty(process, "platform", { value: original, configurable: true });
		}
	});
});

describe("isSlowPaste", () => {
	test("returns false when both values are within budget", () => {
		expect(isSlowPaste(100, 100)).toBe(false);
	});

	test("returns true when waitedMs exceeds 250", () => {
		expect(isSlowPaste(251, 0)).toBe(true);
	});

	test("returns true when elapsed exceeds 300", () => {
		expect(isSlowPaste(0, 301)).toBe(true);
	});

	test("returns false at boundary values", () => {
		expect(isSlowPaste(250, 300)).toBe(false);
	});
});

describe("computePaceWait", () => {
	test("returns 0 when the gap has fully elapsed", () => {
		// now - lastFinishedAt > PASTE_MIN_GAP_MS (350)
		expect(computePaceWait(1000, 0)).toBe(0);
	});

	test("returns the remaining wait when within the gap", () => {
		// now=100, lastFinishedAt=0 → sinceLast=100 → wait=350-100=250
		expect(computePaceWait(100, 0)).toBe(250);
	});

	test("returns 0 exactly at the boundary", () => {
		// sinceLast == PASTE_MIN_GAP_MS → wait = 0
		expect(computePaceWait(350, 0)).toBe(0);
	});
});

describe("enforcePaceGap", () => {
	test("returns immediately when no spawn has happened yet", async () => {
		__resetPasteForTesting__();
		const t0 = Date.now();
		await enforcePaceGap();
		// Should be near-instant (well under the 350ms gap).
		expect(Date.now() - t0).toBeLessThan(50);
	});

	test("waits when a recent spawn finished within the gap", async () => {
		__setLastSpawnFinishedAtForTesting__(Date.now() - 100);
		const t0 = Date.now();
		await enforcePaceGap();
		// Should have waited ~250ms (350 - 100); give a generous lower bound.
		expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
	});
});

describe("writeClipboard", () => {
	test("returns true on success and stores the text", () => {
		lastClipboard = "";
		expect(writeClipboard("hello")).toBe(true);
		expect(lastClipboard).toBe("hello");
	});

	test("returns false and logs when clipboard.writeText throws", () => {
		clipboardThrowOnNext = true;
		expect(writeClipboard("should-fail")).toBe(false);
	});
});

describe("decideSpawnTarget", () => {
	test("returns the binary path when no cooldown is active", () => {
		__resetPasteForTesting__();
		const result = decideSpawnTarget(Date.now());
		// Either we have a binary (win32 mock returns one) or we don't.
		if (process.platform === "win32") {
			expect(typeof result).toBe("string");
			expect(result).toContain("winstt-paste.exe");
		} else {
			expect(result).toBe(null);
		}
	});

	test("returns null when the cooldown is active", () => {
		if (process.platform !== "win32") {
			return;
		}
		__resetPasteForTesting__();
		const now = Date.now();
		__setCooldownUntilForTesting__(now + 5000);
		expect(decideSpawnTarget(now)).toBe(null);
	});
});

describe("handleBinaryResult", () => {
	test("does NOT trip cooldown on success", () => {
		__resetPasteForTesting__();
		handleBinaryResult({ ok: true }, 50, 10);
		expect(__getCooldownUntilForTesting__()).toBe(0);
	});

	test("logs the slow-paste warning when over budget but does not trip cooldown", () => {
		__resetPasteForTesting__();
		handleBinaryResult({ ok: true }, 500, 500);
		expect(__getCooldownUntilForTesting__()).toBe(0);
	});

	test("trips cooldown when ok=false (with reason)", () => {
		__resetPasteForTesting__();
		handleBinaryResult({ ok: false, reason: "boom" }, 100, 0);
		expect(__getCooldownUntilForTesting__()).toBeGreaterThan(Date.now());
	});

	test("trips cooldown when ok=false (no reason)", () => {
		__resetPasteForTesting__();
		handleBinaryResult({ ok: false }, 100, 0);
		expect(__getCooldownUntilForTesting__()).toBeGreaterThan(Date.now());
	});
});

describe("finishBinaryRun", () => {
	test("resolves once with the given outcome", () => {
		const resolutions: Array<{ ok: boolean; reason?: string }> = [];
		const run = __makeBinaryRunForTesting__((v) => {
			resolutions.push(v);
		});
		finishBinaryRun(run, true, undefined);
		expect(resolutions).toEqual([{ ok: true }]);
		expect(run.done).toBe(true);
	});

	test("is idempotent — second call is a no-op", () => {
		let count = 0;
		const run = __makeBinaryRunForTesting__(() => {
			count++;
		});
		finishBinaryRun(run, true, undefined);
		finishBinaryRun(run, false, "ignored");
		expect(count).toBe(1);
	});

	test("clears the kill timer when one is set", () => {
		const run = __makeBinaryRunForTesting__(() => undefined);
		const timer = setTimeout(() => undefined, 10_000);
		run.killTimer = timer;
		finishBinaryRun(run, true, undefined);
		expect(run.killTimer === null).toBe(true);
		expect(run.done).toBe(true);
		// The timer is already cleared by finishBinaryRun; this is just belt-and-braces.
		clearTimeout(timer);
	});
});

describe("killBinaryOnTimeout", () => {
	test("calls child.kill and finishes with timeout reason", () => {
		let killed = false;
		const resolutions: Array<{ ok: boolean; reason?: string }> = [];
		const run = __makeBinaryRunForTesting__((v) => {
			resolutions.push(v);
		});
		run.child = {
			kill: () => {
				killed = true;
				return true;
			},
		} as unknown as typeof run.child;
		killBinaryOnTimeout(run);
		expect(killed).toBe(true);
		expect(resolutions.length).toBe(1);
		expect(resolutions[0]?.ok).toBe(false);
		expect(resolutions[0]?.reason ?? "").toContain("timed out");
	});

	test("swallows kill errors and still finishes", () => {
		const resolutions: Array<{ ok: boolean; reason?: string }> = [];
		const run = __makeBinaryRunForTesting__((v) => {
			resolutions.push(v);
		});
		run.child = {
			kill: () => {
				throw new Error("nope");
			},
		} as unknown as typeof run.child;
		expect(() => killBinaryOnTimeout(run)).not.toThrow();
		expect(resolutions.length).toBe(1);
		expect(resolutions[0]?.ok).toBe(false);
	});

	test("handles a null child gracefully", () => {
		const resolutions: Array<{ ok: boolean; reason?: string }> = [];
		const run = __makeBinaryRunForTesting__((v) => {
			resolutions.push(v);
		});
		run.child = null;
		killBinaryOnTimeout(run);
		expect(resolutions.length).toBe(1);
		expect(resolutions[0]?.ok).toBe(false);
	});
});

describe("closeBinaryRun", () => {
	test("resolves with ok=true when exit code is 0", () => {
		const resolutions: Array<{ ok: boolean; reason?: string }> = [];
		const run = __makeBinaryRunForTesting__((v) => {
			resolutions.push(v);
		});
		closeBinaryRun(run, 0);
		expect(resolutions).toEqual([{ ok: true }]);
	});

	test("resolves with ok=false and the exit code when non-zero", () => {
		const resolutions: Array<{ ok: boolean; reason?: string }> = [];
		const run = __makeBinaryRunForTesting__((v) => {
			resolutions.push(v);
		});
		closeBinaryRun(run, 1);
		expect(resolutions.length).toBe(1);
		expect(resolutions[0]?.ok).toBe(false);
		expect(resolutions[0]?.reason).toBe("exit 1");
	});

	test("includes trimmed stderr when present", () => {
		const resolutions: Array<{ ok: boolean; reason?: string }> = [];
		const run = __makeBinaryRunForTesting__((v) => {
			resolutions.push(v);
		});
		run.stderrBuf = "  bad thing happened\n";
		closeBinaryRun(run, 2);
		expect(resolutions[0]?.reason).toBe("exit 2: bad thing happened");
	});

	test("handles a null exit code by reporting it", () => {
		const resolutions: Array<{ ok: boolean; reason?: string }> = [];
		const run = __makeBinaryRunForTesting__((v) => {
			resolutions.push(v);
		});
		closeBinaryRun(run, null);
		expect(resolutions[0]?.ok).toBe(false);
		expect(resolutions[0]?.reason).toBe("exit null");
	});
});

describe("runBinary stderr accumulation", () => {
	test("stderr chunks accumulate into run.stderrBuf via attachChildHandlers", async () => {
		if (process.platform !== "win32") {
			return;
		}
		const calls: Array<{ ok: boolean; reason?: string }> = [];
		const run = makeBinaryRun((v) => calls.push(v));
		spawnStub.exitCode = 9;
		spawnStub.stderr = "diagnostic chatter";
		expect(spawnInto(run, "C:/fake/binary.exe")).toBe(true);
		attachChildHandlers(run);
		// The mock fires stderr → close on the next microtask.
		await Promise.resolve();
		await Promise.resolve();
		expect(calls.length).toBe(1);
		expect(calls[0]?.ok).toBe(false);
		expect(calls[0]?.reason).toBe("exit 9: diagnostic chatter");
	});

	test("process 'error' event resolves the run with the error message", async () => {
		if (process.platform !== "win32") {
			return;
		}
		const calls: Array<{ ok: boolean; reason?: string }> = [];
		const run = makeBinaryRun((v) => calls.push(v));
		spawnStub.emitError = "kernel exploded";
		expect(spawnInto(run, "C:/fake/binary.exe")).toBe(true);
		attachChildHandlers(run);
		await Promise.resolve();
		await Promise.resolve();
		expect(calls.length).toBe(1);
		expect(calls[0]?.ok).toBe(false);
		expect(calls[0]?.reason).toContain("process error");
		expect(calls[0]?.reason).toContain("kernel exploded");
	});
});

describe("__getLastSpawnFinishedAtForTesting__", () => {
	test("reads back the value set by __setLastSpawnFinishedAtForTesting__", () => {
		__setLastSpawnFinishedAtForTesting__(12_345);
		expect(__getLastSpawnFinishedAtForTesting__()).toBe(12_345);
		__resetPasteForTesting__();
		expect(__getLastSpawnFinishedAtForTesting__()).toBe(0);
	});
});

describe("makeBinaryRun", () => {
	test("returns a fresh, un-done BinaryRun bound to the given resolve", () => {
		const calls: Array<{ ok: boolean; reason?: string }> = [];
		const run = makeBinaryRun((v) => {
			calls.push(v);
		});
		expect(run.done).toBe(false);
		expect(run.child === null).toBe(true);
		expect(run.killTimer === null).toBe(true);
		expect(run.stderrBuf).toBe("");
		// Resolve callback wiring: invoke via finishBinaryRun and watch the array.
		finishBinaryRun(run, true, undefined);
		expect(calls).toEqual([{ ok: true }]);
	});
});

describe("spawnInto", () => {
	test("on win32: returns true and populates run.child on a clean spawn", () => {
		if (process.platform !== "win32") {
			return;
		}
		spawnLog.length = 0;
		const run = makeBinaryRun(() => undefined);
		const ok = spawnInto(run, "C:/fake/binary.exe");
		expect(ok).toBe(true);
		expect(run.child === null).toBe(false);
		expect(spawnLog.length).toBeGreaterThanOrEqual(1);
	});

	test("on win32: returns false and finishes the run when spawn throws", () => {
		if (process.platform !== "win32") {
			return;
		}
		const calls: Array<{ ok: boolean; reason?: string }> = [];
		const run = makeBinaryRun((v) => {
			calls.push(v);
		});
		spawnStub.throwOnSpawn = "EBUSY";
		const ok = spawnInto(run, "C:/fake/binary.exe");
		expect(ok).toBe(false);
		expect(calls.length).toBe(1);
		expect(calls[0]?.ok).toBe(false);
		expect(calls[0]?.reason).toContain("spawn failed");
		expect(calls[0]?.reason).toContain("EBUSY");
	});
});

describe("attachChildHandlers", () => {
	test("returns silently when run.child is null", () => {
		const run = makeBinaryRun(() => undefined);
		run.child = null;
		expect(() => attachChildHandlers(run)).not.toThrow();
	});

	test("on win32: wires stderr/error/close so the configured outcome resolves the run", async () => {
		if (process.platform !== "win32") {
			return;
		}
		const calls: Array<{ ok: boolean; reason?: string }> = [];
		const run = makeBinaryRun((v) => {
			calls.push(v);
		});
		spawnStub.exitCode = 0;
		expect(spawnInto(run, "C:/fake/binary.exe")).toBe(true);
		attachChildHandlers(run);
		// The mock stub fires `close` on the next microtask. Yield twice so the
		// queued microtask runs before we assert.
		await Promise.resolve();
		await Promise.resolve();
		expect(calls.length).toBe(1);
		expect(calls[0]?.ok).toBe(true);
	});
});

describe("startBinaryRun", () => {
	test("on win32: arms the kill timer and attaches handlers on a clean spawn", () => {
		if (process.platform !== "win32") {
			return;
		}
		const calls: Array<{ ok: boolean; reason?: string }> = [];
		const run = startBinaryRun((v) => calls.push(v), "C:/fake/binary.exe");
		expect(run.killTimer === null).toBe(false);
		expect(run.child === null).toBe(false);
		// Clean up the kill timer so the test doesn't leak a 2.5s timeout.
		if (run.killTimer) {
			clearTimeout(run.killTimer);
		}
	});

	test("on win32: short-circuits handler wiring when spawn fails", () => {
		if (process.platform !== "win32") {
			return;
		}
		const calls: Array<{ ok: boolean; reason?: string }> = [];
		spawnStub.throwOnSpawn = "spawn-blew-up";
		const run = startBinaryRun((v) => calls.push(v), "C:/fake/binary.exe");
		// The spawn failure path called finishBinaryRun, which clears the timer
		// and pushes a failure outcome.
		expect(run.done).toBe(true);
		expect(calls.length).toBe(1);
		expect(calls[0]?.ok).toBe(false);
		expect(calls[0]?.reason).toContain("spawn failed");
	});
});
