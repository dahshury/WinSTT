import { describe, expect, test } from "bun:test";
import { truncate } from "./truncate";

describe("truncate", () => {
	test("returns the string unchanged when within the limit", () => {
		expect(truncate("hello", 5)).toBe("hello");
		expect(truncate("hi", 10)).toBe("hi");
	});

	test("clips to max chars and appends an ellipsis when over the limit", () => {
		expect(truncate("hello world", 5)).toBe("hello…");
	});

	test("trims trailing whitespace before the ellipsis", () => {
		expect(truncate("hello     world", 6)).toBe("hello…");
	});

	test("handles an empty string", () => {
		expect(truncate("", 5)).toBe("");
	});
});
