import { describe, expect, test } from "bun:test";
import { cn } from "./cn";

describe("cn", () => {
	test("returns empty string for no arguments", () => {
		expect(cn()).toBe("");
	});

	test("joins multiple class names with a space", () => {
		expect(cn("a", "b", "c")).toBe("a b c");
	});

	test("filters out falsy values (undefined, null, false, 0, '')", () => {
		expect(cn("a", undefined, null, false, "", 0, "b")).toBe("a b");
	});

	test("flattens nested arrays of class values", () => {
		expect(cn(["a", "b"], ["c", ["d"]])).toBe("a b c d");
	});

	test("supports conditional object syntax via clsx", () => {
		expect(cn({ foo: true, bar: false, baz: 1 })).toBe("foo baz");
	});

	test("merges conflicting tailwind classes via twMerge — last wins", () => {
		expect(cn("p-2", "p-4")).toBe("p-4");
		expect(cn("text-sm", "text-lg")).toBe("text-lg");
	});

	test("preserves non-conflicting tailwind classes", () => {
		expect(cn("p-2", "m-4")).toBe("p-2 m-4");
	});

	test("merges responsive variants correctly", () => {
		expect(cn("md:p-2", "md:p-4")).toBe("md:p-4");
		expect(cn("md:p-2", "lg:p-4")).toBe("md:p-2 lg:p-4");
	});
});
