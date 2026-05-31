import { beforeEach, describe, expect, mock, test } from "bun:test";
import { debugLogMock } from "@test/mocks/debug-log";
import { electronMock } from "@test/mocks/electron";
import { storeMock } from "@test/mocks/store";

// tts-cloud.ts pulls `dbg` (electron-log) transitively, which expects a real
// app surface under bun:test — shim `electron` the same way the other ipc
// suites do.
mock.module("electron", () => electronMock());

// `loadCloudSettings` / `handleCloudListVoices` read the api key + tuning from
// the electron-store via `../lib/store`. Spread the canonical mock and only
// override `getStoreValue` (a partial shim breaks downstream consumers that
// expect the full surface in the whole-suite run).
const storeStub: { values: Record<string, unknown> } = { values: {} };
mock.module("../lib/store", () => ({
	...storeMock(),
	getStoreValue: (key: string) => storeStub.values[key],
}));

mock.module("../lib/debug-log", () => debugLogMock());

const { APICallError } = await import("ai");
const ttsCloud = await import("./tts-cloud");
const {
	asStringOrNull,
	buildVoiceSettings,
	classifyAiSdkError,
	classifyHttpError,
	classifyVoiceCatalogError,
	describeApiError,
	fetchVoicePreview,
	mapVoice,
	mapVoices,
	parseElevenLabsDetail,
	pickLanguage,
} = ttsCloud;

beforeEach(() => {
	storeStub.values = {};
});

describe("asStringOrNull", () => {
	test("passes strings through", () => {
		expect(asStringOrNull("en")).toBe("en");
		expect(asStringOrNull("")).toBe("");
	});

	test("returns null for non-strings", () => {
		expect(asStringOrNull(undefined)).toBeNull();
		expect(asStringOrNull(null)).toBeNull();
		expect(asStringOrNull(42)).toBeNull();
		expect(asStringOrNull({})).toBeNull();
	});
});

describe("pickLanguage", () => {
	test("prefers labels.language over fine_tuning.language", () => {
		expect(pickLanguage({ labels: { language: "en" }, fine_tuning: { language: "fr" } })).toBe(
			"en"
		);
	});

	test("falls back to fine_tuning.language when labels is absent", () => {
		expect(pickLanguage({ labels: null, fine_tuning: { language: "fr" } })).toBe("fr");
		expect(pickLanguage({ fine_tuning: { language: "de" } })).toBe("de");
	});

	test("returns null when no language is present anywhere", () => {
		expect(pickLanguage({})).toBeNull();
		expect(pickLanguage({ labels: {}, fine_tuning: null })).toBeNull();
	});
});

describe("mapVoice", () => {
	test("maps a full /v2/voices entry", () => {
		const mapped = mapVoice({
			voice_id: "21m00Tcm4TlvDq8ikWAM",
			name: "Rachel",
			labels: { language: "en", accent: "american" },
			category: "premade",
			preview_url: "https://cdn.elevenlabs.io/rachel.mp3",
		});
		expect(mapped).toEqual({
			id: "21m00Tcm4TlvDq8ikWAM",
			name: "Rachel",
			language: "en",
			category: "premade",
			previewUrl: "https://cdn.elevenlabs.io/rachel.mp3",
		});
	});

	test("defaults name to the id, category to 'premade', language/preview to null", () => {
		const mapped = mapVoice({ voice_id: "abc123" });
		expect(mapped).toEqual({
			id: "abc123",
			name: "abc123",
			language: null,
			category: "premade",
			previewUrl: null,
		});
	});

	test("resolves language from fine_tuning when labels is missing", () => {
		const mapped = mapVoice({ voice_id: "x", fine_tuning: { language: "ja" } });
		expect(mapped?.language).toBe("ja");
	});

	test("returns null when voice_id is missing or non-string", () => {
		expect(mapVoice({ name: "No id" })).toBeNull();
		expect(mapVoice({ voice_id: 42 })).toBeNull();
		expect(mapVoice(null)).toBeNull();
		expect(mapVoice("string")).toBeNull();
	});
});

