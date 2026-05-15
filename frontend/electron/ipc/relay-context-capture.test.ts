import { describe, expect, test } from "bun:test";
import type { WindowContextSnapshot } from "../lib/context-snapshot";
import { createContextCapture } from "./relay-context-capture";

const SNAP: WindowContextSnapshot = {
	windowTitle: "Editor",
	elementName: "Body",
	focusedText: "Dear Dr. Aljarbou,",
};

describe("createContextCapture", () => {
	test("consume returns '' when feature is disabled (no read performed)", async () => {
		let readCalls = 0;
		const cap = createContextCapture({
			isEnabled: () => false,
			read: async () => {
				readCalls += 1;
				return SNAP;
			},
		});
		cap.capture();
		const out = await cap.consume();
		expect(out).toBe("");
		expect(readCalls).toBe(0);
	});

	test("consume returns formatted context after capture when enabled", async () => {
		const cap = createContextCapture({
			isEnabled: () => true,
			read: async () => SNAP,
		});
		cap.capture();
		const out = await cap.consume();
		expect(out).toContain("Window: Editor");
		expect(out).toContain("Focused field: Body");
		expect(out).toContain("Dear Dr. Aljarbou,");
	});

	test("consume returns '' when capture was never called", async () => {
		const cap = createContextCapture({
			isEnabled: () => true,
			read: async () => SNAP,
		});
		const out = await cap.consume();
		expect(out).toBe("");
	});

	test("consume drains state — subsequent consume returns ''", async () => {
		const cap = createContextCapture({
			isEnabled: () => true,
			read: async () => SNAP,
		});
		cap.capture();
		expect(await cap.consume()).not.toBe("");
		expect(await cap.consume()).toBe("");
	});

	test("a second capture overwrites the first", async () => {
		const readouts = [
			{ windowTitle: "First", elementName: "", focusedText: "" },
			{ windowTitle: "Second", elementName: "", focusedText: "" },
		];
		let idx = 0;
		const cap = createContextCapture({
			isEnabled: () => true,
			read: async () => readouts[idx++] as WindowContextSnapshot,
		});
		cap.capture();
		cap.capture();
		const out = await cap.consume();
		expect(out).toContain("Window: Second");
	});

	test("clear discards a pending snapshot", async () => {
		const cap = createContextCapture({
			isEnabled: () => true,
			read: async () => SNAP,
		});
		cap.capture();
		cap.clear();
		expect(await cap.consume()).toBe("");
	});

	test("a rejected read resolves to empty context (never throws)", async () => {
		const cap = createContextCapture({
			isEnabled: () => true,
			read: () => Promise.reject(new Error("UIA died")),
		});
		cap.capture();
		expect(await cap.consume()).toBe("");
	});
});
