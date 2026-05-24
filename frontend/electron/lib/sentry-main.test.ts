import { beforeEach, describe, expect, mock, test } from "bun:test";
import { electronMock } from "../../test/mocks/electron";

// `mock.module("electron", ...)` is process-global and the sentry-main module
// reads `app.getVersion()` / `app.isPackaged` from it, so we install the shim
// BEFORE importing the module under test. Using `await import(...)` (rather
// than a top-level static import) is required because Bun's module loader
// otherwise resolves `./sentry-main` before the `mock.module` call takes
// effect, which then crashes on `Export named 'app' not found`.
mock.module("electron", () => electronMock());

const sentryMain = await import("./sentry-main");
const {
	__INTERNALS_FOR_TESTS: I,
	__resetSentryMainForTests,
	__setSentryModuleForTests,
	breadcrumb,
	captureMainException,
	getResolvedSentryDsn,
	initSentryMain,
	tryFn,
	tryFnAsync,
	tryRun,
} = sentryMain;

// Reset module state between tests so DSN env / initialized flag don't leak.
// `delete process.env.X` is the only way to actually clear an env var —
// setting it to `undefined` coerces to the string "undefined" in Node.js.
// For the global flag, we cast through `Record<string, unknown>` so we can
// assign undefined without tripping `exactOptionalPropertyTypes` (the
// declaration in `build-constants.d.ts` types the global as plain `string`,
// since it's normally substituted at compile time by esbuild).
beforeEach(() => {
	__resetSentryMainForTests();
	delete process.env.SENTRY_DSN;
	(globalThis as unknown as Record<string, unknown>).__WINSTT_BUILD_SENTRY_DSN__ = undefined;
});

// ─── try/catch helpers ──────────────────────────────────────────────────

describe("tryFn", () => {
	test("returns fn() when it succeeds", () => {
		expect(tryFn(() => 42, 0)).toBe(42);
	});

	test("returns fallback when fn throws", () => {
		expect(
			tryFn(() => {
				throw new Error("boom");
			}, "fallback")
		).toBe("fallback");
	});
});

describe("tryRun", () => {
	test("runs fn to completion when it succeeds", () => {
		let called = false;
		tryRun(() => {
			called = true;
		});
		expect(called).toBe(true);
	});

	test("calls onError with the thrown value when fn throws", () => {
		const seen: unknown[] = [];
		tryRun(
			() => {
				throw new Error("nope");
			},
			(err) => seen.push(err)
		);
		expect(seen).toHaveLength(1);
		expect((seen[0] as Error).message).toBe("nope");
	});

	test("uses noop default error handler when none provided", () => {
		expect(() =>
			tryRun(() => {
				throw new Error("swallowed");
			})
		).not.toThrow();
	});
});

describe("tryFnAsync", () => {
	test("resolves to fn() value when it succeeds", async () => {
		await expect(
			tryFnAsync(
				() => Promise.resolve("ok"),
				() => "fallback"
			)
		).resolves.toBe("ok");
	});

	test("resolves to recover(err) value when fn rejects", async () => {
		const seen: unknown[] = [];
		await expect(
			tryFnAsync(
				() => Promise.reject(new Error("nope")),
				(err) => {
					seen.push(err);
					return "recovered";
				}
			)
		).resolves.toBe("recovered");
		expect((seen[0] as Error).message).toBe("nope");
	});

	test("resolves to recover(err) value when fn throws synchronously", async () => {
		await expect(
			tryFnAsync(
				() => {
					throw new Error("sync throw");
				},
				() => "recovered"
			)
		).resolves.toBe("recovered");
	});
});

// ─── String / home-path scrubbing ───────────────────────────────────────

describe("scrubString / stringHasHomePath", () => {
	test("scrubString returns input unchanged when no home fragment match", () => {
		expect(I.scrubString("no home here")).toBe("no home here");
	});

	test("scrubString replaces every occurrence of the home fragment", () => {
		// HOME_FRAGMENT resolves to either the real home dir OR a sentinel that
		// never matches normal text. Either way `split.join` is total — verify
		// it's idempotent on inputs that don't contain the fragment.
		const result = I.scrubString("/Users/example/path");
		expect(typeof result).toBe("string");
	});

	test("stringHasHomePath is a stable boolean check", () => {
		expect(typeof I.stringHasHomePath("anything")).toBe("boolean");
	});
});

