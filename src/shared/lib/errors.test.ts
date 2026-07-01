import { describe, expect, test } from "bun:test";
import {
	ApplicationError,
	formatErrorForLog,
	getErrorMessage,
	isApplicationError,
} from "./errors";

describe("ApplicationError", () => {
	test("captures message, name from class, and timestamp", () => {
		const before = Date.now();
		const err = new ApplicationError("boom");
		const after = Date.now();
		expect(err.message).toBe("boom");
		expect(err.name).toBe("ApplicationError");
		expect(err.timestamp).toBeGreaterThanOrEqual(before);
		expect(err.timestamp).toBeLessThanOrEqual(after);
		expect(err).toBeInstanceOf(Error);
	});

	test("preserves context object", () => {
		const ctx = { userId: 42, action: "save" };
		const err = new ApplicationError("boom", ctx);
		expect(err.context).toEqual(ctx);
	});

	test("toJSON includes name, message, context, timestamp, stack", () => {
		const err = new ApplicationError("boom", { x: 1 });
		const json = err.toJSON();
		expect(json["name"]).toBe("ApplicationError");
		expect(json["message"]).toBe("boom");
		expect(json["context"]).toEqual({ x: 1 });
		expect(typeof json["timestamp"]).toBe("number");
		expect(
			typeof json["stack"] === "string" || json["stack"] === undefined,
		).toBe(true);
	});
});

describe("isApplicationError", () => {
	test("returns true for ApplicationError instances", () => {
		expect(isApplicationError(new ApplicationError("x"))).toBe(true);
	});

	test("returns false for non-ApplicationError values", () => {
		expect(isApplicationError(new Error("x"))).toBe(false);
		expect(isApplicationError("x")).toBe(false);
		expect(isApplicationError(null)).toBe(false);
		expect(isApplicationError(undefined)).toBe(false);
		expect(isApplicationError({ message: "x" })).toBe(false);
	});
});

describe("getErrorMessage", () => {
	test("extracts message from Error", () => {
		expect(getErrorMessage(new Error("boom"))).toBe("boom");
	});

	test("Error path uniquely returns Error.message (mutator-killer for `instanceof Error`)", () => {
		// An Error subclass with a distinct `message` property — verifies the
		// `instanceof Error` branch is the one taken (a `.message` property
		// is set from the constructor), not the `"message" in error` branch.
		class MyError extends Error {
			constructor() {
				super("from-error-class");
			}
		}
		expect(getErrorMessage(new MyError())).toBe("from-error-class");
	});

	test("returns string input as-is", () => {
		expect(getErrorMessage("plain")).toBe("plain");
	});

	test("extracts .message from object with message property", () => {
		expect(getErrorMessage({ message: "obj" })).toBe("obj");
		expect(getErrorMessage({ message: 42 })).toBe("42");
	});

	test("returns fallback for null/undefined/numbers/empty objects", () => {
		expect(getErrorMessage(null)).toBe("Unknown error occurred");
		expect(getErrorMessage(undefined)).toBe("Unknown error occurred");
		expect(getErrorMessage(42)).toBe("Unknown error occurred");
		expect(getErrorMessage({})).toBe("Unknown error occurred");
	});

	test("the fallback string is exactly 'Unknown error occurred' (mutator-killer for the literal)", () => {
		expect(getErrorMessage(null)).toBe("Unknown error occurred");
		expect(getErrorMessage(null)).not.toBe("");
	});
});

describe("formatErrorForLog", () => {
	test("formats plain Error with stack", () => {
		const err = new Error("boom");
		const out = formatErrorForLog(err);
		expect(out).toContain("boom");
	});

	test("appends the stack trace separated by a newline (locks in the `\\n${stack}` template)", () => {
		const err = new Error("boom");
		// Inject a deterministic stack so the assertion is precise
		err.stack = "STACK_MARKER";
		expect(formatErrorForLog(err)).toBe("boom\nSTACK_MARKER");
	});

	test("omits the stack section for non-Error input", () => {
		expect(formatErrorForLog("plain string")).toBe("plain string");
	});

	test("includes prefix when provided", () => {
		const out = formatErrorForLog(new Error("boom"), "[ctx]");
		expect(out).toContain("[ctx]: boom");
	});

	test("includes context for ApplicationError", () => {
		const err = new ApplicationError("boom", { user: 1 });
		const out = formatErrorForLog(err);
		expect(out).toContain("Context:");
		expect(out).toContain('"user": 1');
	});

	test("does not include context section when ApplicationError has none", () => {
		const err = new ApplicationError("boom");
		const out = formatErrorForLog(err);
		expect(out).not.toContain("Context:");
	});
});