describe("mapVoices", () => {
	const sample = {
		voices: [
			{
				voice_id: "v1",
				name: "Alice",
				labels: { language: "en" },
				category: "premade",
				preview_url: "https://cdn/a.mp3",
			},
			{
				voice_id: "v2",
				name: "Cloned Bob",
				fine_tuning: { language: "es" },
				category: "cloned",
				preview_url: null,
			},
			// Malformed entry — dropped (no voice_id).
			{ name: "ghost" },
		],
	};

	test("maps a /v2/voices payload, dropping malformed entries", () => {
		const voices = mapVoices(sample);
		expect(voices.length).toBe(2);
		expect(voices[0]).toEqual({
			id: "v1",
			name: "Alice",
			language: "en",
			category: "premade",
			previewUrl: "https://cdn/a.mp3",
		});
		expect(voices[1]).toEqual({
			id: "v2",
			name: "Cloned Bob",
			language: "es",
			category: "cloned",
			previewUrl: null,
		});
	});

	test("returns an empty array when the payload shape is wrong", () => {
		expect(mapVoices(null)).toEqual([]);
		expect(mapVoices({})).toEqual([]);
		expect(mapVoices({ voices: "not-an-array" })).toEqual([]);
		expect(mapVoices({ voices: [] })).toEqual([]);
	});
});

describe("classifyHttpError", () => {
	test("401/403 → invalid API key", () => {
		expect(classifyHttpError(401)).toBe("ElevenLabs: invalid API key");
		expect(classifyHttpError(403)).toBe("ElevenLabs: invalid API key");
	});

	test("429 → rate limited", () => {
		expect(classifyHttpError(429)).toBe("ElevenLabs: rate limited");
	});

	test("402 → paid-plan message (cloned / professional voices)", () => {
		expect(classifyHttpError(402)).toContain("paid plan");
	});

	test("everything else → generic HTTP message", () => {
		expect(classifyHttpError(500)).toBe("ElevenLabs error: HTTP 500");
		expect(classifyHttpError(404)).toBe("ElevenLabs error: HTTP 404");
		expect(classifyHttpError(502)).toBe("ElevenLabs error: HTTP 502");
	});
});

describe("parseElevenLabsDetail", () => {
	test("extracts status + message from a real error body", () => {
		const body = JSON.stringify({
			detail: { status: "missing_permissions", message: "missing the permission voices_read" },
		});
		expect(parseElevenLabsDetail(body)).toEqual({
			status: "missing_permissions",
			message: "missing the permission voices_read",
		});
	});

	test("returns null for non-JSON / non-detail bodies", () => {
		expect(parseElevenLabsDetail("nope")).toBeNull();
		expect(parseElevenLabsDetail("")).toBeNull();
		expect(parseElevenLabsDetail(JSON.stringify({ other: 1 }))).toBeNull();
		expect(parseElevenLabsDetail(JSON.stringify({ detail: "str" }))).toBeNull();
	});
});

describe("classifyVoiceCatalogError", () => {
	// `Response` is consumed once; build a fresh one per assertion.
	const elResponse = (status: number, body: string) => new Response(body, { status });

	test("scoped key (401 missing_permissions) → precise permission message, NOT 'invalid key'", async () => {
		const body = JSON.stringify({
			detail: {
				status: "missing_permissions",
				message:
					"The API key you used is missing the permission voices_read to execute this operation.",
			},
		});
		const msg = await classifyVoiceCatalogError(elResponse(401, body));
		expect(msg).toContain("voices_read");
		expect(msg).toContain("Regenerate the key");
		expect(msg).not.toBe("ElevenLabs: invalid API key");
	});

	test("genuinely-bad key (401 invalid_api_key) → invalid API key", async () => {
		const body = JSON.stringify({
			detail: { status: "invalid_api_key", message: "Invalid API key" },
		});
		expect(await classifyVoiceCatalogError(elResponse(401, body))).toBe(
			"ElevenLabs: invalid API key"
		);
	});

	test("401 with unparseable body → invalid API key (status fallback)", async () => {
		expect(await classifyVoiceCatalogError(elResponse(401, "Unauthorized"))).toBe(
			"ElevenLabs: invalid API key"
		);
	});

	test("429 / 500 fall through to the status classifier", async () => {
		expect(await classifyVoiceCatalogError(elResponse(429, ""))).toBe("ElevenLabs: rate limited");
		expect(await classifyVoiceCatalogError(elResponse(500, ""))).toBe("ElevenLabs error: HTTP 500");
	});
});

