import { describe, expect, test } from "bun:test";
import {
	APP_MENU_RESET_CHANNEL,
	APP_MENU_SET_TEMPLATE_CHANNEL,
	registerAppMenuIpcHandlers,
} from "./app-menu-ipc";

type IpcHandler = (_event: unknown, payload?: unknown) => unknown | Promise<unknown>;

function createIpcMainStub() {
	const handlers = new Map<string, IpcHandler>();
	const removed: string[] = [];

	return {
		handlers,
		removed,
		handle(channel: string, listener: IpcHandler) {
			handlers.set(channel, listener);
		},
		removeHandler(channel: string) {
			removed.push(channel);
			handlers.delete(channel);
		},
	};
}

describe("APP_MENU channel constants", () => {
	test("APP_MENU_SET_TEMPLATE_CHANNEL has the canonical channel string", () => {
		// Locks down the wire-protocol channel name. Renderer-side IPC consumers
		// reach for this exact string; mutating the literal would silently break
		// every set-template invocation.
		expect(APP_MENU_SET_TEMPLATE_CHANNEL).toBe("app-menu:set-template");
	});

	test("APP_MENU_RESET_CHANNEL has the canonical channel string", () => {
		expect(APP_MENU_RESET_CHANNEL).toBe("app-menu:reset");
	});
});

describe("registerAppMenuIpcHandlers", () => {
	test("registers handlers that normalize, build, and apply templates", async () => {
		const ipcMain = createIpcMainStub();
		const appliedTemplates: unknown[] = [];
		const resetCalls: number[] = [];
		const actions: string[] = [];

		registerAppMenuIpcHandlers({
			ipcMain,
			menuController: {
				applyTemplate: (template) => appliedTemplates.push(template),
				reset: () => {
					resetCalls.push(1);
				},
			},
			actionHandlers: {
				"open-main": () => actions.push("open-main"),
			},
		});

		expect(ipcMain.handlers.has(APP_MENU_SET_TEMPLATE_CHANNEL)).toBe(true);
		expect(ipcMain.handlers.has(APP_MENU_RESET_CHANNEL)).toBe(true);

		const setHandler = ipcMain.handlers.get(APP_MENU_SET_TEMPLATE_CHANNEL);
		const setResult = await setHandler?.(undefined, [
			{ label: "Open", actionId: "open-main" },
			{ label: "" },
		]);

		expect(appliedTemplates).toHaveLength(1);
		const template = appliedTemplates[0] as Array<{ click?: () => void }>;
		expect(template).toHaveLength(1);
		template[0]?.click?.();
		expect(actions).toEqual(["open-main"]);
		// Lock down the response shape — { applied: true, itemCount: <n> }
		expect(setResult).toEqual({ applied: true, itemCount: 1 });

		const resetHandler = ipcMain.handlers.get(APP_MENU_RESET_CHANNEL);
		const resetResult = await resetHandler?.(undefined);
		expect(resetCalls).toHaveLength(1);
		// Lock down the reset response shape — { applied: true }
		expect(resetResult).toEqual({ applied: true });
	});

	test("set-template response itemCount mirrors the built template length", async () => {
		const ipcMain = createIpcMainStub();
		registerAppMenuIpcHandlers({
			ipcMain,
			menuController: { applyTemplate: () => undefined, reset: () => undefined },
			actionHandlers: {
				a: () => undefined,
				b: () => undefined,
				c: () => undefined,
			},
		});
		const setHandler = ipcMain.handlers.get(APP_MENU_SET_TEMPLATE_CHANNEL);
		const result = await setHandler?.(undefined, [
			{ label: "A", actionId: "a" },
			{ label: "B", actionId: "b" },
			{ label: "C", actionId: "c" },
		]);
		expect(result).toEqual({ applied: true, itemCount: 3 });
	});

	test("cleanup removes handlers and resets menu state", () => {
		const ipcMain = createIpcMainStub();
		let resetCount = 0;

		const cleanup = registerAppMenuIpcHandlers({
			ipcMain,
			menuController: {
				applyTemplate: () => {
					throw new Error("not expected");
				},
				reset: () => {
					resetCount += 1;
				},
			},
			actionHandlers: {},
		});

		cleanup();

		expect(ipcMain.handlers.has(APP_MENU_SET_TEMPLATE_CHANNEL)).toBe(false);
		expect(ipcMain.handlers.has(APP_MENU_RESET_CHANNEL)).toBe(false);
		expect(ipcMain.removed).toEqual([
			APP_MENU_SET_TEMPLATE_CHANNEL,
			APP_MENU_RESET_CHANNEL,
			APP_MENU_SET_TEMPLATE_CHANNEL,
			APP_MENU_RESET_CHANNEL,
		]);
		expect(resetCount).toBe(1);
	});
});
