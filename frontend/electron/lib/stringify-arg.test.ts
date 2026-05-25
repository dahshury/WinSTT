import { describe, expect, test } from "bun:test";
import { identityString, jsonStringifyOrString } from "./stringify-arg";

describe("stringify-arg helpers", () => {
	test("jsonStringifyOrString returns JSON for serializable values", () => {
		expect(jsonStringifyOrString({ x: 1 })).toBe('{"x":1}');
		expect(jsonStringifyOrString([1, 2, 3])).toBe("[1,2,3]");
		expect(jsonStringifyOrString(42)).toBe("42");
		expect(jsonStringifyOrString(true)).toBe("true");
		expect(jsonStringifyOrString(null)).toBe("null");
	});

	test("jsonStringifyOrString falls back to String() on JSON failure", () => {
		const cyc: Record<string, unknown> = {};
		cyc.self = cyc;
		expect(jsonStringifyOrString(cyc)).toBe("[object Object]");
		expect(jsonStringifyOrString(BigInt(123))).toBe("123");
	});

	test("identityString returns the input cast to string", () => {
		expect(identityString("hello")).toBe("hello");
		expect(identityString("")).toBe("");
	});
});
