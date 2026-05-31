import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { debugLogMock } from "@test/mocks/debug-log";
import { electronMock } from "@test/mocks/electron";

// about.ts reads three things from `electron`:
//   - app.isPackaged (resolveBundledTextFile branch)
//   - app.getVersion() (buildAppInfo)
// and pulls in ../lib/debug-log (dbg) for the read-failure log line.
//
// We drive `app.isPackaged`/`app.getVersion` from a mutable state object so
// individual tests can flip them without re-registering the module mock.
const appState: { isPackaged: boolean; version: string } = {
	isPackaged: false,
	version: "9.9.9-about-test",
};

// Capture the IPC handlers registered via ipcMain.handle, and the channels
// that were the subject of removeHandler (so we can assert the
// remove-before-register idempotency contract + cleanup behaviour).
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const removeHandlerCalls: string[] = [];

mock.module("electron", () => {
	const base = electronMock();
	return {
		...base,
		app: {
			...base.app,
			get isPackaged() {
				return appState.isPackaged;
			},
			getVersion: () => appState.version,
		},
		ipcMain: {
			handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
				handlers.set(channel, listener);
			},
			removeHandler: (channel: string) => {
				removeHandlerCalls.push(channel);
				handlers.delete(channel);
			},
			on: () => undefined,
			off: () => undefined,
			removeAllListeners: () => undefined,
		},
	};
});

// Spread the faithful debug-log fake so the global mock leak stays semantically
// complete, and capture dbg(tag, ...) calls so we can assert the read-failure
// log line fires (and does NOT fire on the happy path).
const dbgCalls: Array<{ tag: string; args: unknown[] }> = [];
mock.module("../lib/debug-log", () => ({
	...debugLogMock(),
	dbg: (tag: string, ...args: unknown[]) => {
		dbgCalls.push({ tag, args });
	},
}));

// Drive readFile: each call records its resolved path; the next queued result
// (a string to resolve with, or an Error to reject with) is returned.
const fsState: {
	readFileCalls: string[];
	readFileResult: string;
	readFileThrows: Error | null;
} = {
	readFileCalls: [],
	readFileResult: "",
	readFileThrows: null,
};
mock.module("node:fs/promises", () => ({
	readFile: async (file: string, _encoding: unknown): Promise<string> => {
		fsState.readFileCalls.push(file);
		if (fsState.readFileThrows) {
			throw fsState.readFileThrows;
		}
		return fsState.readFileResult;
	},
}));

const { setupAboutHandlers } = await import("./about");

const LICENSE_CHANNEL = "about:get-license";
const NOTICES_CHANNEL = "about:get-notices";
const APP_INFO_CHANNEL = "about:get-app-info";

const fakeEvent = {} as unknown;

// Mutable view of process.versions so we can exercise the `?? "unknown"`
// fallbacks in buildAppInfo without permanently mutating the host.
const originalElectronVersion = process.versions.electron;
const originalNodeVersion = process.versions.node;
function setVersions(electron: string | undefined, node: string | undefined): void {
	Object.defineProperty(process.versions, "electron", {
		value: electron,
		configurable: true,
	});
	Object.defineProperty(process.versions, "node", { value: node, configurable: true });
}
function resetVersions(): void {
	setVersions(originalElectronVersion, originalNodeVersion);
}

// resolveBundledTextFile reads process.resourcesPath in the packaged branch.
const originalResourcesPath = (process as { resourcesPath?: string }).resourcesPath;
function setResourcesPath(value: string | undefined): void {
	Object.defineProperty(process, "resourcesPath", { value, configurable: true });
}
function resetResourcesPath(): void {
	setResourcesPath(originalResourcesPath);
}

beforeEach(() => {
	handlers.clear();
	removeHandlerCalls.length = 0;
	dbgCalls.length = 0;
	fsState.readFileCalls = [];
	fsState.readFileResult = "";
	fsState.readFileThrows = null;
	appState.isPackaged = false;
	appState.version = "9.9.9-about-test";
});

afterEach(() => {
	resetVersions();
	resetResourcesPath();
});