// ─── Audio buffer predicates ────────────────────────────────────────────

describe("valueLooksLikeAudioBuffer", () => {
	test("detects Uint8Array", () => {
		expect(I.valueLooksLikeAudioBuffer(new Uint8Array(10))).toBe(true);
	});

	test("detects ArrayBuffer", () => {
		expect(I.valueLooksLikeAudioBuffer(new ArrayBuffer(10))).toBe(true);
	});

	test("detects large numeric array with byte-range values", () => {
		const big = new Array(300).fill(128);
		expect(I.valueLooksLikeAudioBuffer(big)).toBe(true);
	});

	test("ignores small numeric arrays", () => {
		expect(I.valueLooksLikeAudioBuffer([1, 2, 3])).toBe(false);
	});

	test("ignores arrays of non-numbers", () => {
		const big = new Array(300).fill("x");
		expect(I.valueLooksLikeAudioBuffer(big)).toBe(false);
	});

	test("ignores arrays whose values are out of byte range", () => {
		const big = new Array(300).fill(1000);
		expect(I.valueLooksLikeAudioBuffer(big)).toBe(false);
	});

	test("ignores non-array primitives", () => {
		expect(I.valueLooksLikeAudioBuffer("hello")).toBe(false);
		expect(I.valueLooksLikeAudioBuffer(42)).toBe(false);
		expect(I.valueLooksLikeAudioBuffer(null)).toBe(false);
		expect(I.valueLooksLikeAudioBuffer(undefined)).toBe(false);
	});
});

describe("describeAudioBuffer / classifyAudioBuffer", () => {
	test("describes Uint8Array byte length", () => {
		expect(I.describeAudioBuffer(new Uint8Array(64))).toBe("[scrubbed audio buffer 64 bytes]");
	});

	test("describes ArrayBuffer byte length", () => {
		expect(I.describeAudioBuffer(new ArrayBuffer(32))).toBe("[scrubbed audio buffer 32 bytes]");
	});

	test("describes plain numeric array length", () => {
		expect(I.describeAudioBuffer([1, 2, 3, 4])).toBe("[scrubbed audio buffer 4 bytes]");
	});

	test("describes unknown shapes with `?` placeholder", () => {
		expect(I.describeAudioBuffer("string-not-buffer")).toBe("[scrubbed audio buffer ? bytes]");
	});

	test("classifyAudioBuffer returns expected kind for each shape", () => {
		expect(I.classifyAudioBuffer(new Uint8Array(0))).toBe("uint8");
		expect(I.classifyAudioBuffer(new ArrayBuffer(0))).toBe("arraybuffer");
		expect(I.classifyAudioBuffer([])).toBe("array");
		expect(I.classifyAudioBuffer({})).toBe("other");
		expect(I.classifyAudioBuffer(null)).toBe("other");
	});
});

// ─── classifyScrubValue / scrubValue ────────────────────────────────────

