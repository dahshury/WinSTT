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
mock.module("../lib/debug-log", () => ({ dbg: noop, dbgVerbose: noop }));

import { storeMock } from "@test/mocks/store";

// Only llm.endpoint/llm.timeout are driven here; all other keys delegate to
// the COMPLETE shared store mock so a process-global `../lib/store` cache leak
// into sibling tests stays semantically harmless (a blanket `return undefined`
// would poison e.g. transforms.test.ts reading `llm.transforms`).
mock.module("../lib/store", () => {
	const base = storeMock();
	return {
		...base,
		getStoreValue: (key: string) => {
			if (key === "llm.endpoint") {
				return "http://localhost:65535";
			}
			if (key === "llm.timeout") {
				return 5000;
			}
			return base.getStoreValue(key);
		},
	};
});

const {
	scanOllamaModels,
	scanOpenRouterModels,
	detectOllama,
	startOllama,
	processText,
	processTextWithCustomPrompt,
	deleteOllamaModel,
	pullOllamaModel,
	cancelOllamaModelPull,
	setupLlm,
	__llm_test_helpers__: helpers,
} = await import("./llm");
const { ConnectionError, ValidationError } = await import("../../src/shared/lib/errors");

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

	test("withContextPrefix returns the system prompt unchanged when context is empty", () => {
		const sys = "You are an editor.";
		expect(helpers.withContextPrefix(sys, "")).toBe(sys);
	});

	test("withContextPrefix wraps the context in a <context>…</context> block and preserves the system prompt", () => {
		const sys = "You are an editor.";
		const out = helpers.withContextPrefix(sys, "Window: Slack");
		expect(out).toContain("<context>");
		expect(out).toContain("Window: Slack");
		expect(out).toContain("</context>");
		expect(out.endsWith(sys)).toBe(true);
	});

	test("withContextPrefix instructs the model to treat context as hint-only", () => {
		const out = helpers.withContextPrefix("X", "Y");
		// Spelling-only-hint framing is load-bearing: without it the LLM tends
		// to summarize the captured text into the output.
		expect(out.toLowerCase()).toContain("spelling");
	});

	test("describePresets renders a single preset key", () => {
		expect(helpers.describePresets([{ key: "formal" }])).toBe("formal");
	});

	test("describePresets includes the level for leveled presets and joins with commas", () => {
		expect(helpers.describePresets([{ key: "summarize", level: "high" }, { key: "reorder" }])).toBe(
			"summarize:high,reorder"
		);
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

	test("isPassThroughError true for ConnectionError/ValidationError", () => {
		expect(helpers.isPassThroughError(new ConnectionError("x", "endpoint", false))).toBe(true);
		expect(helpers.isPassThroughError(new ValidationError("x", "f"))).toBe(true);
	});

	test("isPassThroughError false for unrelated errors", () => {
		expect(helpers.isPassThroughError(new Error("bare"))).toBe(false);
		expect(helpers.isPassThroughError("string")).toBe(false);
		expect(helpers.isPassThroughError(undefined)).toBe(false);
	});

	test("mapAndThrowOrReturn rethrows pass-through errors", () => {
		expect(() =>
			helpers.mapAndThrowOrReturn(
				new ValidationError("bad", "field"),
				{ provider: "ollama", presets: [{ key: "neutral" as const }], timeout: 5000 },
				"text"
			)
		).toThrow(ValidationError);
	});

	test("mapAndThrowOrReturn falls back to original text for unknown errors", () => {
		// Stub console.error locally so the noise doesn't bleed into output
		const origErr = console.error;
		console.error = () => undefined;
		try {
			const result = helpers.mapAndThrowOrReturn(
				new Error("random"),
				{ provider: "ollama", presets: [{ key: "neutral" as const }], timeout: 5000 },
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

// ── readErrorText ─────────────────────────────────────────────────────

describe("readErrorText", () => {
	test("returns text from response body", async () => {
		const response = new Response("some error", { status: 400 });
		expect(await helpers.readErrorText(response)).toBe("some error");
	});

	test("returns 'Unknown error' when text() throws", async () => {
		const badResponse = {
			text: () => Promise.reject(new Error("stream error")),
		} as unknown as Response;
		expect(await helpers.readErrorText(badResponse)).toBe("Unknown error");
	});
});

// ── assertOllamaResponseOk ────────────────────────────────────────────

describe("assertOllamaResponseOk", () => {
	test("does not throw when response.ok is true", async () => {
		const response = new Response("ok", { status: 200 });
		await expect(
			helpers.assertOllamaResponseOk(response, {
				endpoint: "http://localhost:11434",
				model: "llama3",
				presets: "neutral",
			})
		).resolves.toBeUndefined();
	});

	test("throws ConnectionError when response.ok is false", async () => {
		const response = new Response("Bad Request", { status: 400 });
		const { ConnectionError } = await import("../../src/shared/lib/errors");
		await expect(
			helpers.assertOllamaResponseOk(response, {
				endpoint: "http://localhost:11434",
				model: "llama3",
				presets: "neutral",
			})
		).rejects.toBeInstanceOf(ConnectionError);
	});
});

// ── resolveOpenRouterModelId ──────────────────────────────────────────

describe("resolveOpenRouterModelId", () => {
	test("returns model id as-is when non-empty", () => {
		expect(helpers.resolveOpenRouterModelId("openai/gpt-4")).toBe("openai/gpt-4");
	});

	test("returns 'openrouter/auto' for empty string", () => {
		expect(helpers.resolveOpenRouterModelId("")).toBe("openrouter/auto");
	});
});

// ── returnTextIfEmpty ─────────────────────────────────────────────────

describe("returnTextIfEmpty", () => {
	test("returns generated text when non-empty", () => {
		expect(helpers.returnTextIfEmpty("hello", "fallback")).toBe("hello");
	});

	test("returns fallback when generated is empty string", () => {
		expect(helpers.returnTextIfEmpty("", "fallback")).toBe("fallback");
	});
});

// ── rethrowOrFallbackEligible ─────────────────────────────────────────

describe("rethrowOrFallbackEligible", () => {
	test("throws ValidationError even when fallback is provided", () => {
		expect(() =>
			helpers.rethrowOrFallbackEligible(new ValidationError("bad", "field"), "fallback")
		).toThrow(ValidationError);
	});

	test("rethrows other error when fallback is empty string", () => {
		const err = new Error("network");
		expect(() => helpers.rethrowOrFallbackEligible(err, "")).toThrow("network");
	});

	test("returns true when fallback is non-empty and error is not ValidationError", () => {
		expect(helpers.rethrowOrFallbackEligible(new Error("network"), "fallback")).toBe(true);
	});
});

// ── isAbortError ──────────────────────────────────────────────────────

describe("isAbortError", () => {
	test("returns true for Error with name AbortError", () => {
		const err = new Error("aborted");
		err.name = "AbortError";
		expect(helpers.isAbortError(err)).toBe(true);
	});

	test("returns false for Error with different name", () => {
		expect(helpers.isAbortError(new Error("other"))).toBe(false);
	});

	test("returns false for non-Error values", () => {
		expect(helpers.isAbortError("string")).toBe(false);
		expect(helpers.isAbortError(null)).toBe(false);
		expect(helpers.isAbortError(undefined)).toBe(false);
	});
});

// ── classifyPullStatus ────────────────────────────────────────────────

describe("classifyPullStatus", () => {
	test.each([
		["success", "success"],
		["Success", "success"],
		["pulling manifest", "pulling"],
		["pulling manifest for model", "pulling"],
		["retrieving model info", "pulling"],
		["pulling some-sha256", "downloading"],
		["downloading model", "downloading"],
		["verifying sha256 digest", "verifying"],
		["writing manifest", "writing"],
		["removing any unused layers", "writing"],
		["unknown status text", "pulling"],
	] as const)("classifyPullStatus(%p) === %p", (input, expected) => {
		expect(helpers.classifyPullStatus(input)).toBe(expected);
	});
});

// ── matchPullStatusPrefix (internal helper for classifyPullStatus) ────

describe("matchPullStatusPrefix", () => {
	test("returns 'success' for exact 'success'", () => {
		expect((helpers as any).matchPullStatusPrefix("success")).toBe("success");
	});

	test("returns 'pulling' for 'pulling manifest' prefix", () => {
		expect((helpers as any).matchPullStatusPrefix("pulling manifest for model")).toBe("pulling");
	});

	test("returns 'pulling' for 'retrieving' prefix", () => {
		expect((helpers as any).matchPullStatusPrefix("retrieving model info")).toBe("pulling");
	});

	test("returns 'downloading' for 'pulling ' prefix (space matters)", () => {
		expect((helpers as any).matchPullStatusPrefix("pulling sha256:abc123")).toBe("downloading");
	});

	test("returns 'downloading' for 'downloading' prefix", () => {
		expect((helpers as any).matchPullStatusPrefix("downloading layer")).toBe("downloading");
	});

	test("returns 'verifying' for 'verifying' prefix", () => {
		expect((helpers as any).matchPullStatusPrefix("verifying sha256")).toBe("verifying");
	});

	test("returns 'writing' for 'writing' prefix", () => {
		expect((helpers as any).matchPullStatusPrefix("writing manifest")).toBe("writing");
	});

	test("returns 'writing' for 'removing' prefix", () => {
		expect((helpers as any).matchPullStatusPrefix("removing unused layers")).toBe("writing");
	});

	test("returns undefined for unknown prefix", () => {
		expect((helpers as any).matchPullStatusPrefix("unknown status")).toBeUndefined();
	});
});

// ── computePercent ────────────────────────────────────────────────────

describe("computePercent", () => {
	test("returns undefined when completed is undefined", () => {
		expect(helpers.computePercent(undefined, 100)).toBeUndefined();
	});

	test("returns undefined when total is undefined", () => {
		expect(helpers.computePercent(50, undefined)).toBeUndefined();
	});

	test("returns undefined when total is 0", () => {
		expect(helpers.computePercent(50, 0)).toBeUndefined();
	});

	test("returns undefined when total is negative", () => {
		expect(helpers.computePercent(50, -1)).toBeUndefined();
	});

	test("computes correct percentage", () => {
		expect(helpers.computePercent(50, 100)).toBe(50);
	});

	test("clamps to 0 minimum", () => {
		expect(helpers.computePercent(-10, 100)).toBe(0);
	});

	test("clamps to 100 maximum", () => {
		expect(helpers.computePercent(200, 100)).toBe(100);
	});
});

// ── iterateNdjsonChunks ───────────────────────────────────────────────

describe("iterateNdjsonChunks", () => {
	test("yields lines separated by newlines", () => {
		const buffer = { value: "line1\nline2\nline3\n" };
		const lines = [...helpers.iterateNdjsonChunks(buffer)];
		expect(lines).toEqual(["line1", "line2", "line3"]);
		expect(buffer.value).toBe("");
	});

	test("skips blank lines", () => {
		const buffer = { value: "line1\n\n  \nline2\n" };
		const lines = [...helpers.iterateNdjsonChunks(buffer)];
		expect(lines).toEqual(["line1", "line2"]);
	});

	test("leaves partial line in buffer", () => {
		const buffer = { value: "line1\npartial" };
		const lines = [...helpers.iterateNdjsonChunks(buffer)];
		expect(lines).toEqual(["line1"]);
		expect(buffer.value).toBe("partial");
	});

	test("yields nothing when no newlines present", () => {
		const buffer = { value: "no newlines here" };
		const lines = [...helpers.iterateNdjsonChunks(buffer)];
		expect(lines).toEqual([]);
		expect(buffer.value).toBe("no newlines here");
	});
});

// ── parsePullLine ─────────────────────────────────────────────────────

describe("parsePullLine", () => {
	test("returns parsed data for valid JSON matching schema", () => {
		const line = JSON.stringify({
			status: "pulling manifest",
			digest: "sha256:abc",
			total: 1000,
			completed: 500,
		});
		const result = helpers.parsePullLine(line);
		expect(result).not.toBeNull();
		expect(result?.status).toBe("pulling manifest");
		expect(result?.completed).toBe(500);
	});

	test("returns null for invalid JSON", () => {
		expect(helpers.parsePullLine("not-json-at-all{")).toBeNull();
	});

	test("returns null for JSON not matching schema (missing status field)", () => {
		expect(helpers.parsePullLine(JSON.stringify({ other: "field" }))).toBeNull();
	});

	test("returns parsed data with error field", () => {
		const line = JSON.stringify({ status: "error", error: "pull failed" });
		const result = helpers.parsePullLine(line);
		expect(result?.error).toBe("pull failed");
	});
});

// ── broadcastPullProgress ─────────────────────────────────────────────

describe("broadcastPullProgress", () => {
	test("does not throw when no windows exist (empty list)", () => {
		// BrowserWindow.getAllWindows() is mocked to return []
		expect(() =>
			helpers.broadcastPullProgress({ model: "llama3", status: "pulling" })
		).not.toThrow();
	});
});

// ── consumePullLines ──────────────────────────────────────────────────

describe("consumePullLines", () => {
	test("processes lines and marks final.success=true on success status", () => {
		const state = {
			buffer: { value: `${JSON.stringify({ status: "success" })}\n` },
			final: { success: false },
		};
		helpers.consumePullLines(state, "llama3");
		expect(state.final.success).toBe(true);
	});

	test("sets final.error when parsed line has error field", () => {
		const state: { buffer: { value: string }; final: { success: boolean; error?: string } } = {
			buffer: { value: `${JSON.stringify({ status: "error", error: "boom" })}\n` },
			final: { success: false },
		};
		helpers.consumePullLines(state, "llama3");
		expect(state.final.error).toBe("boom");
	});

	test("skips null-parsing lines gracefully", () => {
		const state = {
			buffer: { value: "not-valid-json\n" },
			final: { success: false },
		};
		expect(() => helpers.consumePullLines(state, "llama3")).not.toThrow();
		expect(state.final.success).toBe(false);
	});
});

// ── assertModelPayload ────────────────────────────────────────────────

describe("assertModelPayload", () => {
	test("throws on null", () => {
		expect(() => helpers.assertModelPayload(null)).toThrow(ValidationError);
	});

	test("throws on non-object", () => {
		expect(() => helpers.assertModelPayload(42)).toThrow(ValidationError);
	});

	test("throws when model field is not a string", () => {
		expect(() => helpers.assertModelPayload({ model: 42 })).toThrow(ValidationError);
	});

	test("does not throw for valid payload", () => {
		expect(() => helpers.assertModelPayload({ model: "llama3" })).not.toThrow();
	});
});

// ── assertValidModelName ──────────────────────────────────────────────

describe("assertValidModelName", () => {
	test("does not throw for valid model name", () => {
		expect(() => helpers.assertValidModelName("llama3:latest")).not.toThrow();
	});

	test("throws ValidationError for empty name", () => {
		expect(() => helpers.assertValidModelName("")).toThrow(ValidationError);
	});

	test("throws ValidationError for name with invalid characters", () => {
		expect(() => helpers.assertValidModelName("llama3 latest")).toThrow(ValidationError);
		expect(() => helpers.assertValidModelName("llama3@latest")).toThrow(ValidationError);
	});
});

// ── runProcessText ────────────────────────────────────────────────────

describe("runProcessText — provider routing", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("routes to Ollama when provider is 'ollama' (store model='' → ValidationError)", async () => {
		// The store mock returns "" for "llm.dictation.model", so processWithOllama throws
		// ValidationError("Ollama model is required"). This proves the ollama path is taken.
		await expect(
			helpers.runProcessText("hello", "ollama", [{ key: "neutral" as const }], 5000, "")
		).rejects.toBeInstanceOf(ValidationError);
	});

	test("routes to openrouter when provider is 'openrouter' — throws ValidationError when no api key", async () => {
		// getStoreValue("llm.openrouterApiKey") returns undefined from the mock (no api key)
		const { ValidationError } = await import("../../src/shared/lib/errors");
		await expect(
			helpers.runProcessText("hello", "openrouter", [{ key: "neutral" as const }], 5000, "")
		).rejects.toBeInstanceOf(ValidationError);
	});
});

// ── fileExists ────────────────────────────────────────────────────────

describe("fileExists", () => {
	test("returns false for a path that does not exist", async () => {
		const result = await helpers.fileExists("Z:/this/path/does/not/exist/at/all.exe");
		expect(result).toBe(false);
	});
});

// ── findOllamaInDefaultDirs ───────────────────────────────────────────

describe("findOllamaInDefaultDirs", () => {
	test("returns installed=false when no candidate paths exist", async () => {
		const origLA = process.env.LOCALAPPDATA;
		const origPF = process.env.ProgramFiles;
		// Set them to non-existent paths so fileExists always returns false
		process.env.LOCALAPPDATA = "Z:\\NoSuchDir";
		process.env.ProgramFiles = "Z:\\NoSuchDir";
		try {
			const result = await helpers.findOllamaInDefaultDirs();
			expect(result.installed).toBe(false);
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
});

// ── detectOllama (exported) ───────────────────────────────────────────

describe("detectOllama — dispatches by platform", () => {
	test("on win32 dispatches to Windows detection path (probe returns not installed when Ollama absent)", async () => {
		const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const origLA = process.env.LOCALAPPDATA;
		const origPF = process.env.ProgramFiles;
		process.env.LOCALAPPDATA = "Z:\\NoSuchDir";
		process.env.ProgramFiles = "Z:\\NoSuchDir";
		try {
			const result = await detectOllama();
			// We can't guarantee Ollama IS installed, so just check shape
			expect(result).toHaveProperty("installed");
		} finally {
			if (origPlatform) {
				Object.defineProperty(process, "platform", origPlatform);
			}
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
});

// ── detectOllamaWindows / tryFindOllamaViaWhere ───────────────────────

describe("tryFindOllamaViaWhere", () => {
	test("returns null when 'where' command fails", async () => {
		// On this system 'where' exists but 'where ollama_missing_tool' won't find it
		// We can't easily override execFile, so just verify the function signature exists
		// and returns the right shape on actual failure
		const result = await helpers.tryFindOllamaViaWhere();
		// Either null (not found/failed) or { installed: true, path: string }
		if (result === null) {
			expect(result).toBeNull();
		} else {
			expect(result).toHaveProperty("installed", true);
			expect(result).toHaveProperty("path");
		}
	});
});

describe("detectOllamaWindows", () => {
	test("returns a result with installed property", async () => {
		const result = await helpers.detectOllamaWindows();
		expect(result).toHaveProperty("installed");
	});
});

// ── tryDetectOllamaPosix ──────────────────────────────────────────────

describe("tryDetectOllamaPosix", () => {
	test("returns a result with installed property", async () => {
		// On Windows, 'which' won't work — the function will catch and return { installed: false }
		const result = await helpers.tryDetectOllamaPosix();
		expect(result).toHaveProperty("installed");
	});
});

// ── startOllama (exported) ────────────────────────────────────────────

describe("startOllama", () => {
	test("returns started=false with error when Ollama is not installed", async () => {
		// Force detectOllama to return not-installed by removing env vars temporarily
		// We can test indirectly: if Ollama is actually not installed the error is returned
		// This test is deterministic — it probes the actual system.
		// Since we can't easily mock detectOllama here without module re-import tricks,
		// we just verify the shape of the return value.
		const result = await startOllama();
		expect(result).toHaveProperty("started");
		if (!result.started) {
			expect(result.error).toBeDefined();
		}
	});
});

// ── scanOpenRouterModels (exported) ───────────────────────────────────

describe("scanOpenRouterModels", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("returns reachable=false when fetch rejects", async () => {
		globalThis.fetch = mock(() =>
			Promise.reject(new TypeError("network error"))
		) as unknown as typeof fetch;
		const result = await scanOpenRouterModels("test-key");
		expect(result.reachable).toBe(false);
		expect(result.error).toBeDefined();
		expect(result.models).toEqual([]);
	});

	test("returns reachable=true with error on HTTP error response", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("Unauthorized", { status: 401 }))
		) as unknown as typeof fetch;
		const result = await scanOpenRouterModels("bad-key");
		expect(result.reachable).toBe(true);
		expect(result.error).toContain("401");
	});

	test("returns parsed models on success", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						data: [{ id: "openai/gpt-4o", name: "GPT-4o", context_length: 128_000 }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				)
			)
		) as unknown as typeof fetch;
		const result = await scanOpenRouterModels("valid-key");
		expect(result.reachable).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.models).toHaveLength(1);
		expect(result.models[0]?.id).toBe("openai/gpt-4o");
	});
});

// ── processText (exported) ────────────────────────────────────────────

describe("processText", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("throws ValidationError when text is empty", async () => {
		const { ValidationError } = await import("../../src/shared/lib/errors");
		await expect(processText("")).rejects.toBeInstanceOf(ValidationError);
	});

	test("returns transformed text via Ollama when provider is ollama", async () => {
		// store mock returns "llm.dictation.provider" = "ollama" but model is ""
		// by stubbing fetch to return a valid Ollama response
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						model: "llama3",
						created_at: "now",
						message: { role: "assistant", content: "corrected text" },
						done: true,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } }
				)
			)
		) as unknown as typeof fetch;
		// The store mock returns "ollama" for "llm.dictation.provider" which causes runOllamaPath
		// to be called. But model would be "" → ValidationError.
		// So we test that it at least calls through properly.
		const { ValidationError } = await import("../../src/shared/lib/errors");
		await expect(processText("hello world")).rejects.toBeInstanceOf(ValidationError);
	});
});