describe("setupAboutHandlers — registration & lifecycle", () => {
	test("registers exactly the three about channels", () => {
		const cleanup = setupAboutHandlers();
		expect(handlers.has(LICENSE_CHANNEL)).toBe(true);
		expect(handlers.has(NOTICES_CHANNEL)).toBe(true);
		expect(handlers.has(APP_INFO_CHANNEL)).toBe(true);
		expect(handlers.size).toBe(3);
		cleanup();
	});

	test("returns a cleanup function that removes all three handlers", () => {
		const cleanup = setupAboutHandlers();
		expect(typeof cleanup).toBe("function");
		cleanup();
		expect(handlers.has(LICENSE_CHANNEL)).toBe(false);
		expect(handlers.has(NOTICES_CHANNEL)).toBe(false);
		expect(handlers.has(APP_INFO_CHANNEL)).toBe(false);
		expect(handlers.size).toBe(0);
	});

	test("removes each handler BEFORE re-registering (idempotent double-register guard)", () => {
		// The handler calls removeHandler on all three channels at the top of
		// setupAboutHandlers, then handle()s them. Calling setup twice must not
		// throw and must leave the handlers registered — Electron's ipcMain.handle
		// throws "Attempted to register a second handler" without the remove.
		setupAboutHandlers();
		const firstRegistration = removeHandlerCalls.length;
		// First call removes the 3 channels (no-ops since unregistered) then handles.
		expect(removeHandlerCalls).toContain(LICENSE_CHANNEL);
		expect(removeHandlerCalls).toContain(NOTICES_CHANNEL);
		expect(removeHandlerCalls).toContain(APP_INFO_CHANNEL);

		const cleanup = setupAboutHandlers();
		// Second call removes the 3 again before re-handling.
		expect(removeHandlerCalls.length).toBe(firstRegistration + 3);
		expect(handlers.size).toBe(3);
		cleanup();
	});

	test("cleanup invokes removeHandler for all three channels", () => {
		const cleanup = setupAboutHandlers();
		removeHandlerCalls.length = 0;
		cleanup();
		expect(removeHandlerCalls).toEqual([LICENSE_CHANNEL, NOTICES_CHANNEL, APP_INFO_CHANNEL]);
	});
});

describe("about:get-license handler", () => {
	test("returns the file contents on a successful read", async () => {
		setupAboutHandlers();
		fsState.readFileResult = "MIT License\n\nCopyright text...";
		const result = await handlers.get(LICENSE_CHANNEL)?.(fakeEvent);
		expect(result).toBe("MIT License\n\nCopyright text...");
		// Exactly one file read, for the LICENSE file.
		expect(fsState.readFileCalls).toHaveLength(1);
		expect(fsState.readFileCalls[0]).toContain("LICENSE");
		// No failure log on the happy path.
		expect(dbgCalls).toHaveLength(0);
	});

	test("resolves the file under the repo root in dev (not packaged)", async () => {
		appState.isPackaged = false;
		setupAboutHandlers();
		fsState.readFileResult = "x";
		await handlers.get(LICENSE_CHANNEL)?.(fakeEvent);
		const resolved = fsState.readFileCalls[0] ?? "";
		// Dev path is `<dirname>/../../LICENSE` — must NOT be under resourcesPath.
		expect(resolved.endsWith("LICENSE")).toBe(true);
		expect(resolved).not.toContain("resourcesPath-marker");
	});

	test("resolves the file under process.resourcesPath when packaged", async () => {
		appState.isPackaged = true;
		setResourcesPath("/packaged/resourcesPath-marker");
		setupAboutHandlers();
		fsState.readFileResult = "x";
		await handlers.get(LICENSE_CHANNEL)?.(fakeEvent);
		const resolved = fsState.readFileCalls[0] ?? "";
		// path.join('/packaged/resourcesPath-marker', 'LICENSE') — separator is
		// OS-specific, so assert on the segments rather than a literal.
		expect(resolved).toContain("resourcesPath-marker");
		expect(resolved.endsWith("LICENSE")).toBe(true);
	});

	test("returns the not-available fallback string and logs on read failure", async () => {
		setupAboutHandlers();
		fsState.readFileThrows = new Error("ENOENT: no such file");
		const result = await handlers.get(LICENSE_CHANNEL)?.(fakeEvent);
		// NOTE: the failure fallback is returned as if it were file CONTENT —
		// there is no { ok: false } envelope, so a renderer rendering the
		// license will silently display this sentinel string. Documenting the
		// current (fail-soft) behaviour.
		expect(result).toBe("LICENSE is not available in this build.");
		// The failure was logged under the "about" scope with the message text.
		expect(dbgCalls).toHaveLength(1);
		expect(dbgCalls[0]?.tag).toBe("about");
		expect(dbgCalls[0]?.args[0]).toBe("failed to read LICENSE:");
		// Error.message is forwarded (not the whole Error object).
		expect(dbgCalls[0]?.args[1]).toBe("ENOENT: no such file");
	});

	test("logs String(err) when a non-Error value is thrown", async () => {
		setupAboutHandlers();
		// Reject with a non-Error to hit the `String(err)` branch of the ternary.
		fsState.readFileThrows = "boom" as unknown as Error;
		const result = await handlers.get(LICENSE_CHANNEL)?.(fakeEvent);
		expect(result).toBe("LICENSE is not available in this build.");
		expect(dbgCalls[0]?.args[1]).toBe("boom");
	});
});

