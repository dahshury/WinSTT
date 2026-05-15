import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const listeners = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>();

const appState = {
	loginItemSettings: { openAtLogin: false } as { openAtLogin: boolean },
	setCalls: [] as Array<{ openAtLogin: boolean }>,
};

mock.module("electron", () => ({
	...electronMock(),
	app: {
		getLoginItemSettings: () => appState.loginItemSettings,
		setLoginItemSettings: (s: { openAtLogin: boolean }) => {
			appState.setCalls.push(s);
			appState.loginItemSettings = s;
		},
	},
	ipcMain: {
		handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
			handlers.set(channel, listener);
		},
		on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(listener);
			listeners.set(channel, list);
		},
		removeHandler: (channel: string) => handlers.delete(channel),
		off: () => undefined,
		removeAllListeners: () => undefined,
	},
}));

const { setupAutostartHandlers } = await import("./autostart");

const originalPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: p, configurable: true });
}
function resetPlatform(): void {
	Object.defineProperty(process, "platform", {
		value: originalPlatform,
		configurable: true,
	});
}

beforeEach(() => {
	handlers.clear();
	listeners.clear();
	appState.loginItemSettings = { openAtLogin: false };
	appState.setCalls = [];
	setupAutostartHandlers();
});

afterEach(() => {
	resetPlatform();
});

describe("setupAutostartHandlers", () => {
	test("registers autostart:get handler and autostart:set listener", () => {
		expect(handlers.has("autostart:get")).toBe(true);
		expect(listeners.has("autostart:set")).toBe(true);
	});

	test("autostart:get returns false on unsupported platforms (linux)", async () => {
		setPlatform("linux");
		const handler = handlers.get("autostart:get");
		expect(await handler!({})).toBe(false);
	});

	test("autostart:get returns false on linux EVEN when openAtLogin is true (kills `if (false)` and `{}` mutants on the unsupported-platform guard)", async () => {
		// Set openAtLogin=true so a mutant that drops the guard would return true.
		// The genuine guard MUST return false because the platform is unsupported.
		appState.loginItemSettings = { openAtLogin: true };
		setPlatform("linux");
		const handler = handlers.get("autostart:get");
		expect(await handler!({})).toBe(false);
	});

	test("autostart:get returns the login item setting on win32", async () => {
		setPlatform("win32");
		appState.loginItemSettings = { openAtLogin: true };
		const handler = handlers.get("autostart:get");
		expect(await handler!({})).toBe(true);
	});

	test("autostart:get returns the login item setting on darwin", async () => {
		setPlatform("darwin");
		appState.loginItemSettings = { openAtLogin: false };
		const handler = handlers.get("autostart:get");
		expect(await handler!({})).toBe(false);
	});

	test("autostart:set is a no-op on unsupported platforms (linux)", () => {
		setPlatform("linux");
		const cbs = listeners.get("autostart:set") ?? [];
		for (const cb of cbs) {
			cb({}, { enabled: true });
		}
		expect(appState.setCalls.length).toBe(0);
	});

	test("autostart:set with valid payload calls setLoginItemSettings on win32", () => {
		setPlatform("win32");
		const cbs = listeners.get("autostart:set") ?? [];
		for (const cb of cbs) {
			cb({}, { enabled: true });
		}
		expect(appState.setCalls.length).toBe(1);
		expect(appState.setCalls[0]?.openAtLogin).toBe(true);
	});

	test("autostart:set with invalid payload (non-boolean) is dropped", () => {
		setPlatform("win32");
		const cbs = listeners.get("autostart:set") ?? [];
		for (const cb of cbs) {
			cb({}, { enabled: "yes" });
		}
		expect(appState.setCalls.length).toBe(0);
	});

	test("autostart:set with null payload is dropped", () => {
		setPlatform("win32");
		const cbs = listeners.get("autostart:set") ?? [];
		for (const cb of cbs) {
			cb({}, null);
		}
		expect(appState.setCalls.length).toBe(0);
	});

	test("autostart:set with enabled=false sets openAtLogin to false", () => {
		setPlatform("darwin");
		appState.loginItemSettings = { openAtLogin: true };
		const cbs = listeners.get("autostart:set") ?? [];
		for (const cb of cbs) {
			cb({}, { enabled: false });
		}
		expect(appState.setCalls.length).toBe(1);
		expect(appState.setCalls[0]?.openAtLogin).toBe(false);
	});
});
