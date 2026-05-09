import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const noop = () => undefined;

// Stub electron + electron-bound modules so importing llm.ts doesn't pull in the real Electron runtime.
mock.module("electron", () => ({
	ipcMain: {
		handle: noop,
		removeHandler: noop,
	},
	app: { getPath: () => "." },
	BrowserWindow: {
		getAllWindows: () => [],
	},
}));
mock.module("../lib/debug-log", () => ({ dbg: noop }));

import { storeMock } from "@test/mocks/store";

mock.module("../lib/store", () => ({
	...storeMock(),
	getStoreValue: (key: string) => {
		if (key === "llm.endpoint") {
			return "http://localhost:65535";
		}
		if (key === "llm.timeout") {
			return 5000;
		}
		return;
	},
}));

const { scanOllamaModels, __llm_test_helpers__: helpers } = await import("./llm");
const { ConnectionError, TimeoutError, ValidationError } = await import(
	"../../src/shared/lib/errors"
);

const ENDPOINT = "http://localhost:65535";

describe("scanOllamaModels — connection failure handling", () => {
	const originalFetch = globalThis.fetch;
	let consoleErrorSpy: ReturnType<typeof mock>;
	let originalConsoleError: typeof console.error;

	beforeEach(() => {
		originalConsoleError = console.error;
		consoleErrorSpy = mock(noop);
		console.error = consoleErrorSpy;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		console.error = originalConsoleError;
	});

	test("returns reachable=false with error message when fetch rejects (Ollama not running)", async () => {
		globalThis.fetch = mock(() =>
			Promise.reject(new TypeError("fetch failed"))
		) as unknown as typeof fetch;

		const result = await scanOllamaModels(ENDPOINT);

		expect(result.models).toEqual([]);
		expect(result.reachable).toBe(false);
		expect(result.error).toBeDefined();
		expect(consoleErrorSpy).not.toHaveBeenCalled();
	});

	test("returns reachable=true with error when Ollama answers with HTTP error", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("Service Unavailable", { status: 503 }))
		) as unknown as typeof fetch;

		const result = await scanOllamaModels(ENDPOINT);

		expect(result.models).toEqual([]);
		expect(result.reachable).toBe(true);
		expect(result.error).toContain("503");
		expect(consoleErrorSpy).not.toHaveBeenCalled();
	});

	test("returns reachable=true with parsed models on success", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						models: [{ name: "llama3", size: 4_000_000_000, modified_at: "2026-01-01" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				)
			)
		) as unknown as typeof fetch;

		const result = await scanOllamaModels(ENDPOINT);

		expect(result.reachable).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.models).toEqual([
			{ name: "llama3", size: 4_000_000_000, modifiedAt: "2026-01-01" },
		]);
	});

	test("throws ValidationError for empty endpoint (caller bug — not a connection failure)", async () => {
		await expect(scanOllamaModels("")).rejects.toThrow();
	});
});

