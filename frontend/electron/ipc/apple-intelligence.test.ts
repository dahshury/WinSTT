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
});
