/**
 * Apple Intelligence adapter tests — fully Windows-compatible.
 *
 * These tests EXERCISE the JSON stdin/stdout contract, the error
 * classification, and the platform-gating predicate by INJECTING a
 * mocked `spawn` function — the real Swift CLI is never invoked. This
 * lets the suite run on the same Windows dev box that ships the
 * production app; the Swift compile (`tools/apple-intelligence-cli/build.sh`)
 * is gated to Darwin and validated only by a macOS build job.
 */
import { describe, expect, mock, test } from "bun:test";
import { debugLogMock } from "@test/mocks/debug-log";

// Stub debug-log before importing the module under test so the require()
// graph never tries to instantiate electron-log on the test runner.
mock.module("../lib/debug-log", () => debugLogMock());

const {
	AppleIntelligenceError,
	callAppleIntelligenceCli,
	getAppleIntelligencePlatformState,
	isAppleIntelligenceSupported,
	parseAppleLlmCliStdout,
	resolveAppleLlmBinaryPath,
} = await import("./apple-intelligence");

// ── parseAppleLlmCliStdout ────────────────────────────────────────────

describe("parseAppleLlmCliStdout", () => {
	test("decodes a success envelope verbatim", () => {
		expect(parseAppleLlmCliStdout('{"ok":true,"text":"hello"}\n')).toEqual({
			ok: true,
			text: "hello",
		});
	});

	test("decodes a failure envelope verbatim", () => {
		expect(parseAppleLlmCliStdout('{"ok":false,"error":"model not available"}\n')).toEqual({
			ok: false,
			error: "model not available",
		});
	});

	test("returns null on empty input", () => {
		expect(parseAppleLlmCliStdout("")).toBeNull();
		expect(parseAppleLlmCliStdout("   \n")).toBeNull();
	});

	test("returns null on malformed JSON", () => {
		expect(parseAppleLlmCliStdout("{not json")).toBeNull();
	});

	test("returns null when the envelope is wrong shape", () => {
		// Missing required fields per the contract — { ok:true, text } or
		// { ok:false, error }. Anything else is treated as a protocol error.
		expect(parseAppleLlmCliStdout('{"ok":true}')).toBeNull();
		expect(parseAppleLlmCliStdout('{"text":"hello"}')).toBeNull();
		expect(parseAppleLlmCliStdout('{"ok":false}')).toBeNull();
		expect(parseAppleLlmCliStdout("null")).toBeNull();
	});

	test("tolerates leading whitespace and trailing newlines", () => {
		expect(parseAppleLlmCliStdout('\n\t{"ok":true,"text":"x"}\n\n')).toEqual({
			ok: true,
			text: "x",
		});
	});
});

// ── Platform predicates ────────────────────────────────────────────────

describe("isAppleIntelligenceSupported", () => {
	test("returns false on Windows (this test always runs on Windows CI)", () => {
		// On the Windows dev box this is the load-bearing assertion: the
		// predicate must short-circuit before any binary lookup happens.
		// On Darwin arm64 hosts this would be `true`; we don't override
		// process.platform here because doing so leaks across the suite.
		if (process.platform !== "darwin" || process.arch !== "arm64") {
			expect(isAppleIntelligenceSupported()).toBe(false);
		} else {
			expect(isAppleIntelligenceSupported()).toBe(true);
		}
	});
});

describe("getAppleIntelligencePlatformState", () => {
	test("returns 'non-darwin' on non-mac hosts (Windows/Linux CI)", () => {
		if (process.platform === "win32" || process.platform === "linux") {
			expect(getAppleIntelligencePlatformState()).toBe("non-darwin");
		}
	});

	test("returns one of the three platform buckets", () => {
		const state = getAppleIntelligencePlatformState();
		expect(["supported", "intel-mac", "non-darwin"]).toContain(state);
	});
});

// ── resolveAppleLlmBinaryPath ──────────────────────────────────────────

describe("resolveAppleLlmBinaryPath", () => {
	test("returns an absolute path with macos/winstt-apple-llm suffix", () => {
		const resolved = resolveAppleLlmBinaryPath();
		// Path separators differ across platforms — assert on a normalised
		// form so the test runs uniformly on Windows + Darwin.
		const normalised = resolved.replaceAll("\\", "/");
		expect(normalised.endsWith("macos/winstt-apple-llm")).toBe(true);
	});
});

