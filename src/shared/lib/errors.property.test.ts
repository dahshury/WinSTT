import { describe, test } from "bun:test";
import fc from "fast-check";
import {
	ApplicationError,
	ConnectionError,
	FileSystemError,
	formatErrorForLog,
	getErrorMessage,
	getErrorStack,
	IpcError,
	isApplicationError,
	NotFoundError,
	ProcessSpawnError,
	TimeoutError,
	ValidationError,
} from "./errors";

// Arbitrary for JSON-safe context objects (avoid functions, undefined,
// non-finite numbers — they don't survive JSON.stringify cleanly).
const contextArb = fc.dictionary(
	fc.string(),
	fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
);

describe("ApplicationError property tests", () => {
	test("toJSON preserves message/name/context/timestamp for every input", () => {
		fc.assert(
			fc.property(fc.string(), contextArb, (msg, ctx) => {
				const err = new ApplicationError(msg, ctx);
				const json = err.toJSON();
				return (
					json["message"] === msg &&
					json["name"] === "ApplicationError" &&
					typeof json["timestamp"] === "number" &&
					Number.isFinite(json["timestamp"] as number) &&
					JSON.stringify(json["context"]) === JSON.stringify(ctx)
				);
			}),
			{ numRuns: 200 },
		);
	});

	test("isApplicationError is exhaustive across all subclasses", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 7 }), fc.string(), (kind, msg) => {
				const errors: Error[] = [
					new ApplicationError(msg),
					new ValidationError(msg, "field"),
					new NotFoundError("Resource", "id"),
					new ConnectionError(msg, "ep", true),
					new TimeoutError(100, "op"),
					new IpcError(msg, "ch", "invoke"),
					new FileSystemError(msg, "/x", "read"),
					new ProcessSpawnError(msg, "cmd", 1),
				];
				const idx = kind % errors.length;
				const target = errors[idx];
				if (target === undefined) {
					return false;
				}
				return isApplicationError(target) === true;
			}),
			{ numRuns: 250 },
		);
	});

	test("isApplicationError returns false for non-Error values", () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.string(),
					fc.integer(),
					fc.boolean(),
					fc.constant(null),
					fc.constant(undefined),
					fc.object(),
					fc.array(fc.string()),
				),
				(value) => isApplicationError(value) === false,
			),
			{ numRuns: 200 },
		);
	});
});

describe("getErrorMessage property tests", () => {
	test("idempotent: getErrorMessage(getErrorMessage(x)) === getErrorMessage(x) (string → string)", () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.string(),
					fc.integer(),
					fc.boolean(),
					fc.constant(null),
					fc.constant(undefined),
					fc.string().map((s) => new Error(s)),
					fc.string().map((s) => ({ message: s })),
				),
				(value) => {
					const once = getErrorMessage(value);
					const twice = getErrorMessage(once);
					return typeof once === "string" && once === twice;
				},
			),
			{ numRuns: 300 },
		);
	});

	test("string input is returned as-is verbatim", () => {
		fc.assert(
			fc.property(fc.string(), (s) => getErrorMessage(s) === s),
			{ numRuns: 300 },
		);
	});

	test("object with .message returns String(message)", () => {
		fc.assert(
			fc.property(
				fc.oneof(fc.string(), fc.integer(), fc.boolean()),
				(msg) => getErrorMessage({ message: msg }) === String(msg),
			),
			{ numRuns: 200 },
		);
	});

	test("always returns a string, never throws", () => {
		fc.assert(
			fc.property(fc.anything(), (value) => {
				const out = getErrorMessage(value);
				return typeof out === "string";
			}),
			{ numRuns: 300 },
		);
	});
});

describe("getErrorStack property tests", () => {
	test("returns string for Error instances, undefined otherwise", () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.string().map((s) => new Error(s)),
					fc.string(),
					fc.integer(),
					fc.constant(null),
					fc.object(),
				),
				(value) => {
					const out = getErrorStack(value);
					if (value instanceof Error) {
						return typeof out === "string" || out === undefined;
					}
					return out === undefined;
				},
			),
			{ numRuns: 200 },
		);
	});
});

describe("formatErrorForLog property tests", () => {
	test("always contains the extracted message", () => {
		fc.assert(
			fc.property(fc.string({ minLength: 1 }), fc.string(), (msg, prefix) => {
				const out = formatErrorForLog(new Error(msg), prefix);
				return out.includes(msg);
			}),
			{ numRuns: 200 },
		);
	});

	test("prefix appears at the head when supplied", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 1 }).filter((s) => !s.includes("\n")),
				fc.string({ minLength: 1 }),
				(prefix, msg) => {
					const out = formatErrorForLog(msg, prefix);
					return out.startsWith(`${prefix}: ${msg}`);
				},
			),
			{ numRuns: 200 },
		);
	});

	test("ApplicationError context is rendered as a JSON block when present", () => {
		fc.assert(
			fc.property(
				fc.string(),
				contextArb.filter((c) => Object.keys(c).length > 0),
				(msg, ctx) => {
					const err = new ApplicationError(msg, ctx);
					const out = formatErrorForLog(err);
					return (
						out.includes("Context:") &&
						out.includes(JSON.stringify(ctx, null, 2))
					);
				},
			),
			{ numRuns: 200 },
		);
	});
});
