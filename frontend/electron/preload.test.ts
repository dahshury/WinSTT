import { describe, expect, mock, test } from "bun:test";

// ── Capture the API exposed via contextBridge so we can exercise it ───
let exposed: Record<string, unknown> = {};
let exposedName = "";

const ipcSent: Array<{ channel: string; args: unknown[] }> = [];
const ipcInvoked: Array<{ channel: string; args: unknown[] }> = [];
const ipcOnHandlers = new Map<string, (event: unknown, ...args: unknown[]) => void>();

// Spread the shared electron stub so this mock provides every export the
// rest of the suite depends on (`mock.module(...)` is process-global — the
// LAST call wins, so a partial mock here would break tests that import
// `app`, `ipcMain`, etc. via electron).
import { electronMock } from "@test/mocks/electron";

mock.module("electron", () => ({
	...electronMock(),
	contextBridge: {
		exposeInMainWorld: (name: string, api: Record<string, unknown>) => {
			exposedName = name;
			exposed = api;
		},
	},
	ipcRenderer: {
		send: (channel: string, ...args: unknown[]) => {
			ipcSent.push({ channel, args });
		},
		invoke: async (channel: string, ...args: unknown[]) => {
			ipcInvoked.push({ channel, args });
			return;
		},
		on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) => {
			ipcOnHandlers.set(channel, handler);
		},
		removeListener: (channel: string) => {
			ipcOnHandlers.delete(channel);
		},
	},
	webUtils: {
		getPathForFile: (_file: File) => "/mock/path/to/file",
	},
}));

await import("./preload");

describe("preload (contextBridge surface)", () => {
	test("exposes the API on window.electronAPI", () => {
		expect(exposedName).toBe("electronAPI");
		expect(typeof exposed.send).toBe("function");
		expect(typeof exposed.invoke).toBe("function");
		expect(typeof exposed.on).toBe("function");
		expect(typeof exposed.secureInvoke).toBe("function");
		expect(typeof exposed.getPathForFile).toBe("function");
	});

	test("send forwards allowed channels to ipcRenderer.send", () => {
		ipcSent.length = 0;
		(exposed.send as (channel: string, ...args: unknown[]) => void)("window:minimize");
		expect(ipcSent).toEqual([{ channel: "window:minimize", args: [] }]);
	});

	test("send silently drops disallowed channels", () => {
		ipcSent.length = 0;
		(exposed.send as (channel: string, ...args: unknown[]) => void)("evil:channel", { payload: 1 });
		expect(ipcSent).toEqual([]);
	});

	test("invoke forwards allowed channels and returns the ipcRenderer result", async () => {
		ipcInvoked.length = 0;
		const promise = (exposed.invoke as (channel: string, ...args: unknown[]) => Promise<unknown>)(
			"settings:load"
		);
		await promise;
		expect(ipcInvoked.some((c) => c.channel === "settings:load")).toBe(true);
	});

	test("invoke rejects disallowed channels", async () => {
		await expect(
			(exposed.invoke as (channel: string, ...args: unknown[]) => Promise<unknown>)("rm -rf /")
		).rejects.toThrow(/Blocked IPC invoke/);
	});

	test("on registers an ipcRenderer.on listener for allowed channels and returns an unsubscribe", () => {
		ipcOnHandlers.clear();
		const calls: unknown[][] = [];
		const unsubscribe = (
			exposed.on as (channel: string, cb: (...args: unknown[]) => void) => () => void
		)("stt:realtime-text", (...args) => calls.push(args));
		expect(typeof unsubscribe).toBe("function");
		const handler = ipcOnHandlers.get("stt:realtime-text");
		expect(handler).toBeDefined();
		// Fire it and confirm the IpcRendererEvent is stripped
		handler?.({}, "hello");
		expect(calls).toEqual([["hello"]]);
		unsubscribe();
	});

	test("on returns a no-op unsubscribe for disallowed channels", () => {
		ipcOnHandlers.clear();
		const unsubscribe = (
			exposed.on as (channel: string, cb: (...args: unknown[]) => void) => () => void
		)("evil:channel", () => undefined);
		expect(typeof unsubscribe).toBe("function");
		expect(ipcOnHandlers.has("evil:channel")).toBe(false);
		// Calling unsubscribe doesn't throw
		expect(() => unsubscribe()).not.toThrow();
	});

	test("secureInvoke rejects disallowed channels without making any IPC call", async () => {
		await expect(
			(exposed.secureInvoke as (channel: string, payload?: unknown) => Promise<unknown>)(
				"not-a-secure-channel" as unknown as never
			)
		).rejects.toThrow(/Blocked secure invoke/);
	});

	test("getPathForFile delegates to webUtils", () => {
		const fakeFile = {} as File;
		const result = (exposed.getPathForFile as (file: File) => string)(fakeFile);
		expect(result).toBe("/mock/path/to/file");
	});
});