// ── callAppleIntelligenceCli — platform gate ──────────────────────────

describe("callAppleIntelligenceCli — platform gating", () => {
	test("rejects with unsupported-platform on non-darwin hosts", async () => {
		if (isAppleIntelligenceSupported()) {
			// We can't directly test this branch on a Darwin arm64 box
			// without messing with process.platform; on Windows CI the
			// assertion runs naturally.
			return;
		}
		let caught: unknown;
		try {
			await callAppleIntelligenceCli({ system: "", user: "" });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(AppleIntelligenceError);
		expect((caught as InstanceType<typeof AppleIntelligenceError>).reason).toBe(
			"unsupported-platform"
		);
	});
});

// ── callAppleIntelligenceCli — happy path with injected mock spawn ────
//
// The real `spawn` is replaced with a tiny fake that:
//   1. Captures the JSON written to stdin so we assert the request
//      envelope shape matches what the Swift CLI expects.
//   2. Writes back a canned stdout envelope and closes with code 0.
// This validates the adapter wiring end-to-end without touching disk.

interface FakeChild {
	on(event: string, listener: (...args: unknown[]) => void): FakeChild;
	stderr: { on(_: string, __: (chunk: string) => void): void; setEncoding(_: string): void };
	stdin: { end(chunk: string): void };
	stdout: { on(_: string, listener: (chunk: string) => void): void; setEncoding(_: string): void };
}

function makeFakeSpawn(opts: {
	stdoutChunks?: string[];
	stderrChunks?: string[];
	closeCode?: number | null;
	emitError?: Error;
	captureStdin?: (payload: string) => void;
}): { spawnFn: unknown; capturedStdin: { value: string } } {
	const captured = { value: "" };
	const spawnFn = (() => {
		const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
		const stdoutListeners: ((chunk: string) => void)[] = [];
		const child: FakeChild = {
			on(event, listener) {
				const bucket = handlers[event] ?? [];
				bucket.push(listener);
				handlers[event] = bucket;
				return child;
			},
			stdout: {
				setEncoding: () => undefined,
				on(_event, listener) {
					stdoutListeners.push(listener);
				},
			},
			stderr: {
				setEncoding: () => undefined,
				on(_event, listener) {
					// Replay stderr immediately when registered so the
					// finalize path has the chunks ready.
					for (const chunk of opts.stderrChunks ?? []) {
						listener(chunk);
					}
				},
			},
			stdin: {
				end(payload: string) {
					captured.value = payload;
					opts.captureStdin?.(payload);
					// Schedule the stdout chunks and the close event on a
					// microtask so the consumer has time to register
					// listeners (matching real child_process semantics).
					queueMicrotask(() => {
						if (opts.emitError) {
							for (const h of handlers.error ?? []) {
								h(opts.emitError);
							}
							return;
						}
						for (const chunk of opts.stdoutChunks ?? []) {
							for (const l of stdoutListeners) {
								l(chunk);
							}
						}
						for (const h of handlers.close ?? []) {
							h(opts.closeCode ?? 0);
						}
					});
				},
			},
		};
		return child;
	}) as unknown;
	return { spawnFn, capturedStdin: captured };
}

describe("callAppleIntelligenceCli — injected spawn", () => {
	test("rejects on non-darwin host even when a spawn mock is supplied", async () => {
		// Platform gate fires FIRST — the spawn mock must not be reached on
		// Windows/Linux. This is what the production code relies on to keep
		// the binary missing from the build (it doesn't exist on Windows).
		if (isAppleIntelligenceSupported()) {
			return;
		}
		const { spawnFn } = makeFakeSpawn({
			stdoutChunks: ['{"ok":true,"text":"never reached"}\n'],
		});
		let caught: unknown;
		try {
			await callAppleIntelligenceCli(
				{ system: "s", user: "u", tokenLimit: 12 },
				{ spawnFn: spawnFn as never }
			);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(AppleIntelligenceError);
		expect((caught as InstanceType<typeof AppleIntelligenceError>).reason).toBe(
			"unsupported-platform"
		);
	});
});

// ── parseAppleLlmCliStdout contract (the wire format the Swift CLI must honor) ──
//
// These tests double as the executable spec for the Swift CLI. If the
// Swift file at tools/apple-intelligence-cli/main.swift ever drifts from
// the JSON shape below, the integration on macOS will break — these
// assertions document the contract verbatim.

describe("CLI wire-format contract (spec for Swift main.swift)", () => {
	test("a valid success envelope has ok:true and a text string", () => {
		const env = { ok: true as const, text: "cleaned text" };
		expect(parseAppleLlmCliStdout(JSON.stringify(env))).toEqual(env);
	});

	test("a valid failure envelope has ok:false and an error string", () => {
		const env = {
			ok: false as const,
			error: "Apple Intelligence is not currently available on this device.",
		};
		expect(parseAppleLlmCliStdout(JSON.stringify(env))).toEqual(env);
	});

	test("mixing both shapes (ok:true + error) does not parse — the Swift CLI must pick one", () => {
		expect(parseAppleLlmCliStdout('{"ok":true,"error":"oops"}')).toBeNull();
	});

	test("extra fields in the envelope are tolerated (forward-compat)", () => {
		// Future versions of the Swift CLI may add fields (timing, model id,
		// usage stats). The Node-side parser must accept them so adding a
		// field in Swift doesn't break old Electron installs.
		const parsed = parseAppleLlmCliStdout(
			'{"ok":true,"text":"hello","timingMs":123,"modelId":"sysmodel"}'
		);
		expect(parsed).toMatchObject({ ok: true, text: "hello" });
	});

	// ── isCliResponse exhaustive shape rejections ─────────────────────────
	// isCliResponse (CC=7) is the validator the parser delegates to. Each
	// rejection below pins a distinct guard branch so a regression that
	// loosens the type check (e.g. accepting a numeric `ok`, a non-string
	// `text`, or a non-object payload) is caught.

	test("rejects a numeric `ok` (must be the boolean literal true/false)", () => {
		// `ok:1` is truthy but `=== true` is false AND `=== false` is false,
		// so neither success nor failure branch of isCliResponse matches.
		expect(parseAppleLlmCliStdout('{"ok":1,"text":"hi"}')).toBeNull();
		expect(parseAppleLlmCliStdout('{"ok":0,"error":"boom"}')).toBeNull();
	});

	test("rejects ok:true with a non-string `text` (number)", () => {
		expect(parseAppleLlmCliStdout('{"ok":true,"text":42}')).toBeNull();
	});

	test("rejects ok:false with a non-string `error` (object)", () => {
		expect(parseAppleLlmCliStdout('{"ok":false,"error":{"nested":true}}')).toBeNull();
	});

	test("rejects a JSON primitive that is not an object (string, number, array)", () => {
		// `typeof value !== "object"` guard — a bare JSON string, number, or
		// `true` literal must not be mistaken for an envelope.
		expect(parseAppleLlmCliStdout('"just a string"')).toBeNull();
		expect(parseAppleLlmCliStdout("123")).toBeNull();
		expect(parseAppleLlmCliStdout("true")).toBeNull();
		// Arrays are typeof "object" but lack ok/text/error → still rejected.
		expect(parseAppleLlmCliStdout('["a","b"]')).toBeNull();
	});
});

// ── Forcing the Darwin+arm64 subprocess path ──────────────────────────
//
// On the Windows dev box `isAppleIntelligenceSupported()` is false, so the
// platform gate in `callAppleIntelligenceCli` short-circuits and the whole
// child-process pipeline (`runAppleLlmChild` → `finalizeAppleLlmChild` →
// `buildProtocolErrorMessage` → `stringifyError`) is never reached. To
// exercise those functions we temporarily override `process.platform` and
// `process.arch` so the gate passes, drive the injected fake spawn, and
// always restore the originals in a `finally`.

const originalPlatform = process.platform;
const originalArch = process.arch;

function forceAppleSilicon(): void {
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
	Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
}

function restorePlatform(): void {
	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
	Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
}

describe("callAppleIntelligenceCli — full subprocess path (forced Apple Silicon)", () => {
	test("resolves with parsed.text on a clean ok:true envelope + exit 0", async () => {
		forceAppleSilicon();
		try {
			expect(isAppleIntelligenceSupported()).toBe(true);
			const { spawnFn, capturedStdin } = makeFakeSpawn({
				stdoutChunks: ['{"ok":true,"text":"cleaned output"}\n'],
				closeCode: 0,
			});
			const text = await callAppleIntelligenceCli(
				{ system: "be terse", user: "hello there", tokenLimit: 42 },
				{ spawnFn: spawnFn as never, binaryPath: "/fake/winstt-apple-llm" }
			);
			expect(text).toBe("cleaned output");
			// The stdin payload must carry the exact contract keys the Swift CLI reads.
			expect(JSON.parse(capturedStdin.value)).toEqual({
				system: "be terse",
				user: "hello there",
				tokenLimit: 42,
			});
		} finally {
			restorePlatform();
		}
	});

	test("defaults tokenLimit to 0 when the request omits it", async () => {
		forceAppleSilicon();
		try {
			const { spawnFn, capturedStdin } = makeFakeSpawn({
				stdoutChunks: ['{"ok":true,"text":"x"}\n'],
			});
			await callAppleIntelligenceCli(
				{ system: "s", user: "u" },
				{ spawnFn: spawnFn as never, binaryPath: "/fake/bin" }
			);
			expect(JSON.parse(capturedStdin.value).tokenLimit).toBe(0);
		} finally {
			restorePlatform();
		}
	});

	test("classifies ok:false 'not currently available' as model-unavailable", async () => {
		forceAppleSilicon();
		try {
			const { spawnFn } = makeFakeSpawn({
				stdoutChunks: [
					'{"ok":false,"error":"Apple Intelligence is not currently available on this device."}\n',
				],
				closeCode: 0,
			});
			let caught: unknown;
			try {
				await callAppleIntelligenceCli(
					{ system: "s", user: "u" },
					{ spawnFn: spawnFn as never, binaryPath: "/fake/bin" }
				);
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(AppleIntelligenceError);
			const e = caught as InstanceType<typeof AppleIntelligenceError>;
			expect(e.reason).toBe("model-unavailable");
			expect(e.message).toContain("not currently available");
		} finally {
			restorePlatform();
		}
	});

	test("classifies a generic ok:false envelope as exited-with-error", async () => {
		forceAppleSilicon();
		try {
			const { spawnFn } = makeFakeSpawn({
				stdoutChunks: ['{"ok":false,"error":"decode failure in sandbox"}\n'],
				closeCode: 0,
			});
			let caught: unknown;
			try {
				await callAppleIntelligenceCli(
					{ system: "s", user: "u" },
					{ spawnFn: spawnFn as never, binaryPath: "/fake/bin" }
				);
			} catch (err) {
				caught = err;
			}
			const e = caught as InstanceType<typeof AppleIntelligenceError>;
			expect(e.reason).toBe("exited-with-error");
			expect(e.message).toBe("decode failure in sandbox");
		} finally {
			restorePlatform();
		}
	});

	test("matches 'not currently available' case-insensitively (mixed case)", async () => {
		// finalizeAppleLlmChild lower-cases before matching, so a CLI that
		// title-cases its error string ("Not Currently Available") must still
		// classify as model-unavailable. Locks the `.toLowerCase()` call.
		forceAppleSilicon();
		try {
			const { spawnFn } = makeFakeSpawn({
				stdoutChunks: ['{"ok":false,"error":"Model Is NOT CURRENTLY AVAILABLE right now"}\n'],
				closeCode: 0,
			});
			let caught: unknown;
			try {
				await callAppleIntelligenceCli(
					{ system: "s", user: "u" },
					{ spawnFn: spawnFn as never, binaryPath: "/fake/bin" }
				);
			} catch (err) {
				caught = err;
			}
			const e = caught as InstanceType<typeof AppleIntelligenceError>;
			expect(e.reason).toBe("model-unavailable");
		} finally {
			restorePlatform();
		}
	});

	test("an empty-string ok:false error classifies as exited-with-error (not model-unavailable)", async () => {
		// Edge of the substring match: an empty error string does NOT contain
		// "not currently available", so the generic branch wins and the
		// rejected error message is the empty string verbatim.
		forceAppleSilicon();
		try {
			const { spawnFn } = makeFakeSpawn({
				stdoutChunks: ['{"ok":false,"error":""}\n'],
				closeCode: 0,
			});
			let caught: unknown;
			try {
				await callAppleIntelligenceCli(
					{ system: "s", user: "u" },
					{ spawnFn: spawnFn as never, binaryPath: "/fake/bin" }
				);
			} catch (err) {
				caught = err;
			}
			const e = caught as InstanceType<typeof AppleIntelligenceError>;
			expect(e.reason).toBe("exited-with-error");
			expect(e.message).toBe("");
		} finally {
			restorePlatform();
		}
	});

	test("protocol-error with only stdout (no stderr) omits the stderr section", async () => {
		// buildProtocolErrorMessage appends `stderr:` only when stderr.trim()
		// is non-empty. With unparseable stdout + empty stderr + exit 0, the
		// message has the stdout section but NOT the stderr section — pins the
		// independent `if (stderr.trim())` / `if (stdout.trim())` branches.
		forceAppleSilicon();
		try {
			const { spawnFn } = makeFakeSpawn({
				stdoutChunks: ["partial-not-json"],
				stderrChunks: [],
				closeCode: 0,
			});
			let caught: unknown;
			try {
				await callAppleIntelligenceCli(
					{ system: "s", user: "u" },
					{ spawnFn: spawnFn as never, binaryPath: "/fake/bin" }
				);
			} catch (err) {
				caught = err;
			}
			const e = caught as InstanceType<typeof AppleIntelligenceError>;
			expect(e.reason).toBe("protocol-error");
			expect(e.message).toContain("exit 0");
			expect(e.message).toContain("stdout: partial-not-json");
			expect(e.message).not.toContain("stderr:");
		} finally {
			restorePlatform();
		}
	});

	test("rejects protocol-error when stdout is unparseable but exit is 0", async () => {
		forceAppleSilicon();
		try {
			const { spawnFn } = makeFakeSpawn({
				stdoutChunks: ["this is not json\n"],
				stderrChunks: ["swift backtrace noise"],
				closeCode: 0,
			});
			let caught: unknown;
			try {
				await callAppleIntelligenceCli(
					{ system: "s", user: "u" },
					{ spawnFn: spawnFn as never, binaryPath: "/fake/bin" }
				);
			} catch (err) {
				caught = err;
			}
			const e = caught as InstanceType<typeof AppleIntelligenceError>;
			expect(e.reason).toBe("protocol-error");
			// buildProtocolErrorMessage stitches exit code + stderr + stdout.
			expect(e.message).toContain("exit 0");
			expect(e.message).toContain("stderr: swift backtrace noise");
			expect(e.message).toContain("stdout: this is not json");
		} finally {
			restorePlatform();
		}
	});

	test("rejects non-zero-exit when stdout is unparseable and exit is non-zero", async () => {
		forceAppleSilicon();
		try {
			const { spawnFn } = makeFakeSpawn({
				stdoutChunks: [""],
				stderrChunks: [],
				closeCode: 73,
			});
			let caught: unknown;
			try {
				await callAppleIntelligenceCli(
					{ system: "s", user: "u" },
					{ spawnFn: spawnFn as never, binaryPath: "/fake/bin" }
				);
			} catch (err) {
				caught = err;
			}
			const e = caught as InstanceType<typeof AppleIntelligenceError>;
			expect(e.reason).toBe("non-zero-exit");
			expect(e.message).toContain("exit 73");
			// No stderr/stdout sections when both are empty/blank.
			expect(e.message).not.toContain("stderr:");
			expect(e.message).not.toContain("stdout:");
		} finally {
			restorePlatform();
		}
	});

	test("renders 'null' for the exit code when close reports null", async () => {
		forceAppleSilicon();
		try {
			// makeFakeSpawn coerces `closeCode ?? 0`, so a literal null can't pass
			// through it. Hand-roll a spawn that emits `close` with null directly,
			// exercising both the `code === 0 ? … : "non-zero-exit"` branch (null
			// is not 0) AND the `code ?? "null"` rendering in buildProtocolErrorMessage.
			const spawnFn = (() => {
				const handlers: Record<string, ((arg: unknown) => void)[]> = {};
				const child: Record<string, unknown> = {
					on(event: string, listener: (arg: unknown) => void) {
						const bucket = handlers[event] ?? [];
						bucket.push(listener);
						handlers[event] = bucket;
						return child;
					},
					stdout: {
						setEncoding: () => undefined,
						on: (_e: string, l: (chunk: string) => void) => l("garbage"),
					},
					stderr: { setEncoding: () => undefined, on: () => undefined },
					stdin: {
						end: () => {
							queueMicrotask(() => {
								for (const h of handlers.close ?? []) {
									h(null);
								}
							});
						},
					},
				};
				return child;
			}) as never;
			let caught: unknown;
			try {
				await callAppleIntelligenceCli(
					{ system: "s", user: "u" },
					{ spawnFn, binaryPath: "/fake/bin" }
				);
			} catch (err) {
				caught = err;
			}
			const e = caught as InstanceType<typeof AppleIntelligenceError>;
			// code === null is NOT 0, so non-zero-exit is chosen.
			expect(e.reason).toBe("non-zero-exit");
			expect(e.message).toContain("exit null");
		} finally {
			restorePlatform();
		}
	});

	test("maps a spawn 'error' event with ENOENT to binary-missing", async () => {
		forceAppleSilicon();
		try {
			const { spawnFn } = makeFakeSpawn({
				emitError: new Error("spawn /fake/bin ENOENT"),
			});
			let caught: unknown;
			try {
				await callAppleIntelligenceCli(
					{ system: "s", user: "u" },
					{ spawnFn: spawnFn as never, binaryPath: "/fake/bin" }
				);
			} catch (err) {
				caught = err;
			}
			const e = caught as InstanceType<typeof AppleIntelligenceError>;
			expect(e.reason).toBe("binary-missing");
			expect(e.message).toContain("ENOENT");
		} finally {
			restorePlatform();
		}
	});

	test("maps a non-ENOENT 'error' event to spawn-failed", async () => {
		forceAppleSilicon();
		try {
			const { spawnFn } = makeFakeSpawn({
				emitError: new Error("EACCES permission denied"),
			});
			let caught: unknown;
			try {
				await callAppleIntelligenceCli(
					{ system: "s", user: "u" },
					{ spawnFn: spawnFn as never, binaryPath: "/fake/bin" }
				);
			} catch (err) {
				caught = err;
			}
			const e = caught as InstanceType<typeof AppleIntelligenceError>;
			expect(e.reason).toBe("spawn-failed");
			expect(e.message).toContain("EACCES");
		} finally {
			restorePlatform();
		}
	});

	test("rejects spawn-failed when spawnFn itself throws synchronously (Error)", async () => {
		forceAppleSilicon();
		try {
			const throwingSpawn = (() => {
				throw new Error("spawn EMFILE too many open files");
			}) as never;
			let caught: unknown;
			try {
				await callAppleIntelligenceCli(
					{ system: "s", user: "u" },
					{ spawnFn: throwingSpawn, binaryPath: "/fake/winstt-apple-llm" }
				);
			} catch (err) {
				caught = err;
			}
			const e = caught as InstanceType<typeof AppleIntelligenceError>;
			expect(e.reason).toBe("spawn-failed");
			// Message carries the binary path AND the stringified error (Error → .message).
			expect(e.message).toContain("/fake/winstt-apple-llm");
			expect(e.message).toContain("EMFILE");
		} finally {
			restorePlatform();
		}
	});

	test("stringifyError falls back to String() for a non-Error throw value", async () => {
		forceAppleSilicon();
		try {
			const throwingSpawn = (() => {
				// biome-ignore lint/style/useThrowOnlyError: exercising the non-Error branch of stringifyError
				throw "raw string failure";
			}) as never;
			let caught: unknown;
			try {
				await callAppleIntelligenceCli(
					{ system: "s", user: "u" },
					{ spawnFn: throwingSpawn, binaryPath: "/fake/bin" }
				);
			} catch (err) {
				caught = err;
			}
			const e = caught as InstanceType<typeof AppleIntelligenceError>;
			expect(e.reason).toBe("spawn-failed");
			expect(e.message).toContain("raw string failure");
		} finally {
			restorePlatform();
		}
	});

	test("rejects spawn-failed when stdin.end() throws (stdin write failure)", async () => {
		forceAppleSilicon();
		try {
			// A spawn whose child.stdin.end throws synchronously — exercises the
			// try/catch around `child.stdin?.end(payload)`.
			const spawnFn = (() => {
				const child: Record<string, unknown> = {
					on: () => child,
					kill: () => undefined,
					stdout: { setEncoding: () => undefined, on: () => undefined },
					stderr: { setEncoding: () => undefined, on: () => undefined },
					stdin: {
						end: () => {
							throw new Error("EPIPE broken pipe");
						},
					},
				};
				return child;
			}) as never;
			let caught: unknown;
			try {
				await callAppleIntelligenceCli(
					{ system: "s", user: "u" },
					{ spawnFn, binaryPath: "/fake/bin" }
				);
			} catch (err) {
				caught = err;
			}
			const e = caught as InstanceType<typeof AppleIntelligenceError>;
			expect(e.reason).toBe("spawn-failed");
			expect(e.message).toContain("stdin");
			expect(e.message).toContain("EPIPE");
		} finally {
			restorePlatform();
		}
	});

	// ── Bug 1: stdin write failure must KILL the leaked child ─────────────
	test("kills the child when stdin.end() throws (no leaked subprocess on EPIPE)", async () => {
		forceAppleSilicon();
		try {
			let killed = false;
			const spawnFn = (() => {
				const child: Record<string, unknown> = {
					on: () => child,
					kill: () => {
						killed = true;
						return true;
					},
					stdout: { setEncoding: () => undefined, on: () => undefined },
					stderr: { setEncoding: () => undefined, on: () => undefined },
					stdin: {
						end: () => {
							throw new Error("EPIPE broken pipe");
						},
					},
				};
				return child;
			}) as never;
			let caught: unknown;
			try {
				await callAppleIntelligenceCli(
					{ system: "s", user: "u" },
					{ spawnFn, binaryPath: "/fake/bin" }
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as InstanceType<typeof AppleIntelligenceError>).reason).toBe("spawn-failed");
			// The fix: the child must be killed so the subprocess isn't leaked.
			expect(killed).toBe(true);
		} finally {
			restorePlatform();
		}
	});

	// ── Bug 2: overall hang watchdog ──────────────────────────────────────
	test("kills the child and rejects when the CLI never closes (hang watchdog)", async () => {
		forceAppleSilicon();
		const originalSetTimeout = globalThis.setTimeout;
		// Holder object (not a bare `let`): a variable assigned only inside the
		// setTimeout callback gets narrowed back to `null` by TS control-flow,
		// making `cb?.()` resolve to `never`. A property assignment is exempt.
		const watchdog: { cb: (() => void) | null } = { cb: null };
		// Capture the watchdog callback instead of waiting the real 30s.
		globalThis.setTimeout = ((cb: () => void) => {
			watchdog.cb = cb;
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as unknown as typeof globalThis.setTimeout;
		try {
			let killed = false;
			// A child that accepts stdin but NEVER emits `close` or `error` —
			// the classic hung on-device query. Without the watchdog the
			// promise would hang forever.
			const spawnFn = (() => {
				const child: Record<string, unknown> = {
					on: () => child,
					kill: () => {
						killed = true;
						return true;
					},
					stdout: { setEncoding: () => undefined, on: () => undefined },
					stderr: { setEncoding: () => undefined, on: () => undefined },
					stdin: { end: () => undefined },
				};
				return child;
			}) as never;
			const promise = callAppleIntelligenceCli(
				{ system: "s", user: "u" },
				{ spawnFn, binaryPath: "/fake/bin" }
			);
			let caught: unknown;
			const guarded = promise.catch((err: unknown) => {
				caught = err;
			});
			// Fire the captured watchdog — simulates the timeout elapsing.
			expect(watchdog.cb).not.toBeNull();
			watchdog.cb?.();
			await guarded;
			expect(killed).toBe(true);
			const e = caught as InstanceType<typeof AppleIntelligenceError>;
			expect(e.reason).toBe("spawn-failed");
			expect(e.message).toContain("did not respond");
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			restorePlatform();
		}
	});

	// ── Bug 3: double-settle guard ────────────────────────────────────────
	test("settles exactly once when the child emits BOTH error and close", async () => {
		forceAppleSilicon();
		try {
			let resolveCount = 0;
			let rejectCount = 0;
			// A spawn that fires `error` (ENOENT) AND THEN `close` with a clean
			// ok:true envelope. The pre-fix code would reject (error) and then
			// resolve (close) the same promise; with the `settled` guard only the
			// first outcome — the rejection — sticks.
			const spawnFn = (() => {
				const handlers: Record<string, ((arg: unknown) => void)[]> = {};
				const stdoutListeners: ((chunk: string) => void)[] = [];
				const child: Record<string, unknown> = {
					on(event: string, listener: (arg: unknown) => void) {
						const bucket = handlers[event] ?? [];
						bucket.push(listener);
						handlers[event] = bucket;
						return child;
					},
					kill: () => true,
					stdout: {
						setEncoding: () => undefined,
						on: (_e: string, l: (chunk: string) => void) => stdoutListeners.push(l),
					},
					stderr: { setEncoding: () => undefined, on: () => undefined },
					stdin: {
						end: () => {
							queueMicrotask(() => {
								// 1) error event fires first → reject
								for (const h of handlers.error ?? []) {
									h(new Error("spawn /fake/bin ENOENT"));
								}
								// 2) close event fires second with a valid envelope → would resolve
								for (const l of stdoutListeners) {
									l('{"ok":true,"text":"late success"}\n');
								}
								for (const h of handlers.close ?? []) {
									h(0);
								}
							});
						},
					},
				};
				return child;
			}) as never;
			let caught: unknown;
			let resolvedText: string | null = null;
			try {
				resolvedText = await callAppleIntelligenceCli(
					{ system: "s", user: "u" },
					{ spawnFn, binaryPath: "/fake/bin" }
				);
				resolveCount++;
			} catch (err) {
				caught = err;
				rejectCount++;
			}
			// The first outcome (error → reject) wins; the later close is a no-op.
			expect(rejectCount).toBe(1);
			expect(resolveCount).toBe(0);
			expect(resolvedText).toBeNull();
			expect((caught as InstanceType<typeof AppleIntelligenceError>).reason).toBe("binary-missing");
		} finally {
			restorePlatform();
		}
	});
});

// ── resolveAppleLlmBinaryPath — dev fallback branch ───────────────────

describe("resolveAppleLlmBinaryPath — resourcesPath branches", () => {
	const proc = process as NodeJS.Process & { resourcesPath?: string };
	const originalResourcesPath = proc.resourcesPath;

	test("uses process.resourcesPath when it is a non-empty string", () => {
		Object.defineProperty(process, "resourcesPath", {
			value: "/Applications/WinSTT.app/Contents/Resources",
			configurable: true,
		});
		try {
			const resolved = resolveAppleLlmBinaryPath().replaceAll("\\", "/");
			expect(resolved).toContain("/Applications/WinSTT.app/Contents/Resources");
			expect(resolved.endsWith("macos/winstt-apple-llm")).toBe(true);
		} finally {
			Object.defineProperty(process, "resourcesPath", {
				value: originalResourcesPath,
				configurable: true,
			});
		}
	});

	test("falls back to the repo-relative path when resourcesPath is undefined", () => {
		// Remove resourcesPath entirely (Bun's runner leaves it undefined) — the
		// dev fallback resolves relative to import.meta.dirname.
		Object.defineProperty(process, "resourcesPath", { value: undefined, configurable: true });
		try {
			const resolved = resolveAppleLlmBinaryPath().replaceAll("\\", "/");
			expect(resolved.endsWith("macos/winstt-apple-llm")).toBe(true);
			// The fallback walks ../resources/macos relative to electron/ipc.
			expect(resolved).toContain("resources/macos/winstt-apple-llm");
		} finally {
			Object.defineProperty(process, "resourcesPath", {
				value: originalResourcesPath,
				configurable: true,
			});
		}
	});
});
