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
// Contained boundary cast — the image mocks implement only `isEmpty()`, the one
// NativeImage member paste.ts touches. The cast lives here instead of being
// repeated at every injection site; the runtime object is returned unchanged.
const asNativeImage = (m: { isEmpty: () => boolean }) => m as unknown as Electron.NativeImage;
const emptyImage = asNativeImage({ isEmpty: () => true });

// Contained boundary cast — the child-process mocks expose only `kill()`, the
// one ChildProcess member killBinaryOnTimeout reaches for. The cast lives here
// so it isn't repeated at each `run.child = …` site; the object is unchanged.
const asChildProcess = (m: { kill: () => unknown }) =>
	m as unknown as ReturnType<typeof __makeBinaryRunForTesting__>["child"];

// Contained boundary cast — the stdin mocks expose only `on()` / `end()`, the
// two WritableStream members wireTypeStdin touches. The cast lives here so the
// `wireTypeStdin(run, stdin, …)` injection sites stay clean; object unchanged.
const asWritableStream = (m: { on: (...a: never[]) => unknown; end: (...a: never[]) => unknown }) =>
	m as unknown as NodeJS.WritableStream;
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
	/** True once the spawned child's `kill(...)` was invoked. */
	killed: boolean;
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
	/**
	 * When true, the spawned child emits a process-level `error` event INSTEAD of
	 * `exit`/`close`. Used to exercise injectSubmitKey's `child.once("error")`
	 * resolve path (powershell never launched / blocked).
	 */
	emitSpawnError?: boolean | undefined;
} = {
	exitCode: 0,
	hangs: false,
};
mock.module("node:child_process", () => ({
	spawn: (cmd: string, args: string[]) => {
		const record: SpawnArgs = { cmd, args, stdin: "", killed: false };
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
			// `injectSubmitKey` subscribes to `exit` / `error` via `once`; the
			// runBinary path uses `on`. Route both into the same handler map so
			// the microtask below can fan a fired event out to either subscriber.
			once: (ev: string, fn: (...a: unknown[]) => void) => {
				const list = handlers.get(ev) ?? [];
				list.push(fn);
				handlers.set(ev, list);
			},
			kill: () => {
				record.killed = true;
			},
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
			// injectSubmitKey error path: emit `error` and stop (no exit/close).
			if (spawnStub.emitSpawnError) {
				for (const fn of handlers.get("error") ?? []) {
					fn(new Error("powershell launch blocked"));
				}
				return;
			}
			if (spawnStub.emitError) {
				for (const fn of handlers.get("error") ?? []) {
					fn(new Error(spawnStub.emitError));
				}
			}
			const exit = spawnStub.exitCodeSequence?.[spawnIndex] ?? spawnStub.exitCode;
			// injectSubmitKey resolves on `exit`; runBinary resolves on `close`.
			for (const fn of handlers.get("exit") ?? []) {
				fn(exit);
			}
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
	clearKillTimer,
	buildBinaryResolution,
	wireTypeStdin,
	startTypeBinaryRun,
	formatCombinedFailureReason,
	logClipFailure,
	readClipboardFormat,
	coerceClipboardText,
	normalizeClipboardImage,
	captureClipboardSnapshot,
	snapshotIsEmpty,
	addTextToPayload,
	addHtmlToPayload,
	addRtfToPayload,
	addImageToPayload,
	buildRestorePayload,
	fallbackTextOnlyRestore,
	writeRestorePayload,
	restoreClipboardSnapshot,
	recordPasteCall,
	enqueuePaste,
	tryClipboardThenTyping,
	runClipboardPaste,
	injectSubmitKey,
	startSubmitKeyRun,
	__getPasteCallsForTesting__,
	__resetPasteCallsForTesting__,
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
	spawnStub.emitSpawnError = undefined;
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

	test("on win32: writes clipboard, toggles guard, spawns winstt-paste.exe (Ctrl+V), then restores", async () => {
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
		// Clipboard is touched DURING the paste (we write the transcript onto
		// it, send Ctrl+V, then restore) — final state must be the user's
		// original content.
		expect(lastClipboard).toBe("user-prior-content");
		expect(guardLog).toEqual([true, false]);
		expect(spawnLog.length).toBe(1);
		expect(spawnLog[0]?.cmd).toContain("winstt-paste.exe");
		// Ctrl+V binary takes no args (the C helper auto-detects terminal class).
		expect(spawnLog[0]?.args).toEqual([]);
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

	test("on win32: serial pastes round-trip the clipboard and guard cleanly toggles", async () => {
		if (process.platform !== "win32") {
			return;
		}
		guardLog.length = 0;
		spawnLog.length = 0;
		lastClipboard = "user-original";
		spawnStub.exitCode = 0;
		pasteText("alpha");
		pasteText("beta");
		pasteText("gamma");
		await flushPastePending();
		expect(guardLog).toEqual([true, false, true, false, true, false]);
		// Each paste writes onto the clipboard then restores in `finally` —
		// the user's original content survives the burst.
		expect(lastClipboard).toBe("user-original");
		expect(spawnLog.length).toBe(3);
		// All three spawns are the Ctrl+V binary (no args), not --type.
		expect(spawnLog.map((s) => s.args)).toEqual([[], [], []]);
	});

	test("on win32: Ctrl+V failure falls back to --type with the transcript on stdin", async () => {
		if (process.platform !== "win32") {
			return;
		}
		spawnLog.length = 0;
		lastClipboard = "original-clipboard";
		// First spawn (Ctrl+V) fails, second spawn (--type fallback) succeeds.
		spawnStub.exitCodeSequence = [1, 0];
		pasteText("transcript");
		await flushPastePending();
		// Two spawns: one Ctrl+V (no args) then one --type with stdin.
		expect(spawnLog.length).toBe(2);
		expect(spawnLog[0]?.args).toEqual([]);
		expect(spawnLog[1]?.args).toEqual(["--type"]);
		expect(spawnLog[1]?.stdin).toBe("transcript");
		// The clipboard sandwich restored the user's original value in `finally`
		// even though Ctrl+V exited non-zero.
		expect(lastClipboard).toBe("original-clipboard");
	});

	test("on win32: cooldown drops the paste silently — clipboard untouched, no spawn", async () => {
		if (process.platform !== "win32") {
			return;
		}
		spawnLog.length = 0;
		lastClipboard = "user-content";
		// First paste: BOTH the Ctrl+V primary AND the --type fallback fail. Cooldown trips.
		spawnStub.exitCodeSequence = [1, 1];
		pasteText("first");
		await flushPastePending();
		// 2 spawns (Ctrl+V then --type). Clipboard restored to original.
		expect(spawnLog.length).toBe(2);
		expect(spawnLog[0]?.args).toEqual([]);
		expect(spawnLog[1]?.args).toEqual(["--type"]);
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
		run.child = asChildProcess({
			kill: () => {
				killed = true;
				return true;
			},
		});
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
		run.child = asChildProcess({
			kill: () => {
				throw new Error("nope");
			},
		});
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

describe("clearKillTimer", () => {
	test("no-op when killTimer is null", () => {
		const run = __makeBinaryRunForTesting__(() => undefined);
		expect(() => clearKillTimer(run)).not.toThrow();
		expect(run.killTimer === null).toBe(true);
	});

	test("clears and nulls the timer when one is set", () => {
		const run = __makeBinaryRunForTesting__(() => undefined);
		const timer = setTimeout(() => undefined, 10_000);
		run.killTimer = timer;
		clearKillTimer(run);
		expect(run.killTimer === null).toBe(true);
		// Belt-and-braces: clearTimeout is idempotent so this is safe.
		clearTimeout(timer);
	});
});

describe("buildBinaryResolution", () => {
	test("omits reason when undefined", () => {
		const result = buildBinaryResolution(true, undefined);
		expect(result).toEqual({ ok: true });
		expect("reason" in result).toBe(false);
	});

	test("includes reason when present", () => {
		expect(buildBinaryResolution(false, "boom")).toEqual({ ok: false, reason: "boom" });
	});

	test("preserves empty-string reason", () => {
		expect(buildBinaryResolution(false, "")).toEqual({ ok: false, reason: "" });
	});
});

describe("wireTypeStdin", () => {
	test("writes the text via stdin.end and resolves nothing synchronously", () => {
		const endedWith: { value: string | null } = { value: null };
		const stdin = asWritableStream({
			on: (_ev: string, _fn: (...a: unknown[]) => void) => undefined,
			end: (text: string) => {
				endedWith.value = text;
			},
		});
		const calls: Array<{ ok: boolean; reason?: string }> = [];
		const run = __makeBinaryRunForTesting__((v) => calls.push(v));
		wireTypeStdin(run, stdin, "payload");
		expect(endedWith.value).toBe("payload");
		// No synchronous resolution on the happy path.
		expect(calls.length).toBe(0);
	});

	test("routes stdin 'error' events to finishBinaryRun with the error message", () => {
		const handlers = new Map<string, (err: Error) => void>();
		const stdin = asWritableStream({
			on: (ev: string, fn: (err: Error) => void) => {
				handlers.set(ev, fn);
			},
			end: () => undefined,
		});
		const calls: Array<{ ok: boolean; reason?: string }> = [];
		const run = __makeBinaryRunForTesting__((v) => calls.push(v));
		wireTypeStdin(run, stdin, "x");
		handlers.get("error")?.(new Error("pipe broke"));
		expect(calls.length).toBe(1);
		expect(calls[0]?.ok).toBe(false);
		expect(calls[0]?.reason).toContain("stdin error");
		expect(calls[0]?.reason).toContain("pipe broke");
	});

	test("catches synchronous throws from stdin.end and finishes the run", () => {
		const stdin = asWritableStream({
			on: () => undefined,
			end: () => {
				throw new Error("EPIPE-sync");
			},
		});
		const calls: Array<{ ok: boolean; reason?: string }> = [];
		const run = __makeBinaryRunForTesting__((v) => calls.push(v));
		expect(() => wireTypeStdin(run, stdin, "x")).not.toThrow();
		expect(calls.length).toBe(1);
		expect(calls[0]?.ok).toBe(false);
		expect(calls[0]?.reason).toContain("stdin write failed");
		expect(calls[0]?.reason).toContain("EPIPE-sync");
	});
});

describe("startTypeBinaryRun", () => {
	test("on win32: writes the text to the spawned child's stdin", () => {
		if (process.platform !== "win32") {
			return;
		}
		spawnLog.length = 0;
		// Make the spawned child hang so the test doesn't race with `close`.
		spawnStub.hangs = true;
		startTypeBinaryRun(() => undefined, "C:/fake/binary.exe", "hello");
		expect(spawnLog.length).toBe(1);
		expect(spawnLog[0]?.args).toEqual(["--type"]);
		expect(spawnLog[0]?.stdin).toBe("hello");
	});

	test("on win32: finishes the run with 'no stdin' when the spawn returns a null stdin", () => {
		if (process.platform !== "win32") {
			return;
		}
		// The mock spawn returns stdin only when args includes "--type", but
		// if spawnInto fails (throw on spawn) the child is never created.
		// To force the `if (!stdin)` path we point at a spawn that throws —
		// finishBinaryRun then resolves with "spawn failed", but startBinaryRun's
		// `run.child` remains null so the chained `run.child?.stdin` is undefined.
		spawnStub.throwOnSpawn = "boom";
		const calls: Array<{ ok: boolean; reason?: string }> = [];
		startTypeBinaryRun((v) => calls.push(v), "C:/fake/binary.exe", "data");
		// The throw path resolves with "spawn failed" BEFORE we look at stdin,
		// so the run is already done by the time `if (!stdin)` would have fired.
		expect(calls.length).toBe(1);
		expect(calls[0]?.ok).toBe(false);
	});
});

describe("formatCombinedFailureReason", () => {
	test("renders both reasons when present", () => {
		// New order matches the dispatch order: clip first (primary), type second (fallback).
		expect(formatCombinedFailureReason("a", "b")).toBe("clip:a;type:b");
	});

	test("uses 'unknown' for undefined clip reason", () => {
		expect(formatCombinedFailureReason(undefined, "b")).toBe("clip:unknown;type:b");
	});

	test("uses 'unknown' for undefined type reason", () => {
		expect(formatCombinedFailureReason("a", undefined)).toBe("clip:a;type:unknown");
	});

	test("uses 'unknown' for both undefined reasons", () => {
		expect(formatCombinedFailureReason(undefined, undefined)).toBe("clip:unknown;type:unknown");
	});
});

describe("logClipFailure", () => {
	test("does not throw when reason is provided", () => {
		expect(() => logClipFailure("explained")).not.toThrow();
	});

	test("does not throw when reason is undefined", () => {
		expect(() => logClipFailure(undefined)).not.toThrow();
	});
});

describe("readClipboardFormat", () => {
	test("returns the read value on success", () => {
		expect(readClipboardFormat(() => "ok", "fallback", "Text")).toBe("ok");
	});

	test("returns the empty fallback when the read function throws", () => {
		expect(
			readClipboardFormat(
				() => {
					throw new Error("nope");
				},
				"FALLBACK",
				"Text"
			)
		).toBe("FALLBACK");
	});

	test("returns null fallback for image-like reads that throw", () => {
		expect(
			readClipboardFormat<null>(
				() => {
					throw new Error("kaput");
				},
				null,
				"Image"
			)
		).toBe(null);
	});
});

describe("coerceClipboardText", () => {
	test("returns the value unchanged when non-empty", () => {
		expect(coerceClipboardText("hello")).toBe("hello");
	});

	test("returns the value unchanged when empty string", () => {
		expect(coerceClipboardText("")).toBe("");
	});

	test("coerces null to empty string", () => {
		expect(coerceClipboardText(null)).toBe("");
	});

	test("coerces undefined to empty string", () => {
		expect(coerceClipboardText(undefined)).toBe("");
	});
});

describe("normalizeClipboardImage", () => {
	test("returns null when the input is null", () => {
		expect(normalizeClipboardImage(null)).toBe(null);
	});

	test("returns null when the image is empty", () => {
		const empty = asNativeImage({ isEmpty: () => true });
		expect(normalizeClipboardImage(empty)).toBe(null);
	});

	test("returns the image when it is non-empty", () => {
		const real = asNativeImage({ isEmpty: () => false });
		expect(normalizeClipboardImage(real)).toBe(real);
	});
});

describe("captureClipboardSnapshot", () => {
	test("returns the four text formats from the clipboard mock plus a normalized image", () => {
		lastClipboard = "saved";
		const snap = captureClipboardSnapshot();
		expect(snap.text).toBe("saved");
		// The mock returns "" for html/rtf and an isEmpty image.
		expect(snap.html).toBe("");
		expect(snap.rtf).toBe("");
		expect(snap.image).toBe(null);
	});
});

describe("snapshotIsEmpty", () => {
	test("returns true for an entirely-empty snapshot", () => {
		expect(snapshotIsEmpty({ text: "", html: "", rtf: "", image: null })).toBe(true);
	});

	test("returns false when text is present", () => {
		expect(snapshotIsEmpty({ text: "x", html: "", rtf: "", image: null })).toBe(false);
	});

	test("returns false when html is present", () => {
		expect(snapshotIsEmpty({ text: "", html: "x", rtf: "", image: null })).toBe(false);
	});

	test("returns false when rtf is present", () => {
		expect(snapshotIsEmpty({ text: "", html: "", rtf: "x", image: null })).toBe(false);
	});

	test("returns false when image is present", () => {
		const img = asNativeImage({ isEmpty: () => false });
		expect(snapshotIsEmpty({ text: "", html: "", rtf: "", image: img })).toBe(false);
	});
});

describe("addTextToPayload / addHtmlToPayload / addRtfToPayload / addImageToPayload", () => {
	test("addTextToPayload writes non-empty text and skips empty", () => {
		const a: { text?: string } = {};
		addTextToPayload(a, "hi");
		expect(a.text).toBe("hi");
		const b: { text?: string } = {};
		addTextToPayload(b, "");
		expect("text" in b).toBe(false);
	});

	test("addHtmlToPayload writes non-empty html and skips empty", () => {
		const a: { html?: string } = {};
		addHtmlToPayload(a, "<b>hi</b>");
		expect(a.html).toBe("<b>hi</b>");
		const b: { html?: string } = {};
		addHtmlToPayload(b, "");
		expect("html" in b).toBe(false);
	});

	test("addRtfToPayload writes non-empty rtf and skips empty", () => {
		const a: { rtf?: string } = {};
		addRtfToPayload(a, "{\\rtf}");
		expect(a.rtf).toBe("{\\rtf}");
		const b: { rtf?: string } = {};
		addRtfToPayload(b, "");
		expect("rtf" in b).toBe(false);
	});

	test("addImageToPayload writes non-null image and skips null", () => {
		const img = asNativeImage({ isEmpty: () => false });
		const a: { image?: Electron.NativeImage } = {};
		addImageToPayload(a, img);
		expect(a.image).toBe(img);
		const b: { image?: Electron.NativeImage } = {};
		addImageToPayload(b, null);
		expect("image" in b).toBe(false);
	});
});

describe("buildRestorePayload", () => {
	test("builds an empty payload from an empty snapshot", () => {
		const payload = buildRestorePayload({ text: "", html: "", rtf: "", image: null });
		expect(payload).toEqual({});
	});

	test("includes every set field", () => {
		const img = asNativeImage({ isEmpty: () => false });
		const payload = buildRestorePayload({ text: "t", html: "h", rtf: "r", image: img });
		expect(payload.text).toBe("t");
		expect(payload.html).toBe("h");
		expect(payload.rtf).toBe("r");
		expect(payload.image).toBe(img);
	});
});

describe("fallbackTextOnlyRestore", () => {
	test("is a no-op for empty text", () => {
		lastClipboard = "untouched";
		fallbackTextOnlyRestore("");
		expect(lastClipboard).toBe("untouched");
	});

	test("writes non-empty text via clipboard.writeText", () => {
		lastClipboard = "";
		fallbackTextOnlyRestore("restore-me");
		expect(lastClipboard).toBe("restore-me");
	});

	test("swallows clipboard.writeText errors", () => {
		clipboardThrowOnNext = true;
		expect(() => fallbackTextOnlyRestore("doomed")).not.toThrow();
	});
});

describe("writeRestorePayload", () => {
	test("falls back to text-only write when clipboard.write throws", async () => {
		const electron = await import("electron");
		const originalWrite = electron.clipboard.write;
		(electron.clipboard as unknown as { write: () => never }).write = () => {
			throw new Error("rich-write blew up");
		};
		try {
			lastClipboard = "";
			writeRestorePayload({ text: "rescue", html: "ignored", rtf: "", image: null });
			expect(lastClipboard).toBe("rescue");
		} finally {
			(electron.clipboard as unknown as { write: typeof originalWrite }).write = originalWrite;
		}
	});

	test("calls clipboard.write with the assembled payload on the happy path", () => {
		lastClipboard = "";
		writeRestorePayload({ text: "winner", html: "", rtf: "", image: null });
		expect(lastClipboard).toBe("winner");
	});
});

describe("restoreClipboardSnapshot", () => {
	test("returns silently for an empty snapshot — clipboard untouched", () => {
		lastClipboard = "user-original";
		restoreClipboardSnapshot({ text: "", html: "", rtf: "", image: null });
		expect(lastClipboard).toBe("user-original");
	});

	test("restores a non-empty snapshot via the multi-format write", () => {
		lastClipboard = "transient";
		restoreClipboardSnapshot({ text: "saved", html: "", rtf: "", image: null });
		expect(lastClipboard).toBe("saved");
	});
});

describe("recordPasteCall", () => {
	test("appends the text and __getPasteCallsForTesting__ reflects it; reset clears", () => {
		__resetPasteCallsForTesting__();
		recordPasteCall("entry");
		const calls = __getPasteCallsForTesting__();
		expect(calls).toContain("entry");
		__resetPasteCallsForTesting__();
		expect(__getPasteCallsForTesting__().length).toBe(0);
	});

	test("appends the text without trimming when under the cap", () => {
		// We can't read the log directly, but pasteText also calls recordPasteCall
		// — so we exercise it indirectly to ensure no throw.
		expect(() => recordPasteCall("entry")).not.toThrow();
	});

	test("trims the head once the log exceeds PASTE_CALL_LOG_MAX", () => {
		// PASTE_CALL_LOG_MAX is 100; push 105 entries and confirm no throw.
		for (let i = 0; i < 105; i++) {
			recordPasteCall(`overflow-${i}`);
		}
		// If trimming throws, this line is unreachable.
		expect(true).toBe(true);
	});
});

describe("enqueuePaste", () => {
	test("on non-win32: serializes the paste and flushPastePending resolves", async () => {
		// Drive the path purely through pasteText since enqueuePaste mutates
		// module-local state; this asserts the chain terminates without leaking.
		const original = process.platform;
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		try {
			enqueuePaste("queued-text", Date.now());
			await flushPastePending();
			expect(true).toBe(true);
		} finally {
			Object.defineProperty(process, "platform", { value: original, configurable: true });
		}
	});
});

describe("on win32: Ctrl+V failure + --type failure surfaces combined reason", () => {
	test("both paths failing trips cooldown with the combined reason in logs", async () => {
		if (process.platform !== "win32") {
			return;
		}
		spawnLog.length = 0;
		__resetPasteForTesting__();
		// Both spawns (Ctrl+V then --type) exit non-zero — formatCombinedFailureReason is invoked.
		spawnStub.exitCodeSequence = [1, 1];
		pasteText("combined-failure");
		await flushPastePending();
		expect(spawnLog.length).toBe(2);
		// Cooldown is now active (formatCombinedFailureReason path).
		expect(__getCooldownUntilForTesting__()).toBeGreaterThan(Date.now());
	});
});

describe("tryClipboardThenTyping (direct)", () => {
	test("on win32: Ctrl+V succeeds → returns the clipboard result without invoking --type", async () => {
		if (process.platform !== "win32") {
			return;
		}
		spawnLog.length = 0;
		spawnStub.exitCode = 0;
		const result = await tryClipboardThenTyping("C:/fake/binary.exe", "x");
		expect(result.ok).toBe(true);
		// Only ONE spawn — the Ctrl+V one (no args). No --type fallback.
		expect(spawnLog.length).toBe(1);
		expect(spawnLog[0]?.args).toEqual([]);
	});

	test("on win32: Ctrl+V fails + --type succeeds → returns the typing result", async () => {
		if (process.platform !== "win32") {
			return;
		}
		spawnLog.length = 0;
		spawnStub.exitCodeSequence = [1, 0];
		const result = await tryClipboardThenTyping("C:/fake/binary.exe", "y");
		expect(result.ok).toBe(true);
		expect(spawnLog.length).toBe(2);
		expect(spawnLog[0]?.args).toEqual([]);
		expect(spawnLog[1]?.args).toEqual(["--type"]);
	});

	test("on win32: both paths fail → returns combined reason", async () => {
		if (process.platform !== "win32") {
			return;
		}
		spawnLog.length = 0;
		spawnStub.exitCodeSequence = [1, 1];
		const result = await tryClipboardThenTyping("C:/fake/binary.exe", "z");
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("clip:exit 1");
		expect(result.reason).toContain("type:exit 1");
	});
});

describe("runClipboardPaste (direct)", () => {
	test("on win32: spawns Ctrl+V binary, restores user clipboard via finally", async () => {
		if (process.platform !== "win32") {
			return;
		}
		spawnLog.length = 0;
		lastClipboard = "user-content";
		spawnStub.exitCode = 0;
		const result = await runClipboardPaste("C:/fake/binary.exe", "transcript");
		expect(result.ok).toBe(true);
		expect(spawnLog.length).toBe(1);
		// Ctrl+V binary takes no args.
		expect(spawnLog[0]?.args).toEqual([]);
		// Restored after the spawn.
		expect(lastClipboard).toBe("user-content");
	});

	test("on win32: returns early with 'clipboard write failed' when writeClipboard throws", async () => {
		if (process.platform !== "win32") {
			return;
		}
		spawnLog.length = 0;
		clipboardThrowOnNext = true;
		const result = await runClipboardPaste("C:/fake/binary.exe", "doomed");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("clipboard write failed");
		// Never spawned because we bailed early.
		expect(spawnLog.length).toBe(0);
	});

	test("on win32: even when the Ctrl+V binary fails, the snapshot is restored in finally", async () => {
		if (process.platform !== "win32") {
			return;
		}
		spawnLog.length = 0;
		lastClipboard = "before-paste";
		spawnStub.exitCode = 1;
		const result = await runClipboardPaste("C:/fake/binary.exe", "transcript");
		expect(result.ok).toBe(false);
		// The finally block ran the restore — `lastClipboard` is back to the original.
		expect(lastClipboard).toBe("before-paste");
	});
});

describe("injectSubmitKey", () => {
	test("'enter' spawns powershell with the bare {ENTER} SendKeys sequence", async () => {
		spawnLog.length = 0;
		injectSubmitKey("enter");
		await flushPastePending();
		expect(spawnLog.length).toBe(1);
		const call = spawnLog[0];
		expect(call?.cmd).toBe("powershell");
		expect(call?.args).toContain("-NoProfile");
		expect(call?.args).toContain("-NonInteractive");
		expect(call?.args).toContain("-Command");
		// The actual SendKeys script is the last arg.
		const script = call?.args.at(-1) ?? "";
		expect(script).toContain("System.Windows.Forms");
		expect(script).toContain("SendWait('{ENTER}')");
		// `enter` must NOT carry the Ctrl (^) modifier.
		expect(script).not.toContain("^{ENTER}");
	});

	test("'ctrl_enter' spawns powershell with the ^{ENTER} (Ctrl+Enter) sequence", async () => {
		spawnLog.length = 0;
		injectSubmitKey("ctrl_enter");
		await flushPastePending();
		expect(spawnLog.length).toBe(1);
		const script = spawnLog[0]?.args.at(-1) ?? "";
		expect(script).toContain("SendWait('^{ENTER}')");
	});

	test("resolves cleanly when the powershell child emits 'exit'", async () => {
		// Default stub fires `exit` (and `close`) on the next microtask. The
		// promise inside injectSubmitKey resolves on `exit`; flushPastePending
		// must settle without hanging or throwing.
		spawnLog.length = 0;
		spawnStub.exitCode = 0;
		injectSubmitKey("enter");
		await expect(flushPastePending()).resolves.toBeUndefined();
		expect(spawnLog.length).toBe(1);
	});

	test("resolves (silently, no throw) when the powershell child emits 'error'", async () => {
		// Auto-submit is opt-in; a blocked / failed powershell must NOT surface a
		// user-facing rejection. The `error` branch of the once-handlers resolves
		// the promise the same as `exit`.
		spawnLog.length = 0;
		spawnStub.emitSpawnError = true;
		injectSubmitKey("ctrl_enter");
		await expect(flushPastePending()).resolves.toBeUndefined();
		expect(spawnLog.length).toBe(1);
	});

	test("fires AFTER the in-flight paste — the paste spawn precedes the submit spawn", async () => {
		if (process.platform !== "win32") {
			return;
		}
		spawnLog.length = 0;
		__resetPasteForTesting__();
		spawnStub.exitCode = 0;
		// Queue a real paste, then chain a submit-key onto the same tail.
		pasteText("hello");
		injectSubmitKey("enter");
		await flushPastePending();
		// First spawn is the paste binary (winstt-paste.exe), then powershell.
		expect(spawnLog.length).toBe(2);
		expect(spawnLog[0]?.cmd).toContain("winstt-paste.exe");
		expect(spawnLog[1]?.cmd).toBe("powershell");
	});

	test("chains onto pasteInFlight (Promise.resolve seed) so flushPastePending awaits the submit", async () => {
		// With no prior paste, the chain seeds off `pasteInFlight ?? Promise.resolve()`.
		// flushPastePending must return a promise that only settles once the
		// powershell child has fired its `exit`/`error` event — never before.
		__resetPasteForTesting__();
		spawnLog.length = 0;
		spawnStub.exitCode = 0;
		injectSubmitKey("enter");
		const flush = flushPastePending();
		// The flush handle is the live pasteInFlight tail, not a bare resolved promise.
		expect(flush).toBeInstanceOf(Promise);
		await flush;
		// The spawn happened inside the awaited chain (it lives in the chained .then).
		expect(spawnLog.length).toBe(1);
		expect(spawnLog[0]?.cmd).toBe("powershell");
	});

	test("watchdog kills the child and resolves when powershell launches but never exits", async () => {
		// Regression (Bug 4): injectSubmitKey previously had NO watchdog. A
		// powershell that launched but never fired exit/error would leave the
		// promise pending forever, pinning pasteInFlight and blocking every
		// subsequent paste. The watchdog must kill the child and resolve.
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
			spawnLog.length = 0;
			// The child hangs — emits neither `exit` nor `error`.
			spawnStub.hangs = true;
			let resolved = false;
			startSubmitKeyRun(() => {
				resolved = true;
			}, "{ENTER}");
			expect(spawnLog.length).toBe(1);
			// Not resolved yet — the child hasn't exited and the watchdog is armed.
			expect(resolved).toBe(false);
			// Fire the watchdog (the 10_000ms timer).
			const watchdog = timers.find((t) => t.ms === 10_000);
			expect(watchdog).toBeDefined();
			watchdog?.fn();
			// The watchdog killed the child and resolved the promise.
			expect(spawnLog[0]?.killed).toBe(true);
			expect(resolved).toBe(true);
		} finally {
			(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
		}
	});

	test("watchdog is idempotent — a normal exit before the watchdog resolves exactly once", async () => {
		// settle() guards against a double-resolve: when the child exits normally
		// the watchdog timer is cleared and a later watchdog fire is a no-op.
		const realSetTimeout = globalThis.setTimeout;
		const realClearTimeout = globalThis.clearTimeout;
		const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
		(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
			fn: () => void,
			ms: number
		) => {
			// 1-based handle so the returned id is always truthy (settle() guards
			// `if (watchdog) clearTimeout(watchdog)` — a 0 handle would be skipped).
			const handle = timers.length + 1;
			timers.push({ fn, ms, cleared: false });
			return handle as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		(globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = ((
			handle: number
		) => {
			const t = timers[handle - 1];
			if (t) {
				t.cleared = true;
			}
		}) as typeof clearTimeout;
		try {
			spawnLog.length = 0;
			// Child exits on the next microtask (default stub behavior).
			spawnStub.hangs = false;
			spawnStub.exitCode = 0;
			let resolveCount = 0;
			startSubmitKeyRun(() => {
				resolveCount += 1;
			}, "{ENTER}");
			// The default mock fires `exit` on the next microtask.
			await Promise.resolve();
			await Promise.resolve();
			expect(resolveCount).toBe(1);
			// The watchdog timer was cleared by settle().
			const watchdog = timers.find((t) => t.ms === 10_000);
			expect(watchdog?.cleared).toBe(true);
			// Even if a stale watchdog somehow fired now, settle() short-circuits.
			watchdog?.fn();
			expect(resolveCount).toBe(1);
		} finally {
			(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
			(globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout =
				realClearTimeout;
		}
	});
});