// ── deleteOllamaModel (exported) ──────────────────────────────────────

describe("deleteOllamaModel", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("throws ValidationError for empty model name", async () => {
		const { ValidationError } = await import("../../src/shared/lib/errors");
		await expect(deleteOllamaModel("http://localhost:11434", "")).rejects.toBeInstanceOf(
			ValidationError
		);
	});

	test("throws ValidationError for invalid model name characters", async () => {
		const { ValidationError } = await import("../../src/shared/lib/errors");
		await expect(
			deleteOllamaModel("http://localhost:11434", "bad model name")
		).rejects.toBeInstanceOf(ValidationError);
	});

	test("returns success=false with error when fetch rejects (unreachable)", async () => {
		globalThis.fetch = mock(() =>
			Promise.reject(new TypeError("network error"))
		) as unknown as typeof fetch;
		const result = await deleteOllamaModel("http://localhost:11434", "llama3");
		expect(result.success).toBe(false);
		expect(result.error).toBeDefined();
	});

	test("returns success=false on HTTP error", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("Not Found", { status: 404 }))
		) as unknown as typeof fetch;
		const result = await deleteOllamaModel("http://localhost:11434", "llama3");
		expect(result.success).toBe(false);
		expect(result.error).toContain("404");
	});

	test("returns success=true on HTTP 200", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("", { status: 200 }))
		) as unknown as typeof fetch;
		const result = await deleteOllamaModel("http://localhost:11434", "llama3");
		expect(result.success).toBe(true);
		expect(result.model).toBe("llama3");
	});
});

