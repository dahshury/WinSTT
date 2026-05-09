import { describe, expect, test } from "bun:test";
import { createTranscriptionItem } from "./transcription";

describe("createTranscriptionItem", () => {
	test("returns a fully-populated item with auto id and timestamp", () => {
		const item = createTranscriptionItem("realtime", "hello");
		expect(item.type).toBe("realtime");
		expect(item.text).toBe("hello");
		expect(typeof item.id).toBe("string");
		expect(item.id.length).toBeGreaterThan(0);
		expect(typeof item.timestamp).toBe("number");
		expect(item.timestamp).toBeGreaterThan(0);
	});

	test("uses the supplied id when provided", () => {
		const item = createTranscriptionItem("final", "x", "id-1");
		expect(item.id).toBe("id-1");
	});

	test("uses the supplied timestamp when provided", () => {
		const item = createTranscriptionItem("final", "x", "id-1", 1234);
		expect(item.timestamp).toBe(1234);
	});

	test("two consecutive auto-generated items have different ids", () => {
		const a = createTranscriptionItem("realtime", "x");
		const b = createTranscriptionItem("realtime", "y");
		expect(a.id).not.toBe(b.id);
	});
});