describe("about:get-notices handler", () => {
	test("returns the notices file contents on success", async () => {
		setupAboutHandlers();
		fsState.readFileResult = "Third-party notices body";
		const result = await handlers.get(NOTICES_CHANNEL)?.(fakeEvent);
		expect(result).toBe("Third-party notices body");
		expect(fsState.readFileCalls).toHaveLength(1);
		expect(fsState.readFileCalls[0]).toContain("THIRD_PARTY_NOTICES.md");
		expect(dbgCalls).toHaveLength(0);
	});

	test("returns the THIRD_PARTY_NOTICES.md fallback and logs on failure", async () => {
		setupAboutHandlers();
		fsState.readFileThrows = new Error("permission denied");
		const result = await handlers.get(NOTICES_CHANNEL)?.(fakeEvent);
		expect(result).toBe("THIRD_PARTY_NOTICES.md is not available in this build.");
		expect(dbgCalls).toHaveLength(1);
		expect(dbgCalls[0]?.tag).toBe("about");
		expect(dbgCalls[0]?.args[0]).toBe("failed to read THIRD_PARTY_NOTICES.md:");
		expect(dbgCalls[0]?.args[1]).toBe("permission denied");
	});
});

describe("about:get-app-info handler", () => {
	test("returns version, electron/node versions and the copyright string", async () => {
		appState.version = "1.2.3";
		setVersions("31.0.1", "20.11.0");
		setupAboutHandlers();
		const result = (await handlers.get(APP_INFO_CHANNEL)?.(fakeEvent)) as {
			version: string;
			electronVersion: string;
			nodeVersion: string;
			copyright: string;
		};
		expect(result).toEqual({
			version: "1.2.3",
			electronVersion: "31.0.1",
			nodeVersion: "20.11.0",
			copyright: "© 2024-2026 dahshury",
		});
		// app-info must NOT touch the filesystem.
		expect(fsState.readFileCalls).toHaveLength(0);
	});

	test("reflects app.getVersion() at call time", async () => {
		appState.version = "7.7.7";
		setupAboutHandlers();
		const result = (await handlers.get(APP_INFO_CHANNEL)?.(fakeEvent)) as { version: string };
		expect(result.version).toBe("7.7.7");
	});

	test('falls back to "unknown" when process.versions.electron is undefined', async () => {
		setVersions(undefined, "20.0.0");
		setupAboutHandlers();
		const result = (await handlers.get(APP_INFO_CHANNEL)?.(fakeEvent)) as {
			electronVersion: string;
			nodeVersion: string;
		};
		expect(result.electronVersion).toBe("unknown");
		expect(result.nodeVersion).toBe("20.0.0");
	});

	test('falls back to "unknown" when process.versions.node is undefined', async () => {
		setVersions("31.0.0", undefined);
		setupAboutHandlers();
		const result = (await handlers.get(APP_INFO_CHANNEL)?.(fakeEvent)) as {
			electronVersion: string;
			nodeVersion: string;
		};
		expect(result.electronVersion).toBe("31.0.0");
		expect(result.nodeVersion).toBe("unknown");
	});

	test("copyright string is a fixed literal regardless of versions", async () => {
		appState.version = "0.0.0";
		setVersions("1.0.0", "1.0.0");
		setupAboutHandlers();
		const result = (await handlers.get(APP_INFO_CHANNEL)?.(fakeEvent)) as { copyright: string };
		expect(result.copyright).toBe("© 2024-2026 dahshury");
	});
});
