import { describe, expect, test } from "bun:test";
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
	retryAsync,
	TimeoutError,
	ValidationError,
	wrapAsync,
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

describe("ValidationError", () => {
	test("subclass with name reflecting class", () => {
		const err = new ValidationError("invalid", "email");
		expect(err.name).toBe("ValidationError");
		expect(err).toBeInstanceOf(ApplicationError);
		expect(err.field).toBe("email");
	});

	test("toJSON merges parent fields with field", () => {
		const err = new ValidationError("invalid", "email", { value: "" });
		const json = err.toJSON();
		expect(json["message"]).toBe("invalid");
		expect(json["field"]).toBe("email");
		expect(json["context"]).toEqual({ value: "" });
	});

	test("field is optional", () => {
		const err = new ValidationError("invalid");
		expect(err.field).toBeUndefined();
	});
});

describe("NotFoundError", () => {
	test("formats message with identifier", () => {
		const err = new NotFoundError("User", 42);
		expect(err.message).toBe('User with identifier "42" not found');
		expect(err.resource).toBe("User");
		expect(err.identifier).toBe(42);
	});

	test("formats message without identifier", () => {
		const err = new NotFoundError("User");
		expect(err.message).toBe("User not found");
		expect(err.identifier).toBeUndefined();
	});

	test("toJSON includes resource and identifier", () => {
		const err = new NotFoundError("User", "abc");
		const json = err.toJSON();
		expect(json["resource"]).toBe("User");
		expect(json["identifier"]).toBe("abc");
	});
});

describe("ConnectionError", () => {
	test("retryable defaults to true", () => {
		const err = new ConnectionError("offline");
		expect(err.retryable).toBe(true);
	});

	test("retryable can be set to false", () => {
		const err = new ConnectionError("offline", "ws://server", false);
		expect(err.retryable).toBe(false);
		expect(err.endpoint).toBe("ws://server");
	});

	test("toJSON includes endpoint and retryable", () => {
		const err = new ConnectionError("offline", "ws://server", false);
		const json = err.toJSON();
		expect(json["endpoint"]).toBe("ws://server");
		expect(json["retryable"]).toBe(false);
	});
});

describe("TimeoutError", () => {
	test("formats with operation name", () => {
		const err = new TimeoutError(5000, "fetch");
		expect(err.message).toBe('Operation "fetch" timed out after 5000ms');
		expect(err.timeoutMs).toBe(5000);
		expect(err.operation).toBe("fetch");
	});

	test("formats without operation", () => {
		const err = new TimeoutError(2000);
		expect(err.message).toBe("Operation timed out after 2000ms");
	});

	test("toJSON exposes timeoutMs and operation", () => {
		const json = new TimeoutError(2000, "fetch").toJSON();
		expect(json["timeoutMs"]).toBe(2000);
		expect(json["operation"]).toBe("fetch");
	});
});

describe("IpcError", () => {
	test("captures channel and operation", () => {
		const err = new IpcError("failed", "ch", "invoke");
		expect(err.channel).toBe("ch");
		expect(err.ipcOperation).toBe("invoke");
	});

	test("toJSON includes channel and ipcOperation", () => {
		const json = new IpcError("failed", "ch", "send").toJSON();
		expect(json["channel"]).toBe("ch");
		expect(json["ipcOperation"]).toBe("send");
	});
});

describe("FileSystemError", () => {
	test("captures filePath and operation", () => {
		const err = new FileSystemError("ENOENT", "/x", "read");
		expect(err.filePath).toBe("/x");
		expect(err.operation).toBe("read");
	});

	test("toJSON includes filePath and operation", () => {
		const json = new FileSystemError("ENOENT", "/x", "stat").toJSON();
		expect(json["filePath"]).toBe("/x");
		expect(json["operation"]).toBe("stat");
	});
});

describe("ProcessSpawnError", () => {
	test("captures command and exitCode", () => {
		const err = new ProcessSpawnError("crashed", "node", 137);
		expect(err.command).toBe("node");
		expect(err.exitCode).toBe(137);
	});

	test("exitCode is optional", () => {
		const err = new ProcessSpawnError("crashed", "node");
		expect(err.exitCode).toBeUndefined();
	});

	test("toJSON includes command and exitCode", () => {
		const json = new ProcessSpawnError("crashed", "node", 1).toJSON();
		expect(json["command"]).toBe("node");
		expect(json["exitCode"]).toBe(1);
	});
});

