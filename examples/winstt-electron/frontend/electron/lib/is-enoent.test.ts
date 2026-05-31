import { describe, expect, test } from "bun:test";
import { isEnoent } from "./is-enoent";

describe("isEnoent", () => {
	test("true for an Error tagged with code 'ENOENT'", () => {
		expect(isEnoent(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe(true);
	});

	test("true for a plain object with code 'ENOENT'", () => {
		expect(isEnoent({ code: "ENOENT" })).toBe(true);
	});

	test("false for a different fs error code", () => {
		expect(isEnoent(Object.assign(new Error("denied"), { code: "EPERM" }))).toBe(false);
		expect(isEnoent({ code: "EIO" })).toBe(false);
	});

	test("false for an object lacking a code property", () => {
		expect(isEnoent(new Error("no code"))).toBe(false);
		expect(isEnoent({})).toBe(false);
	});

	test("false for null / undefined / primitives", () => {
		expect(isEnoent(null)).toBe(false);
		expect(isEnoent(undefined)).toBe(false);
		expect(isEnoent("ENOENT")).toBe(false);
		expect(isEnoent(42)).toBe(false);
	});

	test("false when code is the wrong type even if present", () => {
		expect(isEnoent({ code: 2 })).toBe(false);
	});
});