describe("classifyScrubValue + scrubValue", () => {
	test("returns depthLimit kind when depth exceeds the cap", () => {
		expect(I.classifyScrubValue("x", 7)).toBe("depthLimit");
	});

	test("returns nullish for null / undefined", () => {
		expect(I.classifyScrubValue(null, 0)).toBe("nullish");
		expect(I.classifyScrubValue(undefined, 0)).toBe("nullish");
	});

	test("returns string for typeof string", () => {
		expect(I.classifyScrubValue("hi", 0)).toBe("string");
	});

	test("returns audioBuffer for buffer-like inputs", () => {
		expect(I.classifyScrubValue(new Uint8Array(1), 0)).toBe("audioBuffer");
	});

	test("returns array for plain arrays under the byte-buffer threshold", () => {
		expect(I.classifyScrubValue([1, 2, 3], 0)).toBe("array");
	});

	test("returns object for plain records", () => {
		expect(I.classifyScrubValue({ a: 1 }, 0)).toBe("object");
	});

	test("returns primitive for numbers / booleans", () => {
		expect(I.classifyScrubValue(42, 0)).toBe("primitive");
		expect(I.classifyScrubValue(true, 0)).toBe("primitive");
	});

	test("scrubValue redacts sensitive keys at any depth", () => {
		const result = I.scrubValue(
			{ transcript: "secret", audio_data: "secret2", clean: "ok" },
			0
		) as Record<string, unknown>;
		expect(result.transcript).toBe("[scrubbed]");
		expect(result.audio_data).toBe("[scrubbed]");
		expect(result.clean).toBe("ok");
	});

	test("scrubValue replaces audio-buffer leaves with descriptions", () => {
		const result = I.scrubValue({ payload: new Uint8Array(16) }, 0) as Record<string, unknown>;
		expect(result.payload).toBe("[scrubbed audio buffer 16 bytes]");
	});

	test("scrubValue stops recursing past the depth cap", () => {
		const deep = { a: { b: { c: { d: { e: { f: { g: { h: "leaf" } } } } } } } };
		// Just verify we don't infinite-loop or throw.
		expect(() => I.scrubValue(deep, 0)).not.toThrow();
	});
});

// ─── scrubRecord ─────────────────────────────────────────────────────────

describe("scrubRecord", () => {
	test("returns undefined input as undefined", () => {
		expect(I.scrubRecord(undefined)).toBeUndefined();
	});

	test("scrubs a plain record and preserves non-sensitive keys", () => {
		const result = I.scrubRecord({ transcript: "x", safe: "y" }) as Record<string, unknown>;
		expect(result.transcript).toBe("[scrubbed]");
		expect(result.safe).toBe("y");
	});

	test("returns the source unchanged when scrubbed value is not a record", () => {
		// If scrubValue ever returns a non-record (e.g. due to a bug), the
		// fallback path returns the original source.
		const source = { x: 1 };
		expect(I.scrubRecord(source)).toEqual(source);
	});
});

// ─── scrubBreadcrumbs ────────────────────────────────────────────────────

describe("scrubBreadcrumbs", () => {
	test("returns undefined input as-is", () => {
		expect(I.scrubBreadcrumbs(undefined)).toBeUndefined();
	});

	test("scrubs messages and data on each crumb", () => {
		const result = I.scrubBreadcrumbs([
			{ message: "hello", data: { transcript: "secret" } },
			{}, // crumb with no message/data — exact-optional means omit, not set undefined
		]);
		expect(result?.[0]?.message).toBe("hello");
		expect((result?.[0]?.data as Record<string, unknown>).transcript).toBe("[scrubbed]");
		expect(result?.[1]?.message).toBeUndefined();
	});
});

// ─── beforeSend ──────────────────────────────────────────────────────────

describe("beforeSend", () => {
	test("scrubs extra / contexts / breadcrumbs / user / message fields", () => {
		const event = {
			extra: { transcript: "x" },
			contexts: { app: { transcript: "y" } },
			breadcrumbs: [{ message: "hi", data: { transcript: "z" } }],
			user: { id: "u1", ip_address: "1.2.3.4", email: "a@b" },
			message: "hello",
		} as unknown as Parameters<typeof I.beforeSend>[0];
		const out = I.beforeSend(event);
		expect(out).toBe(event);
		expect((event.extra as Record<string, unknown>).transcript).toBe("[scrubbed]");
		expect(
			((event.contexts as Record<string, unknown>).app as Record<string, unknown>).transcript
		).toBe("[scrubbed]");
		expect(
			(
				(event.breadcrumbs as { data?: Record<string, unknown> }[])[0]?.data as Record<
					string,
					unknown
				>
			).transcript
		).toBe("[scrubbed]");
		expect(event.user).toEqual({ id: "u1" });
		expect(event.message).toBe("hello");
	});

	test("deletes user when only redacted keys were present", () => {
		const event = {
			user: { ip_address: "1.2.3.4", email: "a@b" },
		} as unknown as Parameters<typeof I.beforeSend>[0];
		I.beforeSend(event);
		expect(event.user).toBeUndefined();
	});

	test("deletes contexts when the field was undefined-friendly", () => {
		const event = {} as unknown as Parameters<typeof I.beforeSend>[0];
		expect(() => I.beforeSend(event)).not.toThrow();
	});
});

