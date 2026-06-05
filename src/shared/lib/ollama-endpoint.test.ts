import { describe, expect, test } from "bun:test";
import { buildOllamaApiUrl, normalizeOllamaEndpoint } from "./ollama-endpoint";

describe("normalizeOllamaEndpoint", () => {
	test("returns empty string for empty input", () => {
		expect(normalizeOllamaEndpoint("")).toBe("");
	});

	test("trims whitespace before processing", () => {
		expect(normalizeOllamaEndpoint("   ")).toBe("");
		expect(normalizeOllamaEndpoint("  http://localhost:11434  ")).toBe("http://localhost:11434");
	});

	test("strips trailing slash", () => {
		expect(normalizeOllamaEndpoint("http://localhost:11434/")).toBe("http://localhost:11434");
	});

	test("strips trailing /api", () => {
		expect(normalizeOllamaEndpoint("http://localhost:11434/api")).toBe("http://localhost:11434");
	});

	test("strips trailing /api case-insensitively (uppercase /API also stripped)", () => {
		// Locks in the `i` flag on TRAILING_API_PATH — without it /API survives
		expect(normalizeOllamaEndpoint("http://localhost:11434/API")).toBe("http://localhost:11434");
		expect(normalizeOllamaEndpoint("http://localhost:11434/V1")).toBe("http://localhost:11434");
		expect(normalizeOllamaEndpoint("http://localhost:11434/Api")).toBe("http://localhost:11434");
	});

	test("strips trailing /v1", () => {
		expect(normalizeOllamaEndpoint("http://localhost:11434/v1")).toBe("http://localhost:11434");
	});

	test("strips trailing /api/ with slash", () => {
		expect(normalizeOllamaEndpoint("http://localhost:11434/api/")).toBe("http://localhost:11434");
	});

	test("strips multiple stacked /api or /v1 segments", () => {
		expect(normalizeOllamaEndpoint("http://localhost:11434/api/v1")).toBe("http://localhost:11434");
		expect(normalizeOllamaEndpoint("http://localhost:11434/v1/api")).toBe("http://localhost:11434");
	});

	test("removes search params and hash", () => {
		expect(normalizeOllamaEndpoint("http://localhost:11434?token=abc")).toBe(
			"http://localhost:11434"
		);
		expect(normalizeOllamaEndpoint("http://localhost:11434#x")).toBe("http://localhost:11434");
	});

	test("preserves path when path is not /api or /v1", () => {
		expect(normalizeOllamaEndpoint("http://localhost:11434/proxy")).toBe(
			"http://localhost:11434/proxy"
		);
	});

	test("preserves /api or /v1 when they appear MID-path (mutator-killer for the regex `$` anchor)", () => {
		// The TRAILING_API_PATH regex anchors to end-of-string with `$`. A
		// middle-of-path /api segment must NOT be stripped. Without the `$`
		// the regex would match anywhere → strip the wrong segment.
		expect(normalizeOllamaEndpoint("http://localhost:11434/api/proxy")).toBe(
			"http://localhost:11434/api/proxy"
		);
		expect(normalizeOllamaEndpoint("http://localhost:11434/v1/something")).toBe(
			"http://localhost:11434/v1/something"
		);
	});

	test("handles invalid URL gracefully (still strips trailing /api & slashes)", () => {
		expect(normalizeOllamaEndpoint("not-a-url/api")).toBe("not-a-url");
		expect(normalizeOllamaEndpoint("not-a-url//")).toBe("not-a-url");
	});

	test("handles whitespace before trailing slashes in invalid URLs in one pass", () => {
		expect(normalizeOllamaEndpoint("! /")).toBe("!");
		expect(normalizeOllamaEndpoint("not-a-url /api")).toBe("not-a-url");
	});

	test("preserves https scheme and port", () => {
		expect(normalizeOllamaEndpoint("https://example.com:8443/api")).toBe(
			"https://example.com:8443"
		);
	});
});

describe("buildOllamaApiUrl", () => {
	test("appends api path to root host", () => {
		expect(buildOllamaApiUrl("http://localhost:11434", "/api/tags")).toBe(
			"http://localhost:11434/api/tags"
		);
	});

	test("when url.pathname is exactly '/' the basePath is '' (no double slashes)", () => {
		// Locks in the `url.pathname === "/" ? "" : ...` branch — without
		// the empty-string fallback, /api/tags would become //api/tags.
		expect(buildOllamaApiUrl("http://localhost:11434/", "/api/tags")).toBe(
			"http://localhost:11434/api/tags"
		);
	});

	test("apiPath without a leading slash gets one prepended at runtime", () => {
		// The TS type forces leading "/" but the code defends against the
		// runtime case via `apiPath.startsWith("/") ? apiPath : "/${apiPath}"`.
		expect(buildOllamaApiUrl("http://localhost:11434", "api/show" as `/api/${string}`)).toBe(
			"http://localhost:11434/api/show"
		);
	});

	test("invalid-URL fallback path STILL produces a slash-separated apiPath (kills L40 prepend-slash mutant)", () => {
		// On the URL-parse failure (catch) path, `url.pathname` auto-normalization
		// is unavailable, so the prepend-slash logic on L40 is the only thing
		// keeping the URL well-formed. With a no-leading-slash apiPath that hits
		// the catch path, removing L40's prepend would produce "not-a-urlapi/tags".
		expect(buildOllamaApiUrl("not-a-url", "api/tags" as `/api/${string}`)).toBe(
			"not-a-url/api/tags"
		);
	});

	test("strips redundant /api before re-appending", () => {
		expect(buildOllamaApiUrl("http://localhost:11434/api", "/api/tags")).toBe(
			"http://localhost:11434/api/tags"
		);
	});

	test("preserves base path on proxied endpoints", () => {
		expect(buildOllamaApiUrl("http://localhost/proxy", "/api/tags")).toBe(
			"http://localhost/proxy/api/tags"
		);
	});

	test("handles invalid URL via fallback string concatenation", () => {
		expect(buildOllamaApiUrl("not-a-url", "/api/tags")).toBe("not-a-url/api/tags");
	});

	test("handles path without leading slash by adding one", () => {
		// The arg type forces leading '/api/...' but exercise the runtime path anyway
		expect(buildOllamaApiUrl("http://localhost:11434", "/api/show" as `/api/${string}`)).toBe(
			"http://localhost:11434/api/show"
		);
	});
});
