import { describe, expect, test } from "bun:test";
import { ValidationError } from "../../src/shared/lib/errors";
import { createClipboardHandler, normalizeClipboardPayload } from "./clipboard";

describe("normalizeClipboardPayload", () => {
	test("normalizes read operation aliases", () => {
		expect(normalizeClipboardPayload({ operation: " read_text " })).toEqual({
			operation: "readText",
		});
		expect(normalizeClipboardPayload({ operation: "READ-TEXT" })).toEqual({
			operation: "readText",
		});
	});

	test("normalizes the bare 'read' alias to 'readText'", () => {
		// Targets the CANONICAL_OPERATION["read"] entry specifically — without
		// this case, the value mapping at L24 isn't exercised.
		expect(normalizeClipboardPayload({ operation: "read" })).toEqual({
			operation: "readText",
		});
	});

	test("normalizes the bare 'write' alias to 'writeText'", () => {
		expect(normalizeClipboardPayload({ operation: "write", text: "x" })).toEqual({
			operation: "writeText",
			text: "x",
		});
	});

	test("normalizes write payload and line endings", () => {
		expect(
			normalizeClipboardPayload({
				operation: "write-text",
				text: "line1\r\nline2\rline3",
			})
		).toEqual({
			operation: "writeText",
			text: "line1\nline2\nline3",
		});
	});

	test("normalizes clear operation aliases", () => {
		expect(normalizeClipboardPayload({ operation: "clear" })).toEqual({
			operation: "clear",
		});
		expect(normalizeClipboardPayload({ operation: " CLEAR " })).toEqual({
			operation: "clear",
		});
	});

	test("throws ValidationError for invalid payload shape", () => {
		expect(() => normalizeClipboardPayload(null)).toThrow(ValidationError);
		expect(() => normalizeClipboardPayload("readText")).toThrow(ValidationError);
		expect(() => normalizeClipboardPayload({})).toThrow(ValidationError);
	});

	test("throws ValidationError when write operation has invalid text", () => {
		expect(() => normalizeClipboardPayload({ operation: "writeText" })).toThrow(ValidationError);
		expect(() => normalizeClipboardPayload({ operation: "writeText", text: 123 })).toThrow(
			ValidationError
		);
	});

	test("throws ValidationError for unsupported operation", () => {
		expect(() => normalizeClipboardPayload({ operation: "paste" })).toThrow(ValidationError);
	});
});

describe("createClipboardHandler", () => {
	test("returns clipboard text for read operation", async () => {
		const clipboard = {
			clearCalls: 0,
			lastWrite: "",
			readText: () => "from-clipboard",
			writeText(text: string) {
				this.lastWrite = text;
			},
			clear() {
				this.clearCalls += 1;
			},
		};

		const handler = createClipboardHandler(clipboard);
		const result = await handler({} as never, { operation: "read-text" });

		expect(result).toEqual({ operation: "readText", text: "from-clipboard" });
		expect(clipboard.lastWrite).toBe("");
		expect(clipboard.clearCalls).toBe(0);
	});

	test("writes normalized text and reports write operation", async () => {
		const clipboard = {
			clearCalls: 0,
			lastWrite: "",
			readText: () => "",
			writeText(text: string) {
				this.lastWrite = text;
			},
			clear() {
				this.clearCalls += 1;
			},
		};

		const handler = createClipboardHandler(clipboard);
		const result = await handler({} as never, {
			operation: "write_text",
			text: "a\r\nb",
		});

		expect(result).toEqual({ operation: "writeText" });
		expect(clipboard.lastWrite).toBe("a\nb");
		expect(clipboard.clearCalls).toBe(0);
	});

	test("clears clipboard and reports clear operation", async () => {
		const clipboard = {
			clearCalls: 0,
			lastWrite: "",
			readText: () => "",
			writeText(text: string) {
				this.lastWrite = text;
			},
			clear() {
				this.clearCalls += 1;
			},
		};

		const handler = createClipboardHandler(clipboard);
		const result = await handler({} as never, { operation: "clear" });

		expect(result).toEqual({ operation: "clear" });
		expect(clipboard.clearCalls).toBe(1);
		expect(clipboard.lastWrite).toBe("");
	});
});