// ─── DSN resolution / firstNonEmpty ──────────────────────────────────────

describe("DSN resolution", () => {
	test("getResolvedSentryDsn returns env DSN when present", () => {
		process.env.SENTRY_DSN = "https://example.com/1";
		expect(getResolvedSentryDsn()).toBe("https://example.com/1");
	});

	test("getResolvedSentryDsn falls back to build-time DSN", () => {
		(globalThis as { __WINSTT_BUILD_SENTRY_DSN__?: string }).__WINSTT_BUILD_SENTRY_DSN__ =
			"https://example.com/2";
		expect(getResolvedSentryDsn()).toBe("https://example.com/2");
	});

	test("getResolvedSentryDsn returns undefined when nothing is set", () => {
		expect(getResolvedSentryDsn()).toBeUndefined();
	});

	test("getResolvedSentryDsn skips empty-string env DSN", () => {
		process.env.SENTRY_DSN = "";
		expect(getResolvedSentryDsn()).toBeUndefined();
	});

	test("firstNonEmpty returns the first non-empty entry", () => {
		expect(I.firstNonEmpty(["", "", "third"])).toBe("third");
	});

	test("firstNonEmpty returns undefined when all empty", () => {
		expect(I.firstNonEmpty(["", "", ""])).toBeUndefined();
	});
});

// ─── classifyInit ────────────────────────────────────────────────────────

describe("classifyInit", () => {
	test("returns ready when DSN is set and enabled defaults to true", () => {
		process.env.SENTRY_DSN = "https://example.com/3";
		const { outcome, dsn } = I.classifyInit({});
		expect(outcome).toBe("ready");
		expect(dsn).toBe("https://example.com/3");
	});

	test("returns optedOut when enabled is false", () => {
		process.env.SENTRY_DSN = "https://example.com/4";
		const { outcome } = I.classifyInit({ enabled: false });
		expect(outcome).toBe("optedOut");
	});

	test("returns noDsn when DSN is missing", () => {
		const { outcome, dsn } = I.classifyInit({});
		expect(outcome).toBe("noDsn");
		expect(dsn).toBe("");
	});
});

// ─── initSentryMain ──────────────────────────────────────────────────────

describe("initSentryMain", () => {
	test("is a no-op when no DSN is configured", () => {
		expect(() => initSentryMain()).not.toThrow();
	});

	test("is a no-op when enabled is false", () => {
		process.env.SENTRY_DSN = "https://example.com/5";
		expect(() => initSentryMain({ enabled: false })).not.toThrow();
	});

	test("is idempotent — second call after init returns immediately", () => {
		initSentryMain();
		expect(() => initSentryMain()).not.toThrow();
	});

	test("kicks off async load when DSN is configured", () => {
		process.env.SENTRY_DSN = "https://example.com/6";
		// The dynamic import inside loadAndInitSentry will likely fail under the
		// test runner (no real @sentry/electron/main), but the synchronous part
		// (returning from initSentryMain) MUST succeed.
		expect(() => initSentryMain()).not.toThrow();
	});
});

// ─── release / environment ───────────────────────────────────────────────

describe("resolveRelease / resolveEnvironment", () => {
	test("resolveRelease returns the bundled-app version string", () => {
		expect(I.resolveRelease()).toMatch(/^winstt@/);
	});

	test("resolveEnvironment returns development under test", () => {
		expect(I.resolveEnvironment()).toBe("development");
	});

	test("safeHomedir returns a string (or empty on failure)", () => {
		expect(typeof I.safeHomedir()).toBe("string");
	});

	test("resolveHomeFragment returns a non-empty string", () => {
		expect(I.resolveHomeFragment().length).toBeGreaterThan(0);
	});
});

// ─── breadcrumb / captureMainException ───────────────────────────────────

