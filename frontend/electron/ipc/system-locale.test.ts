import { beforeEach, describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

const appState = {
	locale: "en-US",
};

mock.module("electron", () => ({
	...electronMock(),
	app: {
		getLocale: () => appState.locale,
	},
	ipcMain: {
		handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
			handlers.set(channel, listener);
		},
		removeHandler: (channel: string) => handlers.delete(channel),
	},
}));

const { setupSystemLocaleHandler } = await import("./system-locale");

beforeEach(() => {
	handlers.clear();
	appState.locale = "en-US";
});

describe("setupSystemLocaleHandler", () => {
	test("registers an app:get-system-locale handler", () => {
		setupSystemLocaleHandler();
		expect(handlers.has("app:get-system-locale")).toBe(true);
	});

	test("handler returns the value of app.getLocale()", async () => {
		setupSystemLocaleHandler();
		appState.locale = "es-MX";
		const handler = handlers.get("app:get-system-locale");
		expect(await handler!({})).toBe("es-MX");
	});

	test("returned cleanup removes the registered handler", () => {
		const cleanup = setupSystemLocaleHandler();
		expect(handlers.has("app:get-system-locale")).toBe(true);
		cleanup();
		expect(handlers.has("app:get-system-locale")).toBe(false);
	});

	test("re-running setup replaces the prior handler", () => {
		setupSystemLocaleHandler();
		const first = handlers.get("app:get-system-locale");
		setupSystemLocaleHandler();
		const second = handlers.get("app:get-system-locale");
		expect(first).toBeDefined();
		expect(second).toBeDefined();
	});
});