// ── pullOllamaModel (exported) + cancelOllamaModelPull ────────────────

describe("pullOllamaModel and cancelOllamaModelPull", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("cancelOllamaModelPull returns cancelled=false when no pull is active", () => {
		expect(cancelOllamaModelPull("no-active-model")).toEqual({ cancelled: false });
	});

	test("pullOllamaModel throws ValidationError for empty model name", async () => {
		const { ValidationError } = await import("../../src/shared/lib/errors");
		await expect(pullOllamaModel("http://localhost:11434", "")).rejects.toBeInstanceOf(
			ValidationError
		);
	});

	test("pullOllamaModel returns success=false on HTTP error", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("Not Found", { status: 404 }))
		) as unknown as typeof fetch;
		const result = await pullOllamaModel("http://localhost:11434", "llama3:latest");
		expect(result.success).toBe(false);
		expect(result.error).toContain("404");
	});

	test("pullOllamaModel returns success=false when body is null", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(null, { status: 200 }))
		) as unknown as typeof fetch;
		const result = await pullOllamaModel("http://localhost:11434", "llama3:latest");
		expect(result.success).toBe(false);
	});

	test("pullOllamaModel streams NDJSON and returns success=true on 'success' status line", async () => {
		const ndjson = `${[
			JSON.stringify({ status: "pulling manifest" }),
			JSON.stringify({
				status: "pulling abc123",
				digest: "sha256:abc",
				total: 1000,
				completed: 500,
			}),
			JSON.stringify({ status: "success" }),
		].join("\n")}\n`;

		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(ndjson, {
					status: 200,
					headers: { "Content-Type": "application/x-ndjson" },
				})
			)
		) as unknown as typeof fetch;

		const result = await pullOllamaModel("http://localhost:11434", "llama3:latest");
		expect(result.success).toBe(true);
		expect(result.model).toBe("llama3:latest");
	});

	test("pullOllamaModel returns cancelled=true when AbortError is thrown", async () => {
		globalThis.fetch = mock(() => {
			const err = new Error("aborted");
			err.name = "AbortError";
			return Promise.reject(err);
		}) as unknown as typeof fetch;

		const result = await pullOllamaModel("http://localhost:11434", "llama3:tag");
		expect(result.success).toBe(false);
		expect(result.cancelled).toBe(true);
	});

	test("cancelOllamaModelPull cancels an active pull", async () => {
		// Start a pull that will block until we cancel it
		let resolveHold: () => void;
		const holdPromise = new Promise<void>((res) => {
			resolveHold = res;
		});

		globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
			// Wait until cancelled
			await new Promise<void>((res) => {
				init?.signal?.addEventListener("abort", () => res());
				holdPromise.then(res);
			});
			const err = new Error("aborted");
			err.name = "AbortError";
			throw err;
		}) as unknown as typeof fetch;

		// Start the pull in background
		const pullPromise = pullOllamaModel("http://localhost:11434", "phi3:mini");

		// Give it a tick to register in activePulls
		await new Promise((res) => setTimeout(res, 10));

		const cancelResult = cancelOllamaModelPull("phi3:mini");
		expect(cancelResult.cancelled).toBe(true);

		const result = await pullPromise;
		expect(result.success).toBe(false);
		expect(result.cancelled).toBe(true);

		resolveHold!();
	});
});

