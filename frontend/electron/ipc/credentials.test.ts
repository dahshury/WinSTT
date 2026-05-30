import { afterEach, beforeEach, describe, expect, type Mock, mock, test } from "bun:test";
import { debugLogMock } from "@test/mocks/debug-log";
import { electronMock } from "@test/mocks/electron";

// credentials.ts pulls `ipcMain` (electron) and `dbg` (electron-log) at module
// load. Shim both BEFORE importing it so the suite runs in isolation rather
// than only when a sibling suite happens to register the electron mock first
// (the prior static import was hoisted ahead of any mock → "Export named 'app'
// not found"). Dynamic import after the mocks mirrors tts-cloud.test.ts.
mock.module("electron", () => electronMock());
mock.module("../lib/debug-log", () => debugLogMock());

const {
	authHeadersFor,
	classifyHttpStatus,
	handleVerifyInvocation,
	isElevenLabsScopedKeyValid,
	isVerifyPayload,
	probeUrlFor,
	verifyCredential,
} = await import("./credentials");

// Real ElevenLabs 401 bodies (captured from the live API 2026-05-30).
const EL_MISSING_PERMISSIONS = JSON.stringify({
	detail: {
		status: "missing_permissions",
		message: "The API key you used is missing the permission user_read to execute this operation.",
	},
});
const EL_INVALID_API_KEY = JSON.stringify({
	detail: { status: "invalid_api_key", message: "Invalid API key" },
});
const EL_NEEDS_AUTHORIZATION = JSON.stringify({
	detail: {
		status: "needs_authorization",
		message: "Neither authorization header nor xi-api-key received.",
	},
});

// Contained boundary cast: a Bun mock fn stands in for the real global `fetch`.
// The runtime value is returned unchanged — only the static type is widened.
const asFetch = <T extends (...args: never[]) => unknown>(m: Mock<T>) =>
	m as unknown as typeof fetch;

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

describe("isElevenLabsScopedKeyValid", () => {
	test("missing_permissions 401 → valid (key authenticated, just scoped)", () => {
		expect(isElevenLabsScopedKeyValid(401, EL_MISSING_PERMISSIONS)).toBe(true);
	});

	test("invalid_api_key 401 → not valid", () => {
		expect(isElevenLabsScopedKeyValid(401, EL_INVALID_API_KEY)).toBe(false);
	});

	test("needs_authorization 401 → not valid", () => {
		expect(isElevenLabsScopedKeyValid(401, EL_NEEDS_AUTHORIZATION)).toBe(false);
	});

	test("non-401 statuses are never treated as scoped-but-valid", () => {
		expect(isElevenLabsScopedKeyValid(403, EL_MISSING_PERMISSIONS)).toBe(false);
		expect(isElevenLabsScopedKeyValid(429, EL_MISSING_PERMISSIONS)).toBe(false);
	});

	test("non-JSON / empty body → not valid (no false positive)", () => {
		expect(isElevenLabsScopedKeyValid(401, "")).toBe(false);
		expect(isElevenLabsScopedKeyValid(401, "Unauthorized")).toBe(false);
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
		globalThis.fetch = asFetch(fetchMock);
		const result = await verifyCredential("openai", "");
		expect(result).toEqual({ ok: false, code: "auth", message: "API key is empty" });
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	test("trims whitespace before deciding empty", async () => {
		const fetchMock = mock(() => Promise.reject(new Error("should not fire")));
		globalThis.fetch = asFetch(fetchMock);
		const result = await verifyCredential("openai", "   ");
		expect(result.ok).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	test("200 response → ok", async () => {
		globalThis.fetch = asFetch(
			mock(() =>
				Promise.resolve(
					new Response(JSON.stringify({ data: [] }), {
						status: 200,
						headers: { "content-type": "application/json" },
					})
				)
			)
		);
		const result = await verifyCredential("openai", "sk-good");
		expect(result).toEqual({ ok: true });
	});

	test("401 → auth error", async () => {
		globalThis.fetch = asFetch(
			mock(() => Promise.resolve(new Response("Invalid Authentication", { status: 401 })))
		);
		const result = await verifyCredential("openai", "sk-bad");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("auth");
		}
	});

	test("429 → rate_limit", async () => {
		globalThis.fetch = asFetch(
			mock(() => Promise.resolve(new Response("Too Many", { status: 429 })))
		);
		const result = await verifyCredential("elevenlabs", "el-key");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("rate_limit");
		}
	});

	test("ElevenLabs scoped key (401 missing_permissions) → ok", async () => {
		// Regression guard for the false "invalid key": a TTS-only key 401s on the
		// /v1/user probe but is perfectly valid. It must verify as ok.
		globalThis.fetch = asFetch(
			mock(() => Promise.resolve(new Response(EL_MISSING_PERMISSIONS, { status: 401 })))
		);
		const result = await verifyCredential("elevenlabs", "sk_scoped");
		expect(result).toEqual({ ok: true });
	});

	test("ElevenLabs genuinely-bad key (401 invalid_api_key) → auth error", async () => {
		globalThis.fetch = asFetch(
			mock(() => Promise.resolve(new Response(EL_INVALID_API_KEY, { status: 401 })))
		);
		const result = await verifyCredential("elevenlabs", "sk_bogus");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("auth");
		}
	});

	test("OpenAI 401 missing_permissions-shaped body is NOT excused (EL-only rule)", async () => {
		// The scoped-key escape hatch is ElevenLabs-specific; an OpenAI 401 with a
		// look-alike body must still classify as an auth failure.
		globalThis.fetch = asFetch(
			mock(() => Promise.resolve(new Response(EL_MISSING_PERMISSIONS, { status: 401 })))
		);
		const result = await verifyCredential("openai", "sk-whatever");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("auth");
		}
	});

	test("fetch rejection → network error", async () => {
		globalThis.fetch = asFetch(mock(() => Promise.reject(new TypeError("ENETUNREACH"))));
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
		globalThis.fetch = asFetch(mock(() => Promise.resolve(new Response("ok", { status: 200 }))));
		const result = await handleVerifyInvocation({
			provider: "openai",
			apiKey: "sk-good",
		});
		expect(result.ok).toBe(true);
	});
});
