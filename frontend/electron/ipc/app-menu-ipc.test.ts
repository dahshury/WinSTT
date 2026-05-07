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
		await setHandler?.(undefined, [{ label: "Open", actionId: "open-main" }, { label: "" }]);

		expect(appliedTemplates).toHaveLength(1);
		const template = appliedTemplates[0] as Array<{ click?: () => void }>;
		expect(template).toHaveLength(1);
		template[0]?.click?.();
		expect(actions).toEqual(["open-main"]);

		const resetHandler = ipcMain.handlers.get(APP_MENU_RESET_CHANNEL);
		await resetHandler?.(undefined);
		expect(resetCalls).toHaveLength(1);
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