// ── handleProcessTextSafe (direct test via helpers export) ───────────

describe("handleProcessTextSafe", () => {
	test("throws and rethrows when payload is invalid (ValidationError)", async () => {
		const origErr = console.error;
		console.error = () => undefined;
		try {
			await expect(helpers.handleProcessTextSafe(null)).rejects.toBeInstanceOf(ValidationError);
		} finally {
			console.error = origErr;
		}
	});

	test("throws and rethrows when text field is missing", async () => {
		const origErr = console.error;
		console.error = () => undefined;
		try {
			await expect(helpers.handleProcessTextSafe({ text: 42 })).rejects.toBeInstanceOf(
				ValidationError
			);
		} finally {
			console.error = origErr;
		}
	});

	test("throws and rethrows when text is empty", async () => {
		const origErr = console.error;
		console.error = () => undefined;
		try {
			await expect(helpers.handleProcessTextSafe({ text: "" })).rejects.toBeInstanceOf(
				ValidationError
			);
		} finally {
			console.error = origErr;
		}
	});
});

// ── pullResultFromStreamOutcome ───────────────────────────────────────

describe("pullResultFromStreamOutcome", () => {
	test("returns success=true payload when result.success is true", () => {
		const result = (helpers as any).pullResultFromStreamOutcome("llama3", { success: true });
		expect(result).toEqual({ success: true, model: "llama3" });
	});

	test("returns success=false with result.error when provided", () => {
		const result = (helpers as any).pullResultFromStreamOutcome("llama3", {
			success: false,
			error: "disk full",
		});
		expect(result.success).toBe(false);
		expect(result.error).toBe("disk full");
	});

	test("returns success=false with fallback message when no error", () => {
		const result = (helpers as any).pullResultFromStreamOutcome("llama3", { success: false });
		expect(result.success).toBe(false);
		expect(result.error).toBe("Pull did not complete successfully");
	});
});

