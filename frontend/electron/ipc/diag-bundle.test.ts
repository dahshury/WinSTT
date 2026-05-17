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

afterEach(() => {
	handlers.clear();
});
