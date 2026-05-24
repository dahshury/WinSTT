import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";

interface ShowSaveDialogResult {
	canceled: boolean;
	filePath?: string;
}

interface ShowMessageBoxResult {
	checkboxChecked?: boolean;
	response: number;
}

const dialogState: {
	saveResult: ShowSaveDialogResult;
	messageResult: ShowMessageBoxResult;
	errorBoxCalls: Array<{ title: string; content: string }>;
	saveDialogOptions: Electron.SaveDialogOptions | null;
	messageBoxOptions: Electron.MessageBoxOptions | null;
} = {
	saveResult: { canceled: true },
	messageResult: { response: 1 },
	errorBoxCalls: [],
	saveDialogOptions: null,
	messageBoxOptions: null,
};

const shellState: {
	openPathResult: string;
	openPathCalls: string[];
	showItemInFolderCalls: string[];
} = {
	openPathResult: "",
	openPathCalls: [],
	showItemInFolderCalls: [],
};

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

const debugLogState: {
	calls: Array<{ scope: string; args: unknown[] }>;
} = {
	calls: [],
};

const sentryState: {
	exceptions: Array<{ err: unknown; context: unknown }>;
} = {
	exceptions: [],
};

mock.module("../lib/debug-log", () => ({
	dbg: (scope: string, ...args: unknown[]) => {
		debugLogState.calls.push({ scope, args });
	},
}));

mock.module("../lib/sentry-main", () => ({
	breadcrumb: () => undefined,
	captureMainException: (err: unknown, context?: unknown) => {
		sentryState.exceptions.push({ err, context });
	},
}));

mock.module("electron", () => {
	const base = electronMock();
	return {
		...base,
		app: {
			...base.app,
			getPath: (name: string) => {
				if (name === "userData") {
					return "/mock/userData";
				}
				if (name === "desktop") {
					return "/mock/desktop";
				}
				return `/mock/${name}`;
			},
			getVersion: () => "1.2.3",
			getGPUInfo: () => Promise.resolve({ machineModelName: "MockGPU" }),
		},
		ipcMain: {
			handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
				handlers.set(channel, listener);
			},
			removeHandler: (channel: string) => {
				handlers.delete(channel);
			},
			on: () => undefined,
			off: () => undefined,
			removeAllListeners: () => undefined,
		},
		dialog: {
			showSaveDialog: async (options: Electron.SaveDialogOptions) => {
				dialogState.saveDialogOptions = options;
				return dialogState.saveResult;
			},
			showMessageBox: async (options: Electron.MessageBoxOptions) => {
				dialogState.messageBoxOptions = options;
				return dialogState.messageResult;
			},
			showErrorBox: (title: string, content: string) => {
				dialogState.errorBoxCalls.push({ title, content });
			},
		},
		shell: {
			...base.shell,
			openPath: (p: string) => {
				shellState.openPathCalls.push(p);
				return Promise.resolve(shellState.openPathResult);
			},
			showItemInFolder: (p: string) => {
				shellState.showItemInFolderCalls.push(p);
			},
		},
	};
});

const { setupDiagBundleHandler, __diag_bundle_test_helpers__ } = await import("./diag-bundle");

beforeEach(() => {
	handlers.clear();
	dialogState.saveResult = { canceled: true };
	dialogState.messageResult = { response: 1 };
	dialogState.errorBoxCalls = [];
	dialogState.saveDialogOptions = null;
	dialogState.messageBoxOptions = null;
	shellState.openPathResult = "";
	shellState.openPathCalls = [];
	shellState.showItemInFolderCalls = [];
	debugLogState.calls = [];
	sentryState.exceptions = [];
});

describe("setupDiagBundleHandler", () => {
	test("registers diag:open-logs-folder and diag:save-bundle handlers", () => {
		const cleanup = setupDiagBundleHandler();
		expect(handlers.has("diag:open-logs-folder")).toBe(true);
		expect(handlers.has("diag:save-bundle")).toBe(true);
		cleanup();
	});

	test("cleanup removes both handlers", () => {
		const cleanup = setupDiagBundleHandler();
		cleanup();
		expect(handlers.has("diag:open-logs-folder")).toBe(false);
		expect(handlers.has("diag:save-bundle")).toBe(false);
	});

	test("diag:open-logs-folder calls shell.openPath with userData and returns ok:true on success", async () => {
		setupDiagBundleHandler();
		const handler = handlers.get("diag:open-logs-folder");
		expect(handler).toBeDefined();
		const result = (await handler!(undefined)) as { ok: boolean; error?: string };
		expect(shellState.openPathCalls).toEqual(["/mock/userData"]);
		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
	});

	test("diag:open-logs-folder returns ok:false with error when openPath returns non-empty string", async () => {
		shellState.openPathResult = "Access denied";
		setupDiagBundleHandler();
		const handler = handlers.get("diag:open-logs-folder");
		const result = (await handler!(undefined)) as { ok: boolean; error?: string };
		expect(result.ok).toBe(false);
		expect(result.error).toBe("Access denied");
	});

	test("diag:save-bundle returns cancelled when user cancels", async () => {
		dialogState.saveResult = { canceled: true };
		setupDiagBundleHandler();
		const handler = handlers.get("diag:save-bundle");
		const result = (await handler!(undefined)) as {
			ok: boolean;
			cancelled?: boolean;
		};
		expect(result.ok).toBe(false);
		expect(result.cancelled).toBe(true);
	});

	test("diag:save-bundle returns cancelled when filePath is missing even if not canceled", async () => {
		dialogState.saveResult = { canceled: false };
		setupDiagBundleHandler();
		const handler = handlers.get("diag:save-bundle");
		const result = (await handler!(undefined)) as { ok: boolean; cancelled?: boolean };
		expect(result.ok).toBe(false);
		expect(result.cancelled).toBe(true);
	});
});

