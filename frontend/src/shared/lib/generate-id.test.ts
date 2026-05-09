import { describe, expect, test } from "bun:test";
import { generateId } from "./generate-id";

describe("generateId", () => {
	test("returns a UUID v4 string", () => {
		const id = generateId();
		expect(typeof id).toBe("string");
		// Standard RFC 4122 v4 UUID layout (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx)
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	});

	test("returns a different value on each call", () => {
		const ids = new Set(Array.from({ length: 1000 }, () => generateId()));
		expect(ids.size).toBe(1000);
	});
});