describe("buildVoiceSettings", () => {
	test("maps stored tuning to the AI SDK camelCase voiceSettings (no speed)", () => {
		// `speed` is passed as the top-level `generateSpeech` arg, so it must NOT
		// appear here — the SDK folds it into `voice_settings.speed` itself.
		expect(
			buildVoiceSettings({
				apiKey: "el-key",
				model: "eleven_multilingual_v2",
				stability: 0.5,
				similarity: 0.75,
				style: 0.1,
				speed: 1.1,
				speakerBoost: true,
			})
		).toEqual({
			stability: 0.5,
			similarityBoost: 0.75,
			style: 0.1,
			useSpeakerBoost: true,
		});
	});
});

describe("classifyAiSdkError", () => {
	function apiError(statusCode: number): InstanceType<typeof APICallError> {
		return new APICallError({
			message: `HTTP ${statusCode}`,
			url: "https://api.elevenlabs.io/v1/text-to-speech/v1",
			requestBodyValues: {},
			statusCode,
		});
	}

	test("maps an APICallError status the same way the catalog fetch does", () => {
		expect(classifyAiSdkError(apiError(401))).toBe("ElevenLabs: invalid API key");
		expect(classifyAiSdkError(apiError(403))).toBe("ElevenLabs: invalid API key");
		expect(classifyAiSdkError(apiError(429))).toBe("ElevenLabs: rate limited");
		expect(classifyAiSdkError(apiError(500))).toBe("ElevenLabs error: HTTP 500");
	});

	function apiErrorWithBody(statusCode: number, body: string): InstanceType<typeof APICallError> {
		return new APICallError({
			message: `HTTP ${statusCode}`,
			url: "https://api.elevenlabs.io/v1/text-to-speech/v1",
			requestBodyValues: {},
			statusCode,
			responseBody: body,
		});
	}

	test("prefers the body's detail.status over the HTTP code", () => {
		// quota_exceeded comes back as a 401, but it's really out-of-credits.
		expect(
			classifyAiSdkError(apiErrorWithBody(401, '{"detail":{"status":"quota_exceeded"}}'))
		).toContain("out of credits");
		// a deleted/missing voice → a "pick another" message.
		expect(
			classifyAiSdkError(apiErrorWithBody(400, '{"detail":{"status":"voice_not_found"}}'))
		).toContain("no longer exists");
	});

	test("falls through to the raw message for non-APICallError failures", () => {
		expect(classifyAiSdkError(new Error("socket hang up"))).toBe("socket hang up");
		expect(classifyAiSdkError(new TypeError("fetch failed"))).toBe("fetch failed");
	});
});

describe("computeCreditsExhausted", () => {
	test("true when used >= limit and overage is off", () => {
		expect(ttsCloud.computeCreditsExhausted({ character_count: 100, character_limit: 100 })).toBe(
			true
		);
		expect(ttsCloud.computeCreditsExhausted({ character_count: 150, character_limit: 100 })).toBe(
			true
		);
	});

	test("false when quota remains, overage on, or fields missing", () => {
		expect(ttsCloud.computeCreditsExhausted({ character_count: 10, character_limit: 100 })).toBe(
			false
		);
		expect(
			ttsCloud.computeCreditsExhausted({
				character_count: 100,
				character_limit: 100,
				can_extend_character_limit: true,
			})
		).toBe(false);
		expect(ttsCloud.computeCreditsExhausted({ tier: "free" })).toBe(false);
		expect(ttsCloud.computeCreditsExhausted({})).toBe(false);
	});
});

describe("describeApiError", () => {
	test("includes the HTTP status and response body for an APICallError", () => {
		const err = new APICallError({
			message: "Payment Required",
			url: "https://api.elevenlabs.io/v1/text-to-speech/v/stream",
			requestBodyValues: {},
			statusCode: 402,
			responseBody: '{"detail":{"status":"quota_exceeded"}}',
		});
		const out = describeApiError(err);
		expect(out).toContain("HTTP 402");
		expect(out).toContain("quota_exceeded");
	});

	test("returns the status alone when the body is empty", () => {
		const err = new APICallError({
			message: "x",
			url: "https://api.elevenlabs.io",
			requestBodyValues: {},
			statusCode: 402,
		});
		expect(describeApiError(err)).toBe(" [HTTP 402]");
	});

	test("returns an empty string for a non-APICallError", () => {
		expect(describeApiError(new Error("nope"))).toBe("");
	});
});

