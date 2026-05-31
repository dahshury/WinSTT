import { describe, expect, test } from "bun:test";
import { buildOllamaApiUrl, normalizeOllamaEndpoint } from "../../src/shared/lib/ollama-endpoint";

describe("normalizeOllamaEndpoint", () => {
	test("keeps plain host endpoint unchanged", () => {
		expect(normalizeOllamaEndpoint("http://localhost:11434")).toBe("http://localhost:11434");
	});

	test("strips trailing slash", () => {
		expect(normalizeOllamaEndpoint("http://localhost:11434/")).toBe("http://localhost:11434");
	});

	test("strips /api suffix", () => {
		expect(normalizeOllamaEndpoint("http://localhost:11434/api")).toBe("http://localhost:11434");
	});

	test("strips /v1 suffix", () => {
		expect(normalizeOllamaEndpoint("http://localhost:11434/v1")).toBe("http://localhost:11434");
	});

	test("trims surrounding whitespace", () => {
		expect(normalizeOllamaEndpoint("  http://localhost:11434/api/  ")).toBe(
			"http://localhost:11434"
		);
	});
});

describe("buildOllamaApiUrl", () => {
	test("builds tags URL from plain host", () => {
		expect(buildOllamaApiUrl("http://localhost:11434", "/api/tags")).toBe(
			"http://localhost:11434/api/tags"
		);
	});

	test("builds chat URL from /api endpoint without duplicating path", () => {
		expect(buildOllamaApiUrl("http://localhost:11434/api", "/api/chat")).toBe(
			"http://localhost:11434/api/chat"
		);
	});

	test("builds chat URL from /v1 endpoint without leaking OpenAI path", () => {
		expect(buildOllamaApiUrl("http://localhost:11434/v1/", "/api/chat")).toBe(
			"http://localhost:11434/api/chat"
		);
	});
});