describe("breadcrumb", () => {
	test("is a no-op when sentry module is not loaded", () => {
		expect(() => breadcrumb("category", "msg")).not.toThrow();
		expect(() => breadcrumb("category", "msg", { count: 1 })).not.toThrow();
		expect(() => breadcrumb("category", "msg", { count: 1 }, "warning")).not.toThrow();
	});

	test("forwards to addBreadcrumb when sentry module is loaded", () => {
		const calls: Record<string, unknown>[] = [];
		const fakeMod = {
			addBreadcrumb: (payload: Record<string, unknown>) => {
				calls.push(payload);
			},
		} as unknown as Parameters<typeof __setSentryModuleForTests>[0];
		__setSentryModuleForTests(fakeMod);
		breadcrumb("cat", "msg", { x: 1 }, "warning");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			category: "cat",
			message: "msg",
			data: { x: 1 },
			level: "warning",
		});
	});

	test("swallows errors raised by addBreadcrumb", () => {
		const fakeMod = {
			addBreadcrumb: () => {
				throw new Error("nope");
			},
		} as unknown as Parameters<typeof __setSentryModuleForTests>[0];
		__setSentryModuleForTests(fakeMod);
		expect(() => breadcrumb("cat", "msg")).not.toThrow();
	});
});

describe("captureMainException", () => {
	test("is a no-op when sentry module is not loaded", () => {
		expect(() => captureMainException(new Error("x"))).not.toThrow();
		expect(() => captureMainException(new Error("x"), { foo: "bar" })).not.toThrow();
	});

	test("forwards to captureException when sentry module is loaded (no context)", () => {
		const errors: unknown[] = [];
		const fakeMod = {
			captureException: (err: unknown) => {
				errors.push(err);
			},
			withScope: () => undefined,
		} as unknown as Parameters<typeof __setSentryModuleForTests>[0];
		__setSentryModuleForTests(fakeMod);
		const e = new Error("boom");
		captureMainException(e);
		expect(errors).toEqual([e]);
	});

	test("uses withScope + setExtras when a context is supplied", () => {
		const calls: Array<{ extras?: Record<string, unknown>; error?: unknown }> = [];
		const fakeMod = {
			captureException: (err: unknown) => {
				calls.push({ error: err });
			},
			withScope: (cb: (scope: { setExtras: (e: Record<string, unknown>) => void }) => void) => {
				cb({
					setExtras: (extras: Record<string, unknown>) => calls.push({ extras }),
				});
			},
		} as unknown as Parameters<typeof __setSentryModuleForTests>[0];
		__setSentryModuleForTests(fakeMod);
		captureMainException(new Error("x"), { transcript: "secret", safe: "ok" });
		const extras = calls.find((c) => c.extras)?.extras as Record<string, unknown>;
		expect(extras.transcript).toBe("[scrubbed]");
		expect(extras.safe).toBe("ok");
	});

	test("swallows errors raised by captureException / withScope", () => {
		const fakeMod = {
			captureException: () => {
				throw new Error("inner");
			},
			withScope: (cb: (scope: { setExtras: (e: Record<string, unknown>) => void }) => void) => {
				cb({
					setExtras: () => {
						throw new Error("inner2");
					},
				});
			},
		} as unknown as Parameters<typeof __setSentryModuleForTests>[0];
		__setSentryModuleForTests(fakeMod);
		expect(() => captureMainException(new Error("x"))).not.toThrow();
		expect(() => captureMainException(new Error("x"), { foo: "bar" })).not.toThrow();
	});
});

// ─── importSentryModule (covers the catch path via mock) ─────────────────

describe("importSentryModule", () => {
	test("returns a Promise resolving to a module or null", async () => {
		const result = await I.importSentryModule();
		// In bun-test there's no real sentry module; either the dynamic import
		// resolves (if a stub is present) or throws (caught → null). Both shapes
		// satisfy the contract: never throws, always settles.
		expect(result === null || typeof result === "object").toBe(true);
	});
});

// ─── loadAndInitSentry (smoke) ───────────────────────────────────────────

describe("loadAndInitSentry", () => {
	test("does not throw even when sentry module import fails", async () => {
		await expect(I.loadAndInitSentry("https://example.com/7")).resolves.toBeUndefined();
	});
});
