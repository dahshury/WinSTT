import { afterEach, describe, expect, test } from "bun:test";
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

	test("uses crypto.randomUUID when available (uppercase letters allowed in v4)", () => {
		// The crypto branch is always taken in Node/Bun — we lock down that the
		// happy-path returns a UUID, distinguishing it from the fallback's
		// `id-<base36>-<base36>` shape.
		const id = generateId();
		expect(id.startsWith("id-")).toBe(false);
		expect(id.length).toBeGreaterThan(20);
	});
});

describe("generateId fallback (crypto.randomUUID unavailable)", () => {
	const realCrypto = globalThis.crypto;

	afterEach(() => {
		// Restore the real Web Crypto on the global so other tests aren't
		// disturbed (Bun's `crypto` is a globally-installed shim).
		(globalThis as { crypto: typeof realCrypto }).crypto = realCrypto;
	});

	test("falls back to id-<base36ts>-<base36rand> when crypto is undefined", () => {
		(globalThis as { crypto: unknown }).crypto = undefined;
		const id = generateId();
		// Expected shape: "id-<timestamp36>-<rand8chars>"
		expect(id.startsWith("id-")).toBe(true);
		const parts = id.split("-");
		expect(parts).toHaveLength(3);
		expect(parts[0]).toBe("id");
		// Second segment is Date.now() in base 36 — non-empty
		expect(parts[1]?.length).toBeGreaterThan(0);
		// Third segment is the sliced [2, 10) of Math.random().toString(36),
		// so it is exactly 8 characters long. Mutating the .slice off would
		// make this >8 chars (typically 11-13 from full toString(36)).
		expect(parts[2]?.length).toBe(8);
	});

	test("fallback returns the literal 'id-' prefix (kills empty-template mutation)", () => {
		(globalThis as { crypto: unknown }).crypto = undefined;
		const id = generateId();
		// If the template literal mutates to "" we'd get an empty string.
		// Asserting startsWith("id-") and a min length kills that mutation.
		expect(id).not.toBe("");
		expect(id.length).toBeGreaterThan(3);
		expect(id.startsWith("id-")).toBe(true);
	});

	test("falls back when crypto exists but lacks randomUUID", () => {
		// Cover the second `&&` operand: typeof crypto.randomUUID === "function".
		(globalThis as { crypto: unknown }).crypto = {} as Crypto;
		const id = generateId();
		expect(id.startsWith("id-")).toBe(true);
	});

	test("falls back when crypto.randomUUID is present but not a function", () => {
		(globalThis as { crypto: unknown }).crypto = {
			randomUUID: "not-a-function" as unknown as Crypto["randomUUID"],
		} as Crypto;
		const id = generateId();
		expect(id.startsWith("id-")).toBe(true);
	});

	test("fallback IDs are distinct across rapid calls", () => {
		(globalThis as { crypto: unknown }).crypto = undefined;
		const ids = new Set(Array.from({ length: 200 }, () => generateId()));
		// Math.random() collisions in base36[2,10) are astronomically rare.
		expect(ids.size).toBeGreaterThan(190);
	});
});