describe("fetchVoicePreview", () => {
	let originalFetch: typeof fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	const asFetch = (m: () => Promise<Response>): typeof fetch => m as unknown as typeof fetch;

	test("rejects a non-https URL without making a request", async () => {
		let called = 0;
		globalThis.fetch = asFetch(() => {
			called += 1;
			return Promise.reject(new Error("should not fire"));
		});
		await expect(
			fetchVoicePreview("http://evil.example/x.mp3", new AbortController().signal)
		).rejects.toThrow();
		globalThis.fetch = originalFetch;
		expect(called).toBe(0);
	});

	test("returns the clip bytes on a 200 response (free download, no synthesis)", async () => {
		globalThis.fetch = asFetch(() =>
			Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }))
		);
		const bytes = await fetchVoicePreview("https://cdn/x.mp3", new AbortController().signal);
		globalThis.fetch = originalFetch;
		expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
	});

	test("throws on a non-OK response", async () => {
		globalThis.fetch = asFetch(() => Promise.resolve(new Response("nope", { status: 404 })));
		await expect(
			fetchVoicePreview("https://cdn/x.mp3", new AbortController().signal)
		).rejects.toThrow();
		globalThis.fetch = originalFetch;
	});
});

describe("synthesizeCloud (guard branches)", () => {
	test("errors immediately when the api key is missing (no fetch)", () => {
		storeStub.values["integrations.elevenlabs.apiKey"] = "";
		const reasons: string[] = [];
		ttsCloud.synthesizeCloud(
			{ requestId: "r1", text: "hi", voiceId: "v1" },
			{
				onChunk: () => undefined,
				onDone: () => undefined,
				onError: (r) => reasons.push(r),
			}
		);
		expect(reasons).toEqual(["ElevenLabs API key not configured"]);
	});

	test("errors immediately when no voice is selected", () => {
		storeStub.values["integrations.elevenlabs.apiKey"] = "el-key";
		const reasons: string[] = [];
		ttsCloud.synthesizeCloud(
			{ requestId: "r2", text: "hi", voiceId: "" },
			{
				onChunk: () => undefined,
				onDone: () => undefined,
				onError: (r) => reasons.push(r),
			}
		);
		expect(reasons).toEqual(["No ElevenLabs voice selected"]);
	});
});

describe("handleCloudListVoices", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	// Contained boundary cast — a Bun mock stands in for the global fetch.
	const asFetch = (m: () => Promise<Response>): typeof fetch => m as unknown as typeof fetch;

	test("returns the missing-key error without a network call", async () => {
		storeStub.values["integrations.elevenlabs.apiKey"] = "";
		let called = 0;
		globalThis.fetch = asFetch(() => {
			called++;
			return Promise.reject(new Error("should not fire"));
		});
		const result = await ttsCloud.handleCloudListVoices();
		globalThis.fetch = originalFetch;
		expect(result).toEqual({ voices: [], error: "ElevenLabs API key not configured" });
		expect(called).toBe(0);
	});

	test("maps a successful /v2/voices response", async () => {
		storeStub.values["integrations.elevenlabs.apiKey"] = "el-key";
		globalThis.fetch = asFetch(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						voices: [
							{
								voice_id: "v1",
								name: "Alice",
								labels: { language: "en" },
								category: "premade",
								preview_url: "https://cdn/a.mp3",
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } }
				)
			)
		);
		const result = await ttsCloud.handleCloudListVoices();
		globalThis.fetch = originalFetch;
		expect(result.error).toBeNull();
		expect(result.voices.length).toBe(1);
		expect(result.voices[0]?.id).toBe("v1");
		expect(result.voices[0]?.language).toBe("en");
	});

	test("classifies a 401 response as an invalid-key error", async () => {
		storeStub.values["integrations.elevenlabs.apiKey"] = "el-bad";
		globalThis.fetch = asFetch(() =>
			Promise.resolve(new Response("Unauthorized", { status: 401 }))
		);
		const result = await ttsCloud.handleCloudListVoices();
		globalThis.fetch = originalFetch;
		expect(result.voices).toEqual([]);
		expect(result.error).toBe("ElevenLabs: invalid API key");
	});

	test("surfaces a network failure as a human error string", async () => {
		storeStub.values["integrations.elevenlabs.apiKey"] = "el-key";
		globalThis.fetch = asFetch(() => Promise.reject(new TypeError("fetch failed")));
		const result = await ttsCloud.handleCloudListVoices();
		globalThis.fetch = originalFetch;
		expect(result.voices).toEqual([]);
		expect(result.error).toBe("fetch failed");
	});
});

