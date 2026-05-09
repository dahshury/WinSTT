import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";

mock.module("electron", () => ({
	...electronMock(),
	nativeImage: {
		createFromPath: () => ({ isEmpty: () => true }),
		createEmpty: () => ({ isEmpty: () => true }),
	},
	Tray: class {
		setToolTip = () => undefined;
		on = () => undefined;
		setImage = () => undefined;
	} as unknown as typeof import("electron").Tray,
}));

mock.module("./tray-menu-window", () => ({
	showTrayMenuAt: () => undefined,
}));

const { setupTray } = await import("./tray");

describe("setupTray", () => {
	test("module exports the setup function", () => {
		expect(typeof setupTray).toBe("function");
	});

	test("setupTray creates a Tray and returns it without throwing", () => {
		const win = { show: () => undefined } as unknown as Electron.BrowserWindow;
		const tray = setupTray(win);
		expect(tray).toBeDefined();
	});
});