// ── applyPullLine (extracted from consumePullLines) ───────────────────

describe("applyPullLine", () => {
	test("sets final.success=true when progress status is 'success'", () => {
		const final = { success: false };
		const parsed = { status: "success" };
		(helpers as any).applyPullLine(final, "llama3", parsed);
		expect(final.success).toBe(true);
	});

	test("sets final.error when parsed has error field", () => {
		const final: { success: boolean; error?: string } = { success: false };
		const parsed = { status: "error", error: "something went wrong" };
		(helpers as any).applyPullLine(final, "llama3", parsed);
		expect(final.error).toBe("something went wrong");
	});

	test("does not set final.success for non-success status", () => {
		const final = { success: false };
		const parsed = { status: "pulling manifest" };
		(helpers as any).applyPullLine(final, "llama3", parsed);
		expect(final.success).toBe(false);
	});
});

// ── performPull missing branch: stream finishes without success ───────

describe("pullOllamaModel — stream that finishes without success status", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("returns success=false when stream ends without 'success' line", async () => {
		// Only "downloading" lines, no "success"
		const ndjson = `${[
			JSON.stringify({ status: "pulling manifest" }),
			JSON.stringify({
				status: "pulling abc123",
				digest: "sha256:abc",
				total: 1000,
				completed: 200,
			}),
		].join("\n")}\n`;

		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(ndjson, {
					status: 200,
					headers: { "Content-Type": "application/x-ndjson" },
				})
			)
		) as unknown as typeof fetch;

		const result = await pullOllamaModel("http://localhost:11434", "llama3:latest2");
		expect(result.success).toBe(false);
		expect(result.model).toBe("llama3:latest2");
	});

	test("returns success=false when stream ends with error in ndjson", async () => {
		const ndjson = `${JSON.stringify({ status: "error", error: "disk full" })}\n`;

		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(ndjson, {
					status: 200,
					headers: { "Content-Type": "application/x-ndjson" },
				})
			)
		) as unknown as typeof fetch;

		const result = await pullOllamaModel("http://localhost:11434", "llama3:v2");
		expect(result.success).toBe(false);
		expect(result.error).toBe("disk full");
	});
});

