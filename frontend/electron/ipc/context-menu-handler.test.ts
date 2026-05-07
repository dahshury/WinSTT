import { describe, expect, test } from "bun:test";
import {
	type ContextMenuIpcRequest,
	createContextMenuIpcHandler,
	registerContextMenuIpcHandler,
} from "./context-menu-handler";

describe("createContextMenuIpcHandler", () => {
	test("returns selected id when an item is clicked before close", async () => {
		const popupCalls: Array<{ x?: number; y?: number }> = [];
		const handler = createContextMenuIpcHandler({
			popup: ({ template, x, y, onClose }) => {
				popupCalls.push({ x, y });
				(template[1] as { click?: () => void }).click?.();
				onClose();
			},
		});

		const result = await handler({}, {
			x: 32,
			y: 48,
			template: [
				{ id: "copy", label: "Copy" },
				{ id: "paste", label: "Paste" },
			],
		} satisfies ContextMenuIpcRequest);

		expect(popupCalls).toEqual([{ x: 32, y: 48 }]);
		expect(result).toEqual({ selectedId: "paste" });
	});

	test("returns null when the menu closes without a selection", async () => {
		const handler = createContextMenuIpcHandler({
			popup: ({ onClose }) => {
				onClose();
			},
		});

		const result = await handler({}, {
			template: [{ label: "No Action" }],
		} satisfies ContextMenuIpcRequest);
		expect(result).toEqual({ selectedId: null });
	});

	test("rejects invalid payloads", () => {
		const handler = createContextMenuIpcHandler({
			popup: () => {
				throw new Error("should not be called");
			},
		});

		expect(handler({}, { template: "invalid" })).rejects.toThrow(
			"Context menu request must contain a template array."
		);
	});
});

describe("registerContextMenuIpcHandler", () => {
	test("registers and returns cleanup", () => {
		const calls: string[] = [];
		let capturedHandler: unknown;
		const fakeIpcMain = {
			handle: (channel: string, handler: unknown) => {
				calls.push(`handle:${channel}`);
				capturedHandler = handler;
			},
			removeHandler: (channel: string) => {
				calls.push(`remove:${channel}`);
			},
		};

		const cleanup = registerContextMenuIpcHandler(fakeIpcMain, "context-menu:show", (() =>
			Promise.resolve({ selectedId: null })) as never);

		expect(typeof capturedHandler).toBe("function");
		expect(calls).toEqual(["remove:context-menu:show", "handle:context-menu:show"]);

		cleanup();
		expect(calls).toEqual([
			"remove:context-menu:show",
			"handle:context-menu:show",
			"remove:context-menu:show",
		]);
	});
});