describe("llm pure helpers", () => {
	test("assertNonEmptyString throws on non-strings and empty strings", () => {
		expect(() => helpers.assertNonEmptyString(42, "msg", "field")).toThrow();
		expect(() => helpers.assertNonEmptyString(null, "msg", "field")).toThrow();
		expect(() => helpers.assertNonEmptyString("", "msg", "field")).toThrow();
		expect(() => helpers.assertNonEmptyString("ok", "msg", "field")).not.toThrow();
	});

	test("assertValidEndpoint normalizes valid endpoint", () => {
		expect(helpers.assertValidEndpoint("http://localhost:11434/")).toBe("http://localhost:11434");
	});

	test("assertValidEndpoint throws ValidationError for empty input", () => {
		expect(() => helpers.assertValidEndpoint("")).toThrow();
	});

	test("resolvePresetPrompt returns matching preset", () => {
		expect(helpers.resolvePresetPrompt("formal")).toContain("formal");
	});

	test("resolvePresetPrompt falls back to neutral for unknown key", () => {
		expect(helpers.resolvePresetPrompt("nope")).toContain("grammar");
	});

	test("buildAuthHeaders includes Authorization when apiKey present", () => {
		expect(helpers.buildAuthHeaders("secret")).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer secret",
		});
	});

	test("buildAuthHeaders omits Authorization when apiKey empty", () => {
		expect(helpers.buildAuthHeaders("")).toEqual({ "Content-Type": "application/json" });
	});

	test("buildModelOptions returns empty object when no providerSlug", () => {
		expect(helpers.buildModelOptions(undefined)).toEqual({});
	});

	test("buildModelOptions returns extraBody when providerSlug present", () => {
		expect(helpers.buildModelOptions("openai")).toEqual({
			extraBody: { provider: { order: ["openai"], allow_fallbacks: false } },
		});
	});

	test("buildOllamaChatBody uses min num_predict of 100", () => {
		const body = JSON.parse(helpers.buildOllamaChatBody("m", [], 10));
		expect(body.options.num_predict).toBe(100);
		expect(body.stream).toBe(false);
		expect(body.model).toBe("m");
	});

	test("buildOllamaChatBody scales num_predict for long input", () => {
		const body = JSON.parse(helpers.buildOllamaChatBody("m", [], 200));
		expect(body.options.num_predict).toBe(400);
	});

	test("stripTildePrefix strips a leading tilde only", () => {
		expect(helpers.stripTildePrefix("~foo")).toBe("foo");
		expect(helpers.stripTildePrefix("foo")).toBe("foo");
		expect(helpers.stripTildePrefix("")).toBe("");
	});

	test("repairOpenRouterText returns valid JSON unchanged after fence stripping", () => {
		expect(helpers.repairOpenRouterText('```json\n{"text":"hi"}\n```')).toBe('{"text":"hi"}');
	});

	test("repairOpenRouterText wraps plain text into JSON shape", () => {
		const out = helpers.repairOpenRouterText("hello world");
		expect(JSON.parse(out)).toEqual({ text: "hello world" });
	});

	test("repairOpenRouterText strips surrounding quotes when content is invalid JSON", () => {
		// The raw text starts with a quote but is malformed JSON (unbalanced),
		// so JSON.parse fails and the helper falls back to stripping outer quotes.
		const out = helpers.repairOpenRouterText('"hello world');
		expect(JSON.parse(out)).toEqual({ text: "hello world" });
	});

	test("isPassThroughError true for ConnectionError/TimeoutError/ValidationError", () => {
		expect(helpers.isPassThroughError(new ConnectionError("x", "endpoint", false))).toBe(true);
		expect(helpers.isPassThroughError(new TimeoutError(100, "op"))).toBe(true);
		expect(helpers.isPassThroughError(new ValidationError("x", "f"))).toBe(true);
	});

	test("isPassThroughError false for unrelated errors", () => {
		expect(helpers.isPassThroughError(new Error("bare"))).toBe(false);
		expect(helpers.isPassThroughError("string")).toBe(false);
		expect(helpers.isPassThroughError(undefined)).toBe(false);
	});

	test("isAbortLikeTimeoutError true only for Error with name TimeoutError", () => {
		const err = new Error("timed out");
		err.name = "TimeoutError";
		expect(helpers.isAbortLikeTimeoutError(err)).toBe(true);
		expect(helpers.isAbortLikeTimeoutError(new Error("plain"))).toBe(false);
		expect(helpers.isAbortLikeTimeoutError("string")).toBe(false);
	});

	test("toTimeoutErrorOrNull returns TimeoutError when input is abort-like", () => {
		const err = new Error("timed out");
		err.name = "TimeoutError";
		const out = helpers.toTimeoutErrorOrNull(
			err,
			{ provider: "ollama", preset: "neutral", timeout: 1000 },
			42
		);
		expect(out).toBeInstanceOf(TimeoutError);
	});

	test("toTimeoutErrorOrNull returns null for non-abort errors", () => {
		expect(
			helpers.toTimeoutErrorOrNull(
				new Error("other"),
				{ provider: "ollama", preset: "neutral", timeout: 1000 },
				10
			)
		).toBeNull();
	});

	test("mapAndThrowOrReturn rethrows pass-through errors", () => {
		expect(() =>
			helpers.mapAndThrowOrReturn(
				new ValidationError("bad", "field"),
				{ provider: "ollama", preset: "neutral", timeout: 1000 },
				"text"
			)
		).toThrow(ValidationError);
	});

	test("mapAndThrowOrReturn converts abort-like to TimeoutError", () => {
		const err = new Error("aborted");
		err.name = "TimeoutError";
		expect(() =>
			helpers.mapAndThrowOrReturn(
				err,
				{ provider: "ollama", preset: "neutral", timeout: 1000 },
				"text"
			)
		).toThrow(TimeoutError);
	});

	test("mapAndThrowOrReturn falls back to original text for unknown errors", () => {
		// Stub console.error locally so the noise doesn't bleed into output
		const origErr = console.error;
		console.error = () => undefined;
		try {
			const result = helpers.mapAndThrowOrReturn(
				new Error("random"),
				{ provider: "ollama", preset: "neutral", timeout: 1000 },
				"original text"
			);
			expect(result).toBe("original text");
		} finally {
			console.error = origErr;
		}
	});

	test("isOllamaUnavailable true when not installed or path missing", () => {
		expect(helpers.isOllamaUnavailable({ installed: false })).toBe(true);
		expect(helpers.isOllamaUnavailable({ installed: true })).toBe(true);
		expect(helpers.isOllamaUnavailable({ installed: true, path: "/foo/bar" })).toBe(false);
	});

	test("getOllamaCandidatePaths returns paths from env vars", () => {
		const origLA = process.env.LOCALAPPDATA;
		const origPF = process.env.ProgramFiles;
		process.env.LOCALAPPDATA = "C:\\Users\\Test\\AppData\\Local";
		process.env.ProgramFiles = "C:\\Program Files";
		try {
			const candidates = helpers.getOllamaCandidatePaths();
			expect(candidates.length).toBe(2);
			expect(candidates[0]).toContain("Programs");
			expect(candidates[1]).toContain("Ollama");
		} finally {
			if (origLA === undefined) {
				delete process.env.LOCALAPPDATA;
			} else {
				process.env.LOCALAPPDATA = origLA;
			}
			if (origPF === undefined) {
				delete process.env.ProgramFiles;
			} else {
				process.env.ProgramFiles = origPF;
			}
		}
	});

	test.each([
		["non-blank", true],
		["  spaced  ", true],
		["", false],
		["   ", false],
		["\t", false],
	])("isNonBlankLine(%p) === %p", (line, expected) => {
		expect(helpers.isNonBlankLine(line)).toBe(expected);
	});

	test("pickFirstNonBlankLine picks first non-blank line", () => {
		expect(helpers.pickFirstNonBlankLine("\n\n  hello\nworld\n")).toBe("  hello");
	});

	test("pickFirstNonBlankLine returns undefined when all blank", () => {
		expect(helpers.pickFirstNonBlankLine("\n  \n  \n")).toBeUndefined();
	});

	test("assertProcessTextPayload throws on non-objects", () => {
		expect(() => helpers.assertProcessTextPayload(null)).toThrow(ValidationError);
		expect(() => helpers.assertProcessTextPayload(42)).toThrow(ValidationError);
	});

	test("assertProcessTextPayload throws when text field missing/wrong type", () => {
		expect(() => helpers.assertProcessTextPayload({})).toThrow(ValidationError);
		expect(() => helpers.assertProcessTextPayload({ text: 42 })).toThrow(ValidationError);
	});

	test("assertProcessTextPayload accepts valid payload", () => {
		expect(() => helpers.assertProcessTextPayload({ text: "hello" })).not.toThrow();
	});

	test("parseOllamaTagsOrFail returns mapped models for valid response", () => {
		const result = helpers.parseOllamaTagsOrFail({
			models: [{ name: "llama3", size: 100, modified_at: "now" }],
		});
		expect(result.reachable).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.models).toEqual([{ name: "llama3", size: 100, modifiedAt: "now" }]);
	});

	test("parseOllamaTagsOrFail returns error for invalid shape", () => {
		const result = helpers.parseOllamaTagsOrFail({ models: [{ wrong: "shape" }] });
		expect(result.reachable).toBe(true);
		expect(result.models).toEqual([]);
		expect(result.error).toBeDefined();
	});

	test("parseOllamaTagsOrFail handles missing models array", () => {
		const result = helpers.parseOllamaTagsOrFail({});
		expect(result.models).toEqual([]);
	});

	test("parseOllamaChatOrFallback returns trimmed content", () => {
		const json = {
			model: "m",
			created_at: "now",
			message: { role: "assistant", content: "  hi  " },
			done: true,
		};
		expect(helpers.parseOllamaChatOrFallback(json, "fallback")).toBe("hi");
	});

	test("parseOllamaChatOrFallback returns fallback for invalid response", () => {
		expect(helpers.parseOllamaChatOrFallback({ wrong: "shape" }, "fallback")).toBe("fallback");
	});

	test("parseOllamaChatOrFallback returns fallback for empty content", () => {
		const json = {
			model: "m",
			created_at: "now",
			message: { role: "assistant", content: "   " },
			done: true,
		};
		expect(helpers.parseOllamaChatOrFallback(json, "fallback")).toBe("fallback");
	});

	test("parseOpenRouterModelsOrFail returns enriched models", () => {
		const result = helpers.parseOpenRouterModelsOrFail({
			data: [{ id: "openai/gpt-4", name: "GPT-4", context_length: 8000 }],
		});
		expect(result.reachable).toBe(true);
		expect(result.models).toHaveLength(1);
		expect(result.models[0]?.id).toBe("openai/gpt-4");
		expect(result.models[0]?.maker).toBe("openai");
		expect(result.models[0]?.model_name).toBe("gpt-4");
	});

	test("parseOpenRouterModelsOrFail returns error for invalid shape", () => {
		const result = helpers.parseOpenRouterModelsOrFail({ data: [{ no_id: true }] });
		expect(result.error).toBeDefined();
	});

	test("enrichOpenRouterModel parses variants and makers correctly", () => {
		const enriched = helpers.enrichOpenRouterModel({
			id: "anthropic/claude-3:thinking",
			name: "Claude 3 thinking",
		});
		expect(enriched.maker).toBe("anthropic");
		expect(enriched.model_name).toBe("claude-3");
		expect(enriched.variant).toBe("thinking");
		expect(enriched.provider).toBe("openrouter");
	});

	test("enrichOpenRouterModel handles single-segment id", () => {
		const enriched = helpers.enrichOpenRouterModel({ id: "auto", name: "Auto" });
		expect(enriched.maker).toBeUndefined();
		expect(enriched.model_name).toBe("auto");
	});
});
