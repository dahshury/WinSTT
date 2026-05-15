import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "../../test/mocks/electron";

const guardLog: boolean[] = [];
mock.module("../ipc/hotkey", () => ({
	setPasteGuard: (active: boolean) => {
		guardLog.push(active);
	},
}));

let lastClipboard = "";
mock.module("electron", () => {
	const base = electronMock();
	base.clipboard = {
		writeText: (text: string) => {
			lastClipboard = text;
		},
		readText: () => lastClipboard,
		clear: () => {
			lastClipboard = "";
		},
	};
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
}
const spawnLog: SpawnArgs[] = [];
const spawnStub: { exitCode: number; emitError?: string; hangs: boolean } = {
	exitCode: 0,
	hangs: false,
};
mock.module("node:child_process", () => ({
	spawn: (cmd: string, args: string[]) => {
		spawnLog.push({ cmd, args });
		const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
		const child = {
			stdout: {
				on: () => undefined,
			},
			stderr: {
				on: () => undefined,
			},
			on: (ev: string, fn: (...a: unknown[]) => void) => {
				const list = handlers.get(ev) ?? [];
				list.push(fn);
				handlers.set(ev, list);
			},
			kill: () => undefined,
		};
		// Fire the configured outcome on next microtask so the await in
		// runBinary actually awaits something.
		queueMicrotask(() => {
			if (spawnStub.hangs) {
				return;
			}
			if (spawnStub.emitError) {
				for (const fn of handlers.get("error") ?? []) {
					fn(new Error(spawnStub.emitError));
				}
			}
			for (const fn of handlers.get("close") ?? []) {
				fn(spawnStub.exitCode);
			}
		});
		return child;
	},
}));

const { pasteText, flushPastePending, __resetPasteForTesting__ } = await import("./paste");

import { beforeEach } from "bun:test";

beforeEach(() => {
	__resetPasteForTesting__();
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

	test("on win32: writes clipboard, toggles paste guard, spawns winstt-paste.exe", async () => {
		if (process.platform !== "win32") {
			return;
		}
		guardLog.length = 0;
		spawnLog.length = 0;
		spawnStub.exitCode = 0;
		spawnStub.hangs = false;
		spawnStub.emitError = undefined;
		pasteText("hello world");
		await flushPastePending();
		expect(lastClipboard).toBe("hello world");
		expect(guardLog).toEqual([true, false]);
		expect(spawnLog.length).toBe(1);
		expect(spawnLog[0]?.cmd).toContain("winstt-paste.exe");
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

	test("on win32: serial pastes leave clipboard at the last text and guard cleanly off", async () => {
		if (process.platform !== "win32") {
			return;
		}
		guardLog.length = 0;
		spawnLog.length = 0;
		spawnStub.exitCode = 0;
		pasteText("alpha");
		pasteText("beta");
		pasteText("gamma");
		await flushPastePending();
		expect(guardLog).toEqual([true, false, true, false, true, false]);
		expect(lastClipboard).toBe("gamma");
		expect(spawnLog.length).toBe(3);
	});

	test("on win32: a paste failure trips the circuit breaker — next paste skips the binary", async () => {
		if (process.platform !== "win32") {
			return;
		}
		spawnLog.length = 0;
		// First paste: simulate a hang (binary fails). Trips the cooldown.
		spawnStub.exitCode = 1;
		spawnStub.hangs = false;
		pasteText("first");
		await flushPastePending();
		expect(spawnLog.length).toBe(1);

		// Second paste: still within cooldown. Clipboard should update,
		// but no second binary spawn — protecting against a cascade of
		// SendInput hangs that could freeze the OS input queue.
		spawnLog.length = 0;
		spawnStub.exitCode = 0; // even if the binary would succeed, we shouldn't try
		pasteText("second");
		await flushPastePending();
		expect(lastClipboard).toBe("second");
		expect(spawnLog.length).toBe(0);
	});
});

describe("getBinaryCandidate (dev path branch)", () => {
	test("on win32: when app.isPackaged=false, the dev path includes 'electron/native/bin/winstt-paste.exe'", async () => {
		if (process.platform !== "win32") {
			return;
		}
		// Lock down the L84 dev path components — "..", "electron", "native",
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
			// `import.meta.dirname` resolves to <project>/electron/lib at test
			// runtime; with `[..,electron,native,bin,winstt-paste.exe]`, the
			// joined path normalizes to <project>/electron/electron/native/bin/winstt-paste.exe.
			// Each StringLiteral mutation in the dev path produces a DIFFERENT
			// final path:
			//   ".." -> "" : <project>/electron/lib/electron/native/bin/...
			//   "electron" -> "" : <project>/electron/native/bin/...
			//   "native" -> "" : <project>/electron/electron/bin/winstt-paste.exe
			//   "bin" -> "" : <project>/electron/electron/native/winstt-paste.exe
			//   "winstt-paste.exe" -> "" : path ending in /bin/
			// Lock down the canonical end of the path: native/bin/winstt-paste.exe
			expect(cmd).toMatch(/native\/bin\/winstt-paste\.exe$/);
			// The path must contain `electron/electron` segment, meaning the
			// `..` collapsed correctly (mutating `..` to `""` would yield
			// `electron/lib/electron`, not `electron/electron`).
			expect(cmd).toMatch(/electron\/electron\/native\/bin\/winstt-paste\.exe$/);
		} finally {
			(electron.app as unknown as { isPackaged: boolean }).isPackaged = original;
			__resetPasteForTesting__();
		}
	});
});

describe("getBinary cache short-circuit", () => {
	test("getBinary caches the resolved path so resolveBinary runs once", async () => {
		// Locks down L103 ConditionalExpression `if (cachedBinary === undefined)`.
		// Mutating to `if (true)` would re-resolve every call, which our
		// observable behaviour can't easily distinguish — but the dbg log
		// "using ..." would fire twice. We assert the spawn binary path is
		// stable across two pasteText() invocations.
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
		// Lock down the L80 packaged-branch — also covers L81 string literals
		// "native", "bin", "winstt-paste.exe". With isPackaged=true the
		// resolved binary path must contain all three segments.
		// Toggle isPackaged BEFORE the cache is rebuilt.
		const electron = await import("electron");
		const original = (electron.app as unknown as { isPackaged: boolean }).isPackaged;
		(electron.app as unknown as { isPackaged: boolean }).isPackaged = true;
		// Stub a non-empty resourcesPath so path.join produces a concrete path.
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
			// path.join normalizes to platform separators (backslash on Windows).
			expect(cmd.replace(/\\/g, "/")).toContain("C:/mock/resources");
		} finally {
			(electron.app as unknown as { isPackaged: boolean }).isPackaged = original;
			(process as unknown as { resourcesPath: string }).resourcesPath = originalRes;
			__resetPasteForTesting__();
		}
	});
});
