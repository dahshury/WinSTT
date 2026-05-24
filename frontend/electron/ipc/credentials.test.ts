import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	authHeadersFor,
	classifyHttpStatus,
	handleVerifyInvocation,
	isVerifyPayload,
	probeUrlFor,
	verifyCredential,
} from "./credentials";

describe("isVerifyPayload", () => {
	test("accepts openai with a string apiKey", () => {
		expect(isVerifyPayload({ provider: "openai", apiKey: "sk-..." })).toBe(true);
	});

	test("accepts elevenlabs with a string apiKey (even empty)", () => {
		expect(isVerifyPayload({ provider: "elevenlabs", apiKey: "" })).toBe(true);
	});

	test("accepts openrouter with a string apiKey", () => {
		// OpenRouter is an LLM credential rather than an STT provider, but the
		// IPC accepts it so the Integrations panel can drive its auto-validate
		// flow through the same handler.
		expect(isVerifyPayload({ provider: "openrouter", apiKey: "sk-or-..." })).toBe(true);
	});

	test("rejects unknown providers", () => {
		expect(isVerifyPayload({ provider: "anthropic", apiKey: "x" })).toBe(false);
		expect(isVerifyPayload({ provider: "google", apiKey: "x" })).toBe(false);
	});

	test("rejects non-string apiKey", () => {
		expect(isVerifyPayload({ provider: "openai", apiKey: 123 })).toBe(false);
		expect(isVerifyPayload({ provider: "openai" })).toBe(false);
	});

	test("rejects non-objects", () => {
		expect(isVerifyPayload(null)).toBe(false);
		expect(isVerifyPayload("openai")).toBe(false);
		expect(isVerifyPayload(undefined)).toBe(false);
	});
});

describe("probeUrlFor", () => {
	test("returns the OpenAI /v1/models endpoint", () => {
		expect(probeUrlFor("openai")).toBe("https://api.openai.com/v1/models");
	});

	test("returns the ElevenLabs /v1/user endpoint", () => {
		expect(probeUrlFor("elevenlabs")).toBe("https://api.elevenlabs.io/v1/user");
	});

	test("returns the OpenRouter /v1/auth/key endpoint", () => {
		expect(probeUrlFor("openrouter")).toBe("https://openrouter.ai/api/v1/auth/key");
	});
});

describe("authHeadersFor", () => {
	test("OpenAI uses Bearer auth", () => {
		expect(authHeadersFor("openai", "sk-test")).toEqual({
			Authorization: "Bearer sk-test",
		});
	});

	test("ElevenLabs uses the xi-api-key header (NOT Bearer)", () => {
		// Regression guard: ElevenLabs auth is incompatible with Bearer; using
		// Authorization: Bearer here would silently return 401 on every call.
		expect(authHeadersFor("elevenlabs", "el-test")).toEqual({
			"xi-api-key": "el-test",
		});
	});

	test("OpenRouter uses Bearer auth", () => {
		expect(authHeadersFor("openrouter", "sk-or-test")).toEqual({
			Authorization: "Bearer sk-or-test",
		});
	});
});

describe("classifyHttpStatus", () => {
	test("401/403 → auth", () => {
		expect(classifyHttpStatus(401)).toBe("auth");
		expect(classifyHttpStatus(403)).toBe("auth");
	});

	test("429 → rate_limit", () => {
		expect(classifyHttpStatus(429)).toBe("rate_limit");
	});

	test("everything else → provider_error", () => {
		expect(classifyHttpStatus(500)).toBe("provider_error");
		expect(classifyHttpStatus(502)).toBe("provider_error");
		expect(classifyHttpStatus(404)).toBe("provider_error");
	});
});

describe("verifyCredential", () => {
	let originalFetch: typeof fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("empty apiKey short-circuits to auth error (no network call)", async () => {
		const fetchMock = mock(() => Promise.reject(new Error("should not fire")));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const result = await verifyCredential("openai", "");
		expect(result).toEqual({ ok: false, code: "auth", message: "API key is empty" });
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	test("trims whitespace before deciding empty", async () => {
		const fetchMock = mock(() => Promise.reject(new Error("should not fire")));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const result = await verifyCredential("openai", "   ");
		expect(result.ok).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	test("200 response → ok", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ data: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})
			)
		) as unknown as typeof fetch;
		const result = await verifyCredential("openai", "sk-good");
		expect(result).toEqual({ ok: true });
	});

	test("401 → auth error", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("Invalid Authentication", { status: 401 }))
		) as unknown as typeof fetch;
		const result = await verifyCredential("openai", "sk-bad");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("auth");
		}
	});

	test("429 → rate_limit", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("Too Many", { status: 429 }))
		) as unknown as typeof fetch;
		const result = await verifyCredential("elevenlabs", "el-key");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("rate_limit");
		}
	});

	test("fetch rejection → network error", async () => {
		globalThis.fetch = mock(() =>
			Promise.reject(new TypeError("ENETUNREACH"))
		) as unknown as typeof fetch;
		const result = await verifyCredential("openai", "sk-anything");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("network");
		}
	});
});

describe("handleVerifyInvocation", () => {
	let originalFetch: typeof fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("returns invalid-payload error when payload shape is wrong", async () => {
		const result = await handleVerifyInvocation({ provider: "bad", apiKey: 42 });
		expect(result).toEqual({
			ok: false,
			code: "provider_error",
			message: "Invalid verify payload",
		});
	});

	test("returns invalid-payload error when payload is null", async () => {
		const result = await handleVerifyInvocation(null);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("provider_error");
		}
	});

	test("delegates to verifyCredential when payload is valid", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("ok", { status: 200 }))
		) as unknown as typeof fetch;
		const result = await handleVerifyInvocation({
			provider: "openai",
			apiKey: "sk-good",
		});
		expect(result.ok).toBe(true);
	});
});