describe("isApplicationError", () => {
	test("returns true for ApplicationError instances", () => {
		expect(isApplicationError(new ApplicationError("x"))).toBe(true);
		expect(isApplicationError(new ValidationError("x"))).toBe(true);
		expect(isApplicationError(new NotFoundError("x"))).toBe(true);
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

describe("getErrorStack", () => {
	test("returns stack from Error", () => {
		const err = new Error("boom");
		expect(getErrorStack(err)).toBe(err.stack);
	});

	test("returns undefined for non-Error", () => {
		expect(getErrorStack("x")).toBeUndefined();
		expect(getErrorStack(null)).toBeUndefined();
		expect(getErrorStack({ stack: "fake" })).toBeUndefined();
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

	test("omits the stack section when getErrorStack returns undefined (non-Error input)", () => {
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

describe("retryAsync", () => {
	test("returns the value on first success", async () => {
		const result = await retryAsync(async () => 42);
		expect(result).toBe(42);
	});

	test("retries up to maxAttempts then throws last error", async () => {
		let calls = 0;
		await expect(
			retryAsync(
				async () => {
					calls += 1;
					throw new Error(`fail-${calls}`);
				},
				{ maxAttempts: 3, delayMs: 1, backoffMultiplier: 1 },
			),
		).rejects.toThrow("fail-3");
		expect(calls).toBe(3);
	});

	test("delay grows by backoffMultiplier between attempts (delay = delayMs * mult^(attempt-1))", async () => {
		const timestamps: number[] = [];
		await expect(
			retryAsync(
				async () => {
					timestamps.push(Date.now());
					throw new Error("nope");
				},
				{ maxAttempts: 3, delayMs: 50, backoffMultiplier: 3 },
			),
		).rejects.toThrow();
		expect(timestamps).toHaveLength(3);
		// Gap 1 → ~50ms (50 * 3^0), gap 2 → ~150ms (50 * 3^1).
		// timer skew on Windows can be 16ms, so assert a generous band.
		const gap1 = (timestamps[1] ?? 0) - (timestamps[0] ?? 0);
		const gap2 = (timestamps[2] ?? 0) - (timestamps[1] ?? 0);
		expect(gap1).toBeGreaterThanOrEqual(40);
		expect(gap1).toBeLessThan(120);
		// Second gap MUST be larger (this is what the mutator-killer locks in)
		expect(gap2).toBeGreaterThan(gap1 + 30);
	}, 5000);

	test("returns the result once a retry succeeds", async () => {
		let calls = 0;
		const result = await retryAsync(
			async () => {
				calls += 1;
				if (calls < 3) {
					throw new Error("not yet");
				}
				return "ok";
			},
			{ maxAttempts: 5, delayMs: 1, backoffMultiplier: 1 },
		);
		expect(result).toBe("ok");
		expect(calls).toBe(3);
	});

	test("invokes onRetry between attempts", async () => {
		const seen: number[] = [];
		await expect(
			retryAsync(
				async () => {
					throw new Error("nope");
				},
				{
					maxAttempts: 3,
					delayMs: 1,
					backoffMultiplier: 1,
					onRetry: (_, attempt) => seen.push(attempt),
				},
			),
		).rejects.toThrow("nope");
		// onRetry fires for failed attempts that will be retried (1 and 2; 3 is the final throw)
		expect(seen).toEqual([1, 2]);
	});

	test("respects shouldRetry returning false", async () => {
		let calls = 0;
		await expect(
			retryAsync(
				async () => {
					calls += 1;
					throw new Error("hard fail");
				},
				{
					maxAttempts: 5,
					delayMs: 1,
					shouldRetry: () => false,
				},
			),
		).rejects.toThrow("hard fail");
		expect(calls).toBe(1);
	});

	test("uses default options when none supplied", async () => {
		let calls = 0;
		await expect(
			retryAsync(async () => {
				calls += 1;
				throw new Error("default-failure");
			}),
		).rejects.toThrow("default-failure");
		expect(calls).toBe(3);
	}, 10_000);

	test("default backoffMultiplier=2 produces growing delays (mutator-killer for `?? 2`)", async () => {
		// delayMs=80 with default backoffMultiplier=2: gap1≈80ms, gap2≈160ms.
		// A mutant that turns `options.backoffMultiplier ?? 2` into `&& 2` makes
		// the default behavior `undefined && 2 = undefined`, leading to NaN delays
		// (treated as 0 by setTimeout). The wider margin keeps the test stable on
		// Windows where timer resolution can drift up to ~16ms.
		const timestamps: number[] = [];
		await expect(
			retryAsync(
				async () => {
					timestamps.push(Date.now());
					throw new Error("nope");
				},
				{ maxAttempts: 3, delayMs: 80 }, // backoffMultiplier omitted → uses default 2
			),
		).rejects.toThrow();
		expect(timestamps).toHaveLength(3);
		const gap1 = (timestamps[1] ?? 0) - (timestamps[0] ?? 0);
		const gap2 = (timestamps[2] ?? 0) - (timestamps[1] ?? 0);
		// gap1 ≈ 80ms; gap2 ≈ 160ms. Mutant collapses both to ~0.
		expect(gap1).toBeGreaterThanOrEqual(60);
		expect(gap2).toBeGreaterThan(gap1 + 40);
	}, 5000);
});

describe("wrapAsync", () => {
	test("returns the inner value on success", async () => {
		const wrapped = wrapAsync(async (x: number) => x * 2);
		expect(await wrapped(4)).toBe(8);
	});

	test("returns undefined and invokes errorHandler on failure", async () => {
		let captured: { error: unknown; args: unknown[] } | null = null;
		const wrapped = wrapAsync(
			async (_x: number) => {
				throw new Error("inner");
			},
			(error, args) => {
				captured = { error, args: [...args] };
			},
		);
		const originalConsoleError = console.error;
		console.error = () => {
			/* swallow */
		};
		try {
			expect(await wrapped(7)).toBeUndefined();
			expect(captured).not.toBeNull();
			expect((captured! as { error: Error }).error).toBeInstanceOf(Error);
			expect((captured! as { args: unknown[] }).args).toEqual([7]);
		} finally {
			console.error = originalConsoleError;
		}
	});

	test("works without errorHandler — still returns undefined on failure", async () => {
		const wrapped = wrapAsync(async () => {
			throw new Error("inner");
		});
		const originalConsoleError = console.error;
		console.error = () => {
			/* swallow */
		};
		try {
			expect(await wrapped()).toBeUndefined();
		} finally {
			console.error = originalConsoleError;
		}
	});

	test("logs error with the inner function's name in the prefix (mutator-killer for `Error in ${fn.name}`)", async () => {
		const captured: string[] = [];
		const originalConsoleError = console.error;
		console.error = (msg: unknown) => {
			captured.push(String(msg));
		};
		try {
			async function namedInner() {
				throw new Error("inside");
			}
			const wrapped = wrapAsync(namedInner);
			await wrapped();
			expect(captured).toHaveLength(1);
			// Format: "Error in <fn.name>: <message>\n<stack>"
			expect(captured[0]).toContain("Error in namedInner");
			expect(captured[0]).toContain("inside");
		} finally {
			console.error = originalConsoleError;
		}
	});

	test("falls back to 'async function' when the inner function is anonymous (mutator-killer for the literal)", async () => {
		const captured: string[] = [];
		const originalConsoleError = console.error;
		console.error = (msg: unknown) => {
			captured.push(String(msg));
		};
		try {
			// An anonymous arrow function — `fn.name` is empty under strict
			// declaration-only contexts. Force this with Object.defineProperty.
			const anon = async () => {
				throw new Error("anon-inner");
			};
			Object.defineProperty(anon, "name", { value: "" });
			const wrapped = wrapAsync(anon);
			await wrapped();
			expect(captured).toHaveLength(1);
			expect(captured[0]).toContain("Error in async function");
		} finally {
			console.error = originalConsoleError;
		}
	});
});