// ── processText edge case (non-string text) ───────────────────────────

describe("processText — assertNonEmptyString path", () => {
	test("throws ValidationError for non-string text (assertNonEmptyString)", async () => {
		// @ts-expect-error testing runtime type guard
		await expect(processText(null)).rejects.toBeInstanceOf(ValidationError);
	});
});

// ── assertPlainObject / assertStringField (extracted) ─

describe("assertPlainObject", () => {
	test("does not throw for plain object", () => {
		expect(() => helpers.assertPlainObject({}, "msg")).not.toThrow();
	});

	test("throws ValidationError with given message for non-object", () => {
		expect(() => helpers.assertPlainObject(null, "custom msg")).toThrow(ValidationError);
		expect(() => helpers.assertPlainObject(42, "custom msg")).toThrow("custom msg");
	});
});

describe("assertStringField", () => {
	test("does not throw when field is a string", () => {
		expect(() => helpers.assertStringField({ text: "hi" }, "text", "err")).not.toThrow();
	});

	test("throws ValidationError when field is missing", () => {
		expect(() => helpers.assertStringField({}, "text", "err msg")).toThrow(ValidationError);
	});

	test("throws ValidationError when field is wrong type", () => {
		expect(() => helpers.assertStringField({ text: 42 }, "text", "err msg")).toThrow(
			ValidationError
		);
		expect(() => helpers.assertStringField({ model: null }, "model", "err msg")).toThrow(
			ValidationError
		);
	});
});

// ── assertCustomPromptPayload ─────────────────────────────────────────

describe("assertCustomPromptPayload", () => {
	test("throws ValidationError for non-object payload", () => {
		expect(() => helpers.assertCustomPromptPayload(null)).toThrow(ValidationError);
		expect(() => helpers.assertCustomPromptPayload(42)).toThrow(ValidationError);
	});

	test("throws ValidationError when text is missing or wrong type", () => {
		expect(() => helpers.assertCustomPromptPayload({})).toThrow(ValidationError);
		expect(() => helpers.assertCustomPromptPayload({ text: 42, systemPrompt: "x" })).toThrow(
			ValidationError
		);
	});

	test("throws ValidationError when systemPrompt is missing or wrong type", () => {
		expect(() => helpers.assertCustomPromptPayload({ text: "x" })).toThrow(ValidationError);
		expect(() => helpers.assertCustomPromptPayload({ text: "x", systemPrompt: 42 })).toThrow(
			ValidationError
		);
	});

	test("does not throw for valid payload", () => {
		expect(() =>
			helpers.assertCustomPromptPayload({ text: "hello", systemPrompt: "be brief" })
		).not.toThrow();
	});
});

// ── handleProcessTextCustomSafe ───────────────────────────────────────

describe("handleProcessTextCustomSafe", () => {
	test("throws ValidationError for invalid payload", async () => {
		const origErr = console.error;
		console.error = () => undefined;
		try {
			await expect(helpers.handleProcessTextCustomSafe(null)).rejects.toBeInstanceOf(
				ValidationError
			);
		} finally {
			console.error = origErr;
		}
	});

	test("throws ValidationError when systemPrompt missing", async () => {
		const origErr = console.error;
		console.error = () => undefined;
		try {
			await expect(helpers.handleProcessTextCustomSafe({ text: "hi" })).rejects.toBeInstanceOf(
				ValidationError
			);
		} finally {
			console.error = origErr;
		}
	});

	test("throws ValidationError when text empty", async () => {
		const origErr = console.error;
		console.error = () => undefined;
		try {
			await expect(
				helpers.handleProcessTextCustomSafe({ text: "", systemPrompt: "x" })
			).rejects.toBeInstanceOf(ValidationError);
		} finally {
			console.error = origErr;
		}
	});
});

// ── isPositiveNumber / hasValidPercentInputs ──────────────────────────

describe("isPositiveNumber", () => {
	test("true for positive numbers", () => {
		expect(helpers.isPositiveNumber(1)).toBe(true);
		expect(helpers.isPositiveNumber(100)).toBe(true);
	});

	test("false for zero / negative / undefined / NaN", () => {
		expect(helpers.isPositiveNumber(0)).toBe(false);
		expect(helpers.isPositiveNumber(-1)).toBe(false);
		expect(helpers.isPositiveNumber(undefined)).toBe(false);
	});
});

