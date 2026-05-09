import { describe, expect, mock, test } from "bun:test";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
let dialogResult: { canceled: boolean; filePaths: string[] } = {
	canceled: true,
	filePaths: [],
};

mock.module("electron", () => ({
	ipcMain: {
		handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
			handlers.set(channel, listener);
		},
	},
	dialog: {
		showOpenDialog: async () => dialogResult,
	},
}));

const { setupDialogHandlers } = await import("./dialog");
setupDialogHandlers();

describe("setupDialogHandlers", () => {
	test("returns null when the user cancels", async () => {
		dialogResult = { canceled: true, filePaths: [] };
		const handler = handlers.get("dialog:open-file");
		expect(handler).toBeDefined();
		expect(await handler!(undefined, {})).toBeNull();
	});

	test("returns null when the file list is empty even if not canceled", async () => {
		dialogResult = { canceled: false, filePaths: [] };
		expect(await handlers.get("dialog:open-file")!(undefined, {})).toBeNull();
	});

	test("returns the first file path when the dialog returns one or more", async () => {
		dialogResult = { canceled: false, filePaths: ["C:\\foo.wav"] };
		expect(await handlers.get("dialog:open-file")!(undefined, {})).toBe("C:\\foo.wav");
	});

	test("accepts non-object options gracefully (defaults to safe values)", async () => {
		dialogResult = { canceled: false, filePaths: ["x.wav"] };
		expect(await handlers.get("dialog:open-file")!(undefined, null)).toBe("x.wav");
	});
});
