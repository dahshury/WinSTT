import { beforeEach, describe, expect, mock, test } from "bun:test";
import { debugLogMock } from "@test/mocks/debug-log";
import { electronMock } from "@test/mocks/electron";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

const shellState: {
	openPathResult: string;
	openPathCalls: string[];
} = {
	openPathResult: "",
	openPathCalls: [],
};

const fsState: {
	mkdirCalls: Array<{ path: string; opts: unknown }>;
	mkdirThrows: Error | null;
} = {
	mkdirCalls: [],
	mkdirThrows: null,
};

// Mirrors diag-bundle.test.ts: spread `debugLogMock()` so the global mock leak
// is semantically complete, and override `dbg` so we can assert log calls.
mock.module("../lib/debug-log", () => ({
	...debugLogMock(),
	dbg: () => undefined,
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
				return `/mock/${name}`;
			},
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
		shell: {
			...base.shell,
			openPath: (p: string) => {
				shellState.openPathCalls.push(p);
				return Promise.resolve(shellState.openPathResult);
			},
		},
	};
});

mock.module("node:fs/promises", () => ({
	mkdir: async (p: string, opts: unknown) => {
		fsState.mkdirCalls.push({ path: p, opts });
		if (fsState.mkdirThrows) {
			throw fsState.mkdirThrows;
		}
	},
}));

const { setupCustomModelsHandlers, __custom_models_test_helpers__ } = await import(
	"./custom-models"
);

beforeEach(() => {
	handlers.clear();
	shellState.openPathResult = "";
	shellState.openPathCalls = [];
	fsState.mkdirCalls = [];
	fsState.mkdirThrows = null;
});

describe("setupCustomModelsHandlers", () => {
	test("registers the custom-models:open-folder handler", () => {
		const cleanup = setupCustomModelsHandlers();
		expect(handlers.has("custom-models:open-folder")).toBe(true);
		cleanup();
	});

	test("cleanup removes the handler", () => {
		const cleanup = setupCustomModelsHandlers();
		cleanup();
		expect(handlers.has("custom-models:open-folder")).toBe(false);
	});

	test("handler creates the directory and opens it via shell.openPath", async () => {
		setupCustomModelsHandlers();
		const handler = handlers.get("custom-models:open-folder");
		expect(handler).toBeDefined();
		if (!handler) {
			return;
		}
		const result = (await handler(null)) as { ok: boolean; path?: string; error?: string };
		// The userData path is "/mock/userData" — the handler joins
		// "models/custom" onto it (path.join inserts the OS separator).
		expect(fsState.mkdirCalls).toHaveLength(1);
		expect(fsState.mkdirCalls[0]?.path).toContain("custom");
		expect(shellState.openPathCalls).toHaveLength(1);
		expect(result.ok).toBe(true);
		expect(result.path).toContain("custom");
	});

	test("handler returns ok:false with the error message on shell.openPath failure", async () => {
		shellState.openPathResult = "shell refused"; // non-empty = error
		setupCustomModelsHandlers();
		const handler = handlers.get("custom-models:open-folder");
		const result = (await handler?.(null)) as { ok: boolean; error?: string };
		expect(result.ok).toBe(false);
		expect(result.error).toBe("shell refused");
	});

	test("handler returns ok:false with the error message on mkdir failure", async () => {
		fsState.mkdirThrows = new Error("permission denied");
		setupCustomModelsHandlers();
		const handler = handlers.get("custom-models:open-folder");
		const result = (await handler?.(null)) as { ok: boolean; error?: string };
		expect(result.ok).toBe(false);
		expect(result.error).toBe("permission denied");
		// shell.openPath must not be called when the mkdir step failed —
		// otherwise we'd ask the OS to open a folder we couldn't create.
		expect(shellState.openPathCalls).toHaveLength(0);
	});
});

describe("__custom_models_test_helpers__", () => {
	test("getCustomModelsFolder uses {userData}/models/custom", () => {
		const target = __custom_models_test_helpers__.getCustomModelsFolder();
		// path.join uses the OS separator, so on Windows the expected
		// substring is "\mock\userData" but on POSIX it's "/mock/userData".
		// Just check for the userData segment + the trailing models/custom
		// portion regardless of separator direction.
		expect(target).toMatch(/mock[\\/]userData/);
		expect(target).toMatch(/models[\\/]custom/);
	});
});