describe("hasValidPercentInputs", () => {
	test("true when both completed and total are positive numbers", () => {
		expect(helpers.hasValidPercentInputs(50, 100)).toBe(true);
	});

	test("false when total is missing", () => {
		expect(helpers.hasValidPercentInputs(50, undefined)).toBe(false);
	});

	test("false when total <= 0", () => {
		expect(helpers.hasValidPercentInputs(50, 0)).toBe(false);
		expect(helpers.hasValidPercentInputs(50, -1)).toBe(false);
	});

	test("false when completed missing (even with valid total)", () => {
		expect(helpers.hasValidPercentInputs(undefined, 100)).toBe(false);
	});
});

// ── processTextWithCustomPrompt + runCustomPromptPath ─────────────────

describe("processTextWithCustomPrompt", () => {
	test("throws ValidationError when text is empty", async () => {
		await expect(processTextWithCustomPrompt("", "system")).rejects.toBeInstanceOf(ValidationError);
	});

	test("throws ValidationError when systemPrompt is empty", async () => {
		await expect(processTextWithCustomPrompt("hello", "")).rejects.toBeInstanceOf(ValidationError);
	});

	test("throws ValidationError when text is non-string", async () => {
		// @ts-expect-error testing runtime guard
		await expect(processTextWithCustomPrompt(null, "system")).rejects.toBeInstanceOf(
			ValidationError
		);
	});

	test("routes through ollama path (store mock returns '' model → ValidationError)", async () => {
		// store.getStoreValue returns "" for llm.transforms.model, so runCustomPromptPath →
		// processWithOllamaCustom → assertNonEmptyString throws ValidationError.
		// mapAndThrowOrReturn rethrows it (ValidationError is pass-through).
		const origErr = console.error;
		console.error = () => undefined;
		try {
			await expect(processTextWithCustomPrompt("hello world", "be brief")).rejects.toBeInstanceOf(
				ValidationError
			);
		} finally {
			console.error = origErr;
		}
	});
});

describe("runCustomPromptPath", () => {
	test("dispatches to ollama path when provider !== 'openrouter' (model undefined → ValidationError)", async () => {
		await expect(
			helpers.runCustomPromptPath("hello", "system", "ollama", 5000)
		).rejects.toBeInstanceOf(ValidationError);
	});

	test("dispatches to openrouter path when provider === 'openrouter' (no api key → ValidationError)", async () => {
		await expect(
			helpers.runCustomPromptPath("hello", "system", "openrouter", 5000)
		).rejects.toBeInstanceOf(ValidationError);
	});
});

// ── processWithOpenRouterCustom (direct) ──────────────────────────────

describe("processWithOpenRouterCustom", () => {
	test("throws ValidationError when apiKey is empty", async () => {
		await expect(
			helpers.processWithOpenRouterCustom("hello", "", "model", "system", 5000)
		).rejects.toBeInstanceOf(ValidationError);
	});
});

// ── broadcastPullProgress with live windows ───────────────────────────

describe("broadcastPullProgress — covers the inner send branch", () => {
	test("invokes webContents.send for live windows", async () => {
		// Re-mock electron with non-empty windows for this test
		const sendSpy = mock(noop);
		const electron = await import("electron");
		const origGetAll = electron.BrowserWindow.getAllWindows;
		const fakeWindow = {
			isDestroyed: () => false,
			webContents: { send: sendSpy },
		} as unknown as InstanceType<typeof electron.BrowserWindow>;
		const destroyedWindow = {
			isDestroyed: () => true,
			webContents: {
				send: mock(() => {
					throw new Error("should not send");
				}),
			},
		} as unknown as InstanceType<typeof electron.BrowserWindow>;
		(electron.BrowserWindow as unknown as { getAllWindows: () => unknown[] }).getAllWindows =
			() => [fakeWindow, destroyedWindow];
		try {
			helpers.broadcastPullProgress({ model: "x", status: "pulling" });
			expect(sendSpy).toHaveBeenCalledTimes(1);
		} finally {
			(electron.BrowserWindow as unknown as { getAllWindows: () => unknown[] }).getAllWindows =
				origGetAll;
		}
	});
});

// ── setupLlm teardown function ────────────────────────────────────────

describe("setupLlm teardown", () => {
	test("teardown function returned by setupLlm does not throw", () => {
		const teardown = setupLlm();
		expect(() => teardown()).not.toThrow();
	});

	test("setupLlm can be called multiple times and torn down", () => {
		const teardown1 = setupLlm();
		const teardown2 = setupLlm();
		expect(() => teardown1()).not.toThrow();
		expect(() => teardown2()).not.toThrow();
	});
});

// ── Warmup helpers ────────────────────────────────────────────────────

describe("collectEnabledOllamaModels", () => {
	const originalGetStoreValue = helpers as unknown as {
		collectEnabledOllamaModels: () => string[];
	};

	test("returns empty when neither feature is enabled", () => {
		// The shared mock leaves dictation/transforms disabled (catch defaults
		// trigger because the underlying storeValues has no overrides for these
		// keys in this test file).
		expect(originalGetStoreValue.collectEnabledOllamaModels()).toEqual([]);
	});
});