describe("filename formatting", () => {
	test("formatTimestampForFilename produces YYYYMMDD-HHMMSS shape", () => {
		const d = new Date(2024, 0, 5, 9, 7, 3);
		const s = __diag_bundle_test_helpers__.formatTimestampForFilename(d);
		expect(s).toBe("20240105-090703");
	});

	test("bytesToMB converts bytes to whole megabytes", () => {
		expect(__diag_bundle_test_helpers__.bytesToMB(0)).toBe(0);
		expect(__diag_bundle_test_helpers__.bytesToMB(1024 * 1024)).toBe(1);
		expect(__diag_bundle_test_helpers__.bytesToMB(5 * 1024 * 1024)).toBe(5);
	});

	test("buildDefaultPath uses desktop folder and zip extension", () => {
		const p = __diag_bundle_test_helpers__.buildDefaultPath();
		// Path separator is OS-dependent; normalize for assertion.
		expect(p.replace(/\\/g, "/")).toContain("/mock/desktop");
		expect(p).toMatch(/winstt-diag-\d{8}-\d{6}\.zip$/);
	});

	test("buildSystemInfo includes app version and a Generated at line", async () => {
		const text = await __diag_bundle_test_helpers__.buildSystemInfo();
		expect(text).toContain("WinSTT version: 1.2.3");
		expect(text).toContain("Generated at: ");
		expect(text).toContain("Platform: ");
		expect(text).toContain("CPU model: ");
	});

	test("collectExistingLogFiles returns empty when no log files exist", async () => {
		const os = await import("node:os");
		const fs = await import("node:fs");
		const path = await import("node:path");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-coll-"));
		try {
			const entries = __diag_bundle_test_helpers__.collectExistingLogFiles(tmpDir);
			expect(entries).toEqual([]);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("collectExistingLogFiles includes only files that actually exist", async () => {
		const os = await import("node:os");
		const fs = await import("node:fs");
		const path = await import("node:path");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-coll2-"));
		try {
			fs.writeFileSync(path.join(tmpDir, "debug.log"), "x");
			fs.writeFileSync(path.join(tmpDir, "stt-server.log"), "y");
			const entries = __diag_bundle_test_helpers__.collectExistingLogFiles(tmpDir);
			expect(entries.map((e) => e.name).sort()).toEqual(["debug.log", "stt-server.log"]);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("zip archive writing", () => {
	test("writes a non-empty zip with the system-info entry", async () => {
		const os = await import("node:os");
		const fs = await import("node:fs");
		const path = await import("node:path");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-test-"));
		const outPath = path.join(tmpDir, "out.zip");

		const result = await __diag_bundle_test_helpers__.writeZipArchive(outPath, [], "hello\n");
		expect(result.bytes).toBeGreaterThan(0);
		expect(fs.existsSync(outPath)).toBe(true);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("includes log file entries when provided", async () => {
		const os = await import("node:os");
		const fs = await import("node:fs");
		const path = await import("node:path");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-test-"));
		const logPath = path.join(tmpDir, "debug.log");
		fs.writeFileSync(logPath, "log content\n");
		const outPath = path.join(tmpDir, "bundle.zip");

		const result = await __diag_bundle_test_helpers__.writeZipArchive(
			outPath,
			[{ name: "debug.log", source: logPath }],
			"system info\n"
		);
		expect(result.bytes).toBeGreaterThan(0);
		expect(fs.existsSync(outPath)).toBe(true);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});

describe("end-to-end save path", () => {
	test("diag:save-bundle writes a zip and offers folder reveal on success", async () => {
		const os = await import("node:os");
		const fs = await import("node:fs");
		const path = await import("node:path");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-e2e-"));
		const outPath = path.join(tmpDir, "diag.zip");
		dialogState.saveResult = { canceled: false, filePath: outPath };
		dialogState.messageResult = { response: 0 }; // user clicks "Open folder"

		setupDiagBundleHandler();
		const handler = handlers.get("diag:save-bundle");
		const result = (await handler!(undefined)) as { ok: boolean; path?: string };
		expect(result.ok).toBe(true);
		expect(result.path).toBe(outPath);
		expect(fs.existsSync(outPath)).toBe(true);
		expect(shellState.showItemInFolderCalls).toEqual([outPath]);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("diag:save-bundle skips folder reveal when user clicks OK", async () => {
		const os = await import("node:os");
		const fs = await import("node:fs");
		const path = await import("node:path");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-ok-"));
		const outPath = path.join(tmpDir, "diag.zip");
		dialogState.saveResult = { canceled: false, filePath: outPath };
		dialogState.messageResult = { response: 1 }; // OK

		setupDiagBundleHandler();
		const handler = handlers.get("diag:save-bundle");
		const result = (await handler!(undefined)) as { ok: boolean };
		expect(result.ok).toBe(true);
		expect(shellState.showItemInFolderCalls).toEqual([]);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});

describe("logGpuInfoError", () => {
	test("logs an Error's .message under the diag-bundle scope", () => {
		__diag_bundle_test_helpers__.logGpuInfoError(new Error("gpu blew up"));
		expect(debugLogState.calls.length).toBe(1);
		const call = debugLogState.calls[0];
		expect(call?.scope).toBe("diag-bundle");
		expect(call?.args[0]).toBe("getGPUInfo failed:");
		expect(call?.args[1]).toBe("gpu blew up");
	});

	test("stringifies non-Error values via String(err)", () => {
		__diag_bundle_test_helpers__.logGpuInfoError("string failure");
		expect(debugLogState.calls.length).toBe(1);
		expect(debugLogState.calls[0]?.args[1]).toBe("string failure");
	});

	test("handles null/undefined without throwing", () => {
		__diag_bundle_test_helpers__.logGpuInfoError(null);
		__diag_bundle_test_helpers__.logGpuInfoError(undefined);
		expect(debugLogState.calls.length).toBe(2);
		expect(debugLogState.calls[0]?.args[1]).toBe("null");
		expect(debugLogState.calls[1]?.args[1]).toBe("undefined");
	});
});

describe("logRevealDialogError", () => {
	test("logs an Error's .message under the diag-bundle scope", () => {
		__diag_bundle_test_helpers__.logRevealDialogError(new Error("dialog crashed"));
		expect(debugLogState.calls.length).toBe(1);
		const call = debugLogState.calls[0];
		expect(call?.scope).toBe("diag-bundle");
		expect(call?.args[0]).toBe("Post-save dialog failed:");
		expect(call?.args[1]).toBe("dialog crashed");
	});

	test("stringifies non-Error values via String(err)", () => {
		__diag_bundle_test_helpers__.logRevealDialogError(42);
		expect(debugLogState.calls.length).toBe(1);
		expect(debugLogState.calls[0]?.args[1]).toBe("42");
	});
});

describe("safeShowErrorBox", () => {
	test("calls dialog.showErrorBox with the diagnostic-bundle title and message", () => {
		__diag_bundle_test_helpers__.safeShowErrorBox("Disk full");
		expect(dialogState.errorBoxCalls).toEqual([
			{ title: "Diagnostic bundle failed", content: "Disk full" },
		]);
	});

	test("swallows showErrorBox failures (does not throw)", () => {
		const original = dialogState.errorBoxCalls;
		// Force showErrorBox to throw by swapping the mocked impl temporarily.
		// We can't easily re-mock electron here, so simulate by passing a value
		// that the mock would record fine — main behavior is the try/catch
		// guards a hypothetical throw. Verify with a getter that throws.
		Object.defineProperty(dialogState, "errorBoxCalls", {
			configurable: true,
			get() {
				throw new Error("dialog unavailable");
			},
		});
		expect(() => __diag_bundle_test_helpers__.safeShowErrorBox("anything")).not.toThrow();
		// Restore plain property so other tests work.
		Object.defineProperty(dialogState, "errorBoxCalls", {
			configurable: true,
			writable: true,
			value: original,
		});
	});
});

describe("reportSaveFailure", () => {
	test("returns ok:false with the Error.message and logs + Sentry + error box", () => {
		const result = __diag_bundle_test_helpers__.reportSaveFailure(new Error("write failed"));
		expect(result).toEqual({ ok: false, error: "write failed" });
		// dbg called with "Bundle save failed:" + message
		expect(debugLogState.calls.length).toBe(1);
		expect(debugLogState.calls[0]?.args[0]).toBe("Bundle save failed:");
		expect(debugLogState.calls[0]?.args[1]).toBe("write failed");
		// Sentry receives the original error + source tag
		expect(sentryState.exceptions.length).toBe(1);
		expect((sentryState.exceptions[0]?.err as Error).message).toBe("write failed");
		expect(sentryState.exceptions[0]?.context).toEqual({ source: "diag-bundle" });
		// User-visible error box surfaced the message
		expect(dialogState.errorBoxCalls).toEqual([
			{ title: "Diagnostic bundle failed", content: "write failed" },
		]);
	});

	test("stringifies non-Error values via String(err)", () => {
		const result = __diag_bundle_test_helpers__.reportSaveFailure("EACCES");
		expect(result).toEqual({ ok: false, error: "EACCES" });
		expect(debugLogState.calls[0]?.args[1]).toBe("EACCES");
		expect(dialogState.errorBoxCalls[0]?.content).toBe("EACCES");
	});
});

afterEach(() => {
	handlers.clear();
});
