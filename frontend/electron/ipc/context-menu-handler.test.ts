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
				const call: { x?: number; y?: number } = {};
				if (x !== undefined) {
					call.x = x;
				}
				if (y !== undefined) {
					call.y = y;
				}
				popupCalls.push(call);
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

	test("rejects non-finite x coordinate", () => {
		const handler = createContextMenuIpcHandler({ popup: () => undefined });
		expect(handler({}, { template: [], x: Number.NaN })).rejects.toThrow(
			"x must be a finite number"
		);
	});

	test("rejects non-finite y coordinate", () => {
		const handler = createContextMenuIpcHandler({ popup: () => undefined });
		expect(handler({}, { template: [], y: Number.POSITIVE_INFINITY })).rejects.toThrow(
			"y must be a finite number"
		);
	});

	test("rejects non-numeric x coordinate (e.g., string)", () => {
		// Kills the L95 ConditionalExpression mutant where the entire
		// `typeof value === "number" && Number.isFinite(value)` is replaced
		// with `true`. A string "10" passes typeof check fail-fast in the real
		// guard but the mutant would let it through, then the popup adapter
		// would receive an invalid x.
		const handler = createContextMenuIpcHandler({ popup: () => undefined });
		expect(handler({}, { template: [], x: "10" as unknown as number })).rejects.toThrow(
			"x must be a finite number"
		);
	});

	test("rejects non-numeric y coordinate (e.g., null)", () => {
		const handler = createContextMenuIpcHandler({ popup: () => undefined });
		expect(handler({}, { template: [], y: null as unknown as number })).rejects.toThrow(
			"y must be a finite number"
		);
	});

	test("accepts valid x and y coordinates", async () => {
		const handler = createContextMenuIpcHandler({
			popup: ({ onClose }) => {
				onClose();
			},
		});
		const result = await handler({}, { template: [], x: 10, y: 20 });
		expect(result).toEqual({ selectedId: null });
	});

	test("omits x and y when not provided", async () => {
		const handler = createContextMenuIpcHandler({
			popup: ({ onClose, x: _x, y: _y }) => {
				onClose();
			},
		});
		const result = await handler({}, { template: [] });
		expect(result).toEqual({ selectedId: null });
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