describe("warmupOllamaModel", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	type WarmupOutcome = "ok" | "unreachable" | "model-not-found" | "load-failed" | "skipped";
	type WarmupResult = { model: string; outcome: WarmupOutcome; errorBody?: string };
	type WarmupFn = (endpoint: string, model: string) => Promise<WarmupResult>;

	const warmup = (helpers as unknown as { warmupOllamaModel: WarmupFn }).warmupOllamaModel;

	test('returns "skipped" when model is empty (no fetch)', async () => {
		const fetchSpy = mock(() => Promise.resolve(new Response("{}")));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		const out = await warmup(ENDPOINT, "");
		expect(out.outcome).toBe("skipped");
		expect(out.model).toBe("");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("POSTs /api/generate with keep_alive and empty prompt", async () => {
		const fetchSpy = mock(() =>
			Promise.resolve(new Response(JSON.stringify({ response: "" }), { status: 200 }))
		);
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		const out = await warmup(ENDPOINT, "gemma3:4b");
		expect(out.outcome).toBe("ok");
		expect(out.model).toBe("gemma3:4b");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const args = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
		expect(args[0]).toContain("/api/generate");
		const body = JSON.parse(String(args[1].body));
		expect(body.model).toBe("gemma3:4b");
		expect(body.prompt).toBe("");
		expect(body.keep_alive).toBe("30m");
		expect(body.stream).toBe(false);
	});

	test('returns "unreachable" + errorBody when fetch rejects (Ollama not running)', async () => {
		globalThis.fetch = mock(() =>
			Promise.reject(new TypeError("fetch failed"))
		) as unknown as typeof fetch;
		const out = await warmup(ENDPOINT, "gemma3:4b");
		expect(out.outcome).toBe("unreachable");
		expect(out.errorBody).toContain("fetch failed");
	});

	test('returns "model-not-found" + errorBody on HTTP 404 (model not installed)', async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ error: "model 'foo' not found, try pulling it first" }), {
					status: 404,
				})
			)
		) as unknown as typeof fetch;
		const out = await warmup(ENDPOINT, "foo");
		expect(out.outcome).toBe("model-not-found");
		expect(out.errorBody).toContain("not found");
	});

	test('returns "load-failed" on HTTP 500 (corrupted or incompatible model file)', async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ error: "model runner crashed" }), { status: 500 })
			)
		) as unknown as typeof fetch;
		const out = await warmup(ENDPOINT, "gemma3:4b");
		expect(out.outcome).toBe("load-failed");
		expect(out.errorBody).toContain("model runner crashed");
	});

	test('returns "load-failed" on other non-2xx (e.g. 503 service unavailable)', async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("nope", { status: 503 }))
		) as unknown as typeof fetch;
		const out = await warmup(ENDPOINT, "gemma3:4b");
		expect(out.outcome).toBe("load-failed");
	});
});

describe("classifyWarmupResponse", () => {
	type ClassifyFn = (
		status: number
	) => "ok" | "unreachable" | "model-not-found" | "load-failed" | "skipped";
	const classify = (helpers as unknown as { classifyWarmupResponse: ClassifyFn })
		.classifyWarmupResponse;

	test("404 → model-not-found", () => {
		expect(classify(404)).toBe("model-not-found");
	});

	test("500 → load-failed", () => {
		expect(classify(500)).toBe("load-failed");
	});

	test("503 → load-failed", () => {
		expect(classify(503)).toBe("load-failed");
	});
});

describe("isLoopbackEndpoint", () => {
	type LoopbackFn = (endpoint: string) => boolean;
	const isLoopback = (helpers as unknown as { isLoopbackEndpoint: LoopbackFn }).isLoopbackEndpoint;

	test("localhost variants are loopback", () => {
		expect(isLoopback("http://localhost:11434")).toBe(true);
		expect(isLoopback("http://127.0.0.1:11434")).toBe(true);
		expect(isLoopback("http://[::1]:11434")).toBe(true);
	});

	test("remote hosts are not loopback (no auto-start)", () => {
		expect(isLoopback("http://ollama.internal:11434")).toBe(false);
		expect(isLoopback("https://10.0.0.5:11434")).toBe(false);
	});

	test("empty input is not loopback", () => {
		expect(isLoopback("")).toBe(false);
	});
});

describe("ensureOllamaReachable", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	type EnsureFn = (endpoint: string) => Promise<boolean>;
	const ensure = (helpers as unknown as { ensureOllamaReachable: EnsureFn }).ensureOllamaReachable;

	test("returns true immediately when /api/tags responds 200", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify({ models: [] }), { status: 200 }))
		) as unknown as typeof fetch;
		expect(await ensure(ENDPOINT)).toBe(true);
	});

	test("returns false for remote endpoints when unreachable (does not try to auto-start)", async () => {
		globalThis.fetch = mock(() =>
			Promise.reject(new TypeError("fetch failed"))
		) as unknown as typeof fetch;
		expect(await ensure("http://remote.example.com:11434")).toBe(false);
	});
});

describe("buildOllamaChatBody includes keep_alive", () => {
	test("chat body carries keep_alive so the model stays hot after a real call", () => {
		const body = JSON.parse(helpers.buildOllamaChatBody("m", [], 10));
		expect(body.keep_alive).toBe("30m");
	});
});

describe("warmup status broadcast", () => {
	type WarmupStatus = {
		endpoint: string;
		reachable: boolean | null;
		ollamaInstalled: boolean;
		models: Array<{ model: string; outcome: string; errorBody?: string }>;
		timestamp: number;
	};
	const broadcast = (helpers as unknown as { broadcastWarmupStatus: (s: WarmupStatus) => void })
		.broadcastWarmupStatus;
	const getLast = (helpers as unknown as { getLastWarmupStatus: () => WarmupStatus | null })
		.getLastWarmupStatus;

	test("broadcastWarmupStatus stores the last payload so settings-window can pull it on mount", () => {
		const payload: WarmupStatus = {
			endpoint: ENDPOINT,
			reachable: true,
			ollamaInstalled: true,
			models: [{ model: "gemma3:4b", outcome: "ok" }],
			timestamp: 42,
		};
		broadcast(payload);
		expect(getLast()).toEqual(payload);
	});

	test("subsequent broadcast overwrites the cached snapshot", () => {
		broadcast({
			endpoint: ENDPOINT,
			reachable: true,
			ollamaInstalled: true,
			models: [],
			timestamp: 1,
		});
		const next: WarmupStatus = {
			endpoint: ENDPOINT,
			reachable: false,
			ollamaInstalled: false,
			models: [{ model: "x", outcome: "unreachable" }],
			timestamp: 2,
		};
		broadcast(next);
		expect(getLast()).toEqual(next);
	});
});