describe("handleCloudSubscription", () => {
	let originalFetch: typeof fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	const asFetch = (m: () => Promise<Response>): typeof fetch => m as unknown as typeof fetch;

	test("returns tier:null without a request when the key is missing", async () => {
		storeStub.values["integrations.elevenlabs.apiKey"] = "";
		let called = 0;
		globalThis.fetch = asFetch(() => {
			called += 1;
			return Promise.reject(new Error("should not fire"));
		});
		const result = await ttsCloud.handleCloudSubscription();
		globalThis.fetch = originalFetch;
		expect(result).toEqual({ tier: null, creditsExhausted: false });
		expect(called).toBe(0);
	});

	test("parses the tier from a 200 response", async () => {
		storeStub.values["integrations.elevenlabs.apiKey"] = "el-key";
		globalThis.fetch = asFetch(() =>
			Promise.resolve(new Response(JSON.stringify({ tier: "free" }), { status: 200 }))
		);
		const result = await ttsCloud.handleCloudSubscription();
		globalThis.fetch = originalFetch;
		expect(result).toEqual({ tier: "free", creditsExhausted: false });
	});

	test("flags creditsExhausted when character_count >= character_limit", async () => {
		storeStub.values["integrations.elevenlabs.apiKey"] = "el-key";
		globalThis.fetch = asFetch(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({ tier: "free", character_count: 10_000, character_limit: 10_000 }),
					{ status: 200 }
				)
			)
		);
		const result = await ttsCloud.handleCloudSubscription();
		globalThis.fetch = originalFetch;
		expect(result).toEqual({ tier: "free", creditsExhausted: true });
	});

	test("does NOT flag exhausted while quota remains", async () => {
		storeStub.values["integrations.elevenlabs.apiKey"] = "el-key";
		globalThis.fetch = asFetch(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({ tier: "creator", character_count: 100, character_limit: 100_000 }),
					{ status: 200 }
				)
			)
		);
		const result = await ttsCloud.handleCloudSubscription();
		globalThis.fetch = originalFetch;
		expect(result).toEqual({ tier: "creator", creditsExhausted: false });
	});

	test("does NOT flag exhausted when overage (can_extend) is enabled", async () => {
		storeStub.values["integrations.elevenlabs.apiKey"] = "el-key";
		globalThis.fetch = asFetch(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						tier: "pro",
						character_count: 500_000,
						character_limit: 500_000,
						can_extend_character_limit: true,
					}),
					{ status: 200 }
				)
			)
		);
		const result = await ttsCloud.handleCloudSubscription();
		globalThis.fetch = originalFetch;
		expect(result).toEqual({ tier: "pro", creditsExhausted: false });
	});

	test("returns tier:null on a non-OK response (e.g. missing user-read scope)", async () => {
		storeStub.values["integrations.elevenlabs.apiKey"] = "el-scoped";
		globalThis.fetch = asFetch(() => Promise.resolve(new Response("nope", { status: 401 })));
		const result = await ttsCloud.handleCloudSubscription();
		globalThis.fetch = originalFetch;
		expect(result).toEqual({ tier: null, creditsExhausted: false });
	});

	test("returns tier:null when the body carries no string tier", async () => {
		storeStub.values["integrations.elevenlabs.apiKey"] = "el-key";
		globalThis.fetch = asFetch(() =>
			Promise.resolve(new Response(JSON.stringify({ foo: 1 }), { status: 200 }))
		);
		const result = await ttsCloud.handleCloudSubscription();
		globalThis.fetch = originalFetch;
		expect(result).toEqual({ tier: null, creditsExhausted: false });
	});
});
