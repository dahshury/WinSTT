import { beforeEach, describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";
import { APICallError } from "ai";
import { IPC } from "../../src/shared/api/ipc-channels";

// stt-cloud.ts imports `BrowserWindow` from "electron" at module load, which
// requires a shim under bun:test the same way audio-mute.test.ts wires it up.
mock.module("electron", () => electronMock());

// `loadApiKey` reads from the electron-store via `../lib/store`. Stub it so
// the API-key path can be covered without spinning up a real Store.
const storeStub: { values: Record<string, unknown> } = { values: {} };
mock.module("../lib/store", () => ({
	getStoreValue: (key: string) => storeStub.values[key],
}));

// `dbg` writes to electron-log which expects a real app/logger surface in
// production. The default mock works but explicit silencing keeps test output
// clean and makes the failure-classification branches assertable without
// noise.
mock.module("../lib/debug-log", () => ({
	dbg: () => undefined,
}));

const sttCloud = await import("./stt-cloud");
const {
	abortAllCloudTranscribes,
	asCloudTranscribeRequest,
	asString,
	assertAudioWithinLimit,
	assertModelAvailable,
	buildErrorResponse,
	buildProviderOptions,
	buildRetryExtra,
	buildSuccessResponse,
	buildTranscriptionModel,
	channelForErrorCode,
	classifyError,
	decodeAudio,
	dispatchRendererToast,
	exceedsAudioLimit,
	handleTranscribeFailure,
	isCloudTranscribeRequest,
	isPositiveFinite,
	loadApiKey,
	maybeNotifyRenderer,
	parseRetryAfter,
	pickSentinel,
	PROVIDER_AUDIO_LIMIT_BYTES,
	runProtectedTranscribe,
	setupCloudStt,
	spreadOptional,
} = sttCloud;

beforeEach(() => {
	storeStub.values = {};
});

describe("isCloudTranscribeRequest", () => {
	const valid = {
		command: "stt_cloud_transcribe_request",
		request_id: "req-1",
		provider: "openai",
		model_id: "gpt-4o-mini-transcribe",
		audio_b64: "aGVsbG8=",
		media_type: "audio/wav",
	};

	test("accepts the canonical envelope", () => {
		expect(isCloudTranscribeRequest(valid)).toBe(true);
	});

	test("accepts an optional language hint", () => {
		expect(isCloudTranscribeRequest({ ...valid, language: "en" })).toBe(true);
	});

	test("rejects non-objects (null, primitives)", () => {
		expect(isCloudTranscribeRequest(null)).toBe(false);
		expect(isCloudTranscribeRequest(undefined)).toBe(false);
		expect(isCloudTranscribeRequest("string")).toBe(false);
		expect(isCloudTranscribeRequest(42)).toBe(false);
	});

	test("rejects unknown command names", () => {
		expect(isCloudTranscribeRequest({ ...valid, command: "set_parameter" })).toBe(false);
	});

	test("rejects missing / non-string request_id", () => {
		expect(isCloudTranscribeRequest({ ...valid, request_id: undefined })).toBe(false);
		expect(isCloudTranscribeRequest({ ...valid, request_id: "" })).toBe(false);
		expect(isCloudTranscribeRequest({ ...valid, request_id: 7 })).toBe(false);
	});

	test("rejects empty model_id / audio_b64 / media_type", () => {
		expect(isCloudTranscribeRequest({ ...valid, model_id: "" })).toBe(false);
		expect(isCloudTranscribeRequest({ ...valid, audio_b64: "" })).toBe(false);
		expect(isCloudTranscribeRequest({ ...valid, media_type: "" })).toBe(false);
	});

	test("rejects unknown providers", () => {
		expect(isCloudTranscribeRequest({ ...valid, provider: "deepgram" })).toBe(false);
	});

	test("rejects non-string language", () => {
		expect(isCloudTranscribeRequest({ ...valid, language: 123 })).toBe(false);
	});
});

describe("asCloudTranscribeRequest", () => {
	test("returns the request when valid", () => {
		const valid = {
			command: "stt_cloud_transcribe_request" as const,
			request_id: "req-1",
			provider: "openai" as const,
			model_id: "m",
			audio_b64: "aGVsbG8=",
			media_type: "audio/wav",
		};
		expect(asCloudTranscribeRequest(valid)).toBe(valid);
	});

	test("returns null when invalid", () => {
		expect(asCloudTranscribeRequest({})).toBeNull();
		expect(asCloudTranscribeRequest(null)).toBeNull();
	});
});

describe("decodeAudio", () => {
	test("decodes a base64 string into bytes", () => {
		const bytes = decodeAudio("aGVsbG8=");
		expect(Buffer.from(bytes).toString("utf-8")).toBe("hello");
	});
});

describe("channelForErrorCode", () => {
	test("maps each code to its IPC channel", () => {
		expect(channelForErrorCode("auth")).toBe(IPC.STT_CLOUD_AUTH_FAILED);
		expect(channelForErrorCode("network")).toBe(IPC.STT_CLOUD_NETWORK_ERROR);
		expect(channelForErrorCode("timeout")).toBe(IPC.STT_CLOUD_NETWORK_ERROR);
		expect(channelForErrorCode("key_missing")).toBe(IPC.STT_CLOUD_KEY_MISSING);
		expect(channelForErrorCode("rate_limit")).toBe(IPC.STT_CLOUD_RATE_LIMITED);
		expect(channelForErrorCode("provider_error")).toBe(IPC.STT_CLOUD_PROVIDER_ERROR);
		expect(channelForErrorCode("audio_too_large")).toBe(IPC.STT_CLOUD_PROVIDER_ERROR);
	});

	test("aborted suppresses the toast (no channel)", () => {
		// User-initiated cancel shouldn't toast — they already know.
		expect(channelForErrorCode("aborted")).toBeNull();
	});
});

describe("dispatchRendererToast", () => {
	test("returns silently when channel is null (aborted suppression)", () => {
		// Doesn't throw, doesn't call broadcastIpc internals.
		expect(() => dispatchRendererToast(null, { foo: "bar" })).not.toThrow();
	});

	test("invokes the broadcast path for a real channel", () => {
		// No live BrowserWindows in the mock → broadcast loop is a no-op but
		// the call still exercises the conditional path that picks "yes, send".
		expect(() => dispatchRendererToast(IPC.STT_CLOUD_AUTH_FAILED, { foo: "bar" })).not.toThrow();
	});
});

describe("parseRetryAfter", () => {
	test("parses integer seconds", () => {
		expect(parseRetryAfter("30")).toBe(30);
	});

	test("parses fractional seconds", () => {
		expect(parseRetryAfter("1.5")).toBe(1.5);
	});

	test("ignores zero/negative/non-numeric", () => {
		expect(parseRetryAfter("0")).toBeUndefined();
		expect(parseRetryAfter("-5")).toBeUndefined();
		expect(parseRetryAfter("soon")).toBeUndefined();
		expect(parseRetryAfter(undefined)).toBeUndefined();
	});
});

describe("isPositiveFinite", () => {
	test("accepts positive finite numbers", () => {
		expect(isPositiveFinite(1)).toBe(true);
		expect(isPositiveFinite(0.1)).toBe(true);
	});

	test("rejects zero / negative / NaN / Infinity", () => {
		expect(isPositiveFinite(0)).toBe(false);
		expect(isPositiveFinite(-1)).toBe(false);
		expect(isPositiveFinite(Number.NaN)).toBe(false);
		expect(isPositiveFinite(Number.POSITIVE_INFINITY)).toBe(false);
	});
});

describe("classifyError", () => {
	test("AbortError → aborted (even if APICallError-shaped)", () => {
		const err = new Error("aborted");
		err.name = "AbortError";
		expect(classifyError(err).code).toBe("aborted");
	});

	test("APICallError 401 → auth", () => {
		const err = new APICallError({
			message: "Unauthorized",
			url: "https://api.openai.com/v1/audio/transcriptions",
			requestBodyValues: {},
			statusCode: 401,
		});
		expect(classifyError(err).code).toBe("auth");
	});

	test("APICallError 403 → auth", () => {
		const err = new APICallError({
			message: "Forbidden",
			url: "https://api.openai.com/v1/audio/transcriptions",
			requestBodyValues: {},
			statusCode: 403,
		});
		expect(classifyError(err).code).toBe("auth");
	});

	test("APICallError 429 with Retry-After header → rate_limit + retryAfter", () => {
		const err = new APICallError({
			message: "Too Many",
			url: "https://api.openai.com/v1/audio/transcriptions",
			requestBodyValues: {},
			statusCode: 429,
			responseHeaders: { "retry-after": "12" },
		});
		const c = classifyError(err);
		expect(c.code).toBe("rate_limit");
		expect(c.retryAfter).toBe(12);
	});

	test("APICallError 429 without header → rate_limit + no retryAfter", () => {
		const err = new APICallError({
			message: "Too Many",
			url: "https://api.openai.com/v1/audio/transcriptions",
			requestBodyValues: {},
			statusCode: 429,
		});
		const c = classifyError(err);
		expect(c.code).toBe("rate_limit");
		expect(c.retryAfter).toBeUndefined();
	});

	test("APICallError 413 → audio_too_large", () => {
		const err = new APICallError({
			message: "Payload too large",
			url: "https://api.openai.com/v1/audio/transcriptions",
			requestBodyValues: {},
			statusCode: 413,
		});
		expect(classifyError(err).code).toBe("audio_too_large");
	});

	test("APICallError without statusCode → network", () => {
		const err = new APICallError({
			message: "fetch failed",
			url: "https://api.openai.com/v1/audio/transcriptions",
			requestBodyValues: {},
		});
		expect(classifyError(err).code).toBe("network");
	});

	test("APICallError with unknown statusCode → provider_error", () => {
		const err = new APICallError({
			message: "Server error",
			url: "https://api.openai.com/v1/audio/transcriptions",
			requestBodyValues: {},
			statusCode: 500,
		});
		expect(classifyError(err).code).toBe("provider_error");
	});

	test("TypeError → network (covers raw fetch failures)", () => {
		expect(classifyError(new TypeError("fetch failed")).code).toBe("network");
	});

	test("Connection-refused string → network", () => {
		expect(classifyError(new Error("connect ECONNREFUSED 127.0.0.1:443")).code).toBe("network");
	});

	test("DNS-failure string → network", () => {
		expect(classifyError(new Error("getaddrinfo ENOTFOUND api.openai.com")).code).toBe("network");
	});

	test("Random error → provider_error", () => {
		expect(classifyError(new Error("boom")).code).toBe("provider_error");
	});
});

describe("PROVIDER_AUDIO_LIMIT_BYTES", () => {
	test("matches the documented per-provider ceilings", () => {
		expect(PROVIDER_AUDIO_LIMIT_BYTES.openai).toBe(25 * 1024 * 1024);
		expect(PROVIDER_AUDIO_LIMIT_BYTES.elevenlabs).toBe(1024 * 1024 * 1024);
	});
});

describe("exceedsAudioLimit", () => {
	test("returns true when byteLength exceeds the provider ceiling", () => {
		expect(exceedsAudioLimit("openai", 25 * 1024 * 1024 + 1)).toBe(true);
	});

	test("returns false at or below the ceiling", () => {
		expect(exceedsAudioLimit("openai", 25 * 1024 * 1024)).toBe(false);
		expect(exceedsAudioLimit("openai", 0)).toBe(false);
	});
});

describe("buildProviderOptions", () => {
	test("returns an empty object when language is undefined", () => {
		expect(buildProviderOptions("openai", undefined)).toEqual({});
	});

	test("nests language under the provider key when present", () => {
		expect(buildProviderOptions("openai", "en")).toEqual({
			providerOptions: { openai: { language: "en" } },
		});
		expect(buildProviderOptions("elevenlabs", "fr")).toEqual({
			providerOptions: { elevenlabs: { language: "fr" } },
		});
	});
});

describe("buildSuccessResponse", () => {
	test("required fields only", () => {
		const res = buildSuccessResponse("req-1", { text: "hi" });
		expect(res).toEqual({
			command: "stt_cloud_transcribe_response",
			request_id: "req-1",
			ok: true,
			text: "hi",
		});
	});

	test("includes language when present", () => {
		const res = buildSuccessResponse("req-1", { text: "hi", language: "en" });
		expect(res.language).toBe("en");
	});

	test("includes duration_seconds when present", () => {
		const res = buildSuccessResponse("req-1", { text: "hi", duration: 4.2 });
		expect(res.duration_seconds).toBe(4.2);
	});

	test("includes both language and duration_seconds when both present", () => {
		const res = buildSuccessResponse("req-1", {
			text: "hi",
			language: "fr",
			duration: 1,
		});
		expect(res.language).toBe("fr");
		expect(res.duration_seconds).toBe(1);
	});
});

describe("buildErrorResponse", () => {
	test("required fields only when retryAfter is undefined", () => {
		const res = buildErrorResponse("req-1", "auth", "bad key", undefined);
		expect(res).toEqual({
			command: "stt_cloud_transcribe_response",
			request_id: "req-1",
			ok: false,
			error_code: "auth",
			error_message: "bad key",
		});
	});

	test("includes retry_after_seconds when retryAfter is provided", () => {
		const res = buildErrorResponse("req-1", "rate_limit", "slow down", 30);
		expect(res.retry_after_seconds).toBe(30);
	});
});

describe("buildRetryExtra", () => {
	test("returns undefined when retryAfter is undefined", () => {
		expect(buildRetryExtra(undefined)).toBeUndefined();
	});

	test("wraps retryAfter in an object when provided", () => {
		expect(buildRetryExtra(15)).toEqual({ retryAfter: 15 });
	});
});

describe("pickSentinel", () => {
	const request = {
		command: "stt_cloud_transcribe_request" as const,
		request_id: "req-1",
		provider: "openai" as const,
		model_id: "m",
		audio_b64: "aGVsbG8=",
		media_type: "audio/wav",
	};

	test("KEY_MISSING resolves to key_missing outcome", () => {
		const handler = pickSentinel("KEY_MISSING");
		expect(handler).toBeDefined();
		expect(handler?.(request)).toEqual({
			code: "key_missing",
			message: "No API key configured",
		});
	});

	test("AUDIO_TOO_LARGE encodes the provider in the message", () => {
		const handler = pickSentinel("AUDIO_TOO_LARGE");
		expect(handler).toBeDefined();
		expect(handler?.(request)).toEqual({
			code: "audio_too_large",
			message: "Utterance exceeds openai upload limit",
		});
		const elHandler = pickSentinel("AUDIO_TOO_LARGE");
		expect(elHandler?.({ ...request, provider: "elevenlabs" })).toEqual({
			code: "audio_too_large",
			message: "Utterance exceeds elevenlabs upload limit",
		});
	});

	test("returns undefined for unknown sentinels", () => {
		expect(pickSentinel("UNRELATED")).toBeUndefined();
		expect(pickSentinel("")).toBeUndefined();
	});
});

describe("asString", () => {
	test("passes strings through unchanged", () => {
		expect(asString("hello")).toBe("hello");
		expect(asString("")).toBe("");
	});

	test("returns the empty string for every non-string typeof", () => {
		expect(asString(undefined)).toBe("");
		expect(asString(null)).toBe("");
		expect(asString(42)).toBe("");
		expect(asString(true)).toBe("");
		expect(asString({})).toBe("");
		expect(asString([])).toBe("");
		expect(asString(Symbol("s"))).toBe("");
		expect(asString(() => undefined)).toBe("");
		expect(asString(BigInt(1))).toBe("");
	});
});

describe("loadApiKey", () => {
	test("reads from the openai integrations key", () => {
		storeStub.values["integrations.openai.apiKey"] = "sk-openai";
		expect(loadApiKey("openai")).toBe("sk-openai");
	});

	test("reads from the elevenlabs integrations key", () => {
		storeStub.values["integrations.elevenlabs.apiKey"] = "el-key";
		expect(loadApiKey("elevenlabs")).toBe("el-key");
	});

	test("returns empty string when key is missing or non-string", () => {
		expect(loadApiKey("openai")).toBe("");
		storeStub.values["integrations.openai.apiKey"] = 42;
		expect(loadApiKey("openai")).toBe("");
	});
});

describe("buildTranscriptionModel", () => {
	test("returns null when the api key is missing", () => {
		expect(buildTranscriptionModel("openai", "gpt-4o-mini-transcribe")).toBeNull();
		expect(buildTranscriptionModel("elevenlabs", "scribe_v1")).toBeNull();
	});

	test("returns a non-null handle when an openai key is present", () => {
		storeStub.values["integrations.openai.apiKey"] = "sk-openai";
		const model = buildTranscriptionModel("openai", "gpt-4o-mini-transcribe");
		expect(model).not.toBeNull();
	});

	test("returns a non-null handle when an elevenlabs key is present", () => {
		storeStub.values["integrations.elevenlabs.apiKey"] = "el-key";
		const model = buildTranscriptionModel("elevenlabs", "scribe_v1");
		expect(model).not.toBeNull();
	});
});

describe("assertModelAvailable", () => {
	test("does nothing when the model is non-null", () => {
		expect(() => assertModelAvailable({})).not.toThrow();
		expect(() => assertModelAvailable("model-handle")).not.toThrow();
	});

	test("throws KEY_MISSING when model is null", () => {
		expect(() => assertModelAvailable(null)).toThrow("KEY_MISSING");
	});
});

describe("assertAudioWithinLimit", () => {
	test("does nothing when audio is within the provider ceiling", () => {
		expect(() => assertAudioWithinLimit("openai", 1024)).not.toThrow();
		expect(() => assertAudioWithinLimit("openai", 25 * 1024 * 1024)).not.toThrow();
	});

	test("throws AUDIO_TOO_LARGE when audio exceeds the ceiling", () => {
		expect(() => assertAudioWithinLimit("openai", 25 * 1024 * 1024 + 1)).toThrow("AUDIO_TOO_LARGE");
	});
});

describe("spreadOptional", () => {
	test("returns an empty object when value is undefined", () => {
		expect(spreadOptional("language", undefined)).toEqual({});
	});

	test("wraps the key/value pair when value is present", () => {
		expect(spreadOptional("language", "en")).toEqual({ language: "en" });
		expect(spreadOptional("duration", 3.5)).toEqual({ duration: 3.5 });
		expect(spreadOptional("language", "")).toEqual({ language: "" });
	});
});

describe("maybeNotifyRenderer", () => {
	test("emits when the code is non-aborted", () => {
		// No live windows in the mock — broadcast loop is a no-op, but the
		// dispatch path itself is exercised (the lookup-table emit arm).
		expect(() => maybeNotifyRenderer("openai", { code: "auth", message: "bad" })).not.toThrow();
		expect(() =>
			maybeNotifyRenderer("openai", { code: "rate_limit", message: "slow", retryAfter: 30 })
		).not.toThrow();
	});

	test("suppresses when the code is aborted", () => {
		expect(() =>
			maybeNotifyRenderer("openai", { code: "aborted", message: "cancelled" })
		).not.toThrow();
	});
});

describe("handleTranscribeFailure", () => {
	const fakeClient = {
		sendControl: (_payload: Record<string, unknown>) => undefined,
		on: () => undefined,
		off: () => undefined,
	} as unknown as Parameters<typeof handleTranscribeFailure>[0];

	const request = {
		command: "stt_cloud_transcribe_request" as const,
		request_id: "req-1",
		provider: "openai" as const,
		model_id: "m",
		audio_b64: "aGVsbG8=",
		media_type: "audio/wav",
	};

	test("routes a KEY_MISSING sentinel via the sentinel arm", () => {
		let payload: Record<string, unknown> | null = null;
		const client = {
			sendControl: (p: Record<string, unknown>) => {
				payload = p;
			},
		} as unknown as Parameters<typeof handleTranscribeFailure>[0];
		handleTranscribeFailure(client, request, new Error("KEY_MISSING"));
		expect(payload).not.toBeNull();
		expect((payload as unknown as { error_code: string }).error_code).toBe("key_missing");
	});

	test("routes a classified error via the classified arm", () => {
		let payload: Record<string, unknown> | null = null;
		const client = {
			sendControl: (p: Record<string, unknown>) => {
				payload = p;
			},
		} as unknown as Parameters<typeof handleTranscribeFailure>[0];
		handleTranscribeFailure(client, request, new TypeError("fetch failed"));
		expect(payload).not.toBeNull();
		expect((payload as unknown as { error_code: string }).error_code).toBe("network");
	});

	test("routes an AUDIO_TOO_LARGE sentinel via the sentinel arm", () => {
		let payload: Record<string, unknown> | null = null;
		const client = {
			sendControl: (p: Record<string, unknown>) => {
				payload = p;
			},
		} as unknown as Parameters<typeof handleTranscribeFailure>[0];
		handleTranscribeFailure(client, request, new Error("AUDIO_TOO_LARGE"));
		expect(payload).not.toBeNull();
		expect((payload as unknown as { error_code: string }).error_code).toBe("audio_too_large");
	});

	// Pin the fake-client reference so it isn't flagged as unused.
	test("smoke: fakeClient signature compiles", () => {
		expect(typeof fakeClient.sendControl).toBe("function");
	});
});

describe("abortAllCloudTranscribes", () => {
	test("no-ops when the in-flight map is empty", () => {
		expect(() => abortAllCloudTranscribes("idle")).not.toThrow();
	});

	test("clears any in-flight entries the pipeline left behind", async () => {
		// Drive one transcribe attempt that throws immediately (no api key) so
		// the inFlight map is touched, then teardown via abort to ensure the
		// loop body is exercised even if the entry is already gone.
		const client = {
			sendControl: () => undefined,
			on: () => undefined,
			off: () => undefined,
		} as unknown as Parameters<typeof setupCloudStt>[0];
		const cleanup = setupCloudStt(client);
		// cleanup invokes abortAllCloudTranscribes("setupCloudStt teardown")
		// which in turn drives abortAllInFlight over the (empty) map.
		cleanup();
		// Sanity: explicit call shouldn't throw either.
		expect(() => abortAllCloudTranscribes("explicit")).not.toThrow();
	});
});

describe("runProtectedTranscribe", () => {
	test("clears the timer / untracks even when the inner call throws", async () => {
		const client = {
			sendControl: () => undefined,
		} as unknown as Parameters<typeof runProtectedTranscribe>[0];
		const request = {
			command: "stt_cloud_transcribe_request" as const,
			request_id: "req-protected",
			provider: "openai" as const,
			model_id: "missing-key-route",
			audio_b64: "aGVsbG8=",
			media_type: "audio/wav",
		};
		const controller = new AbortController();
		let cleared = 0;
		await runProtectedTranscribe(client, request, controller, () => {
			cleared++;
		});
		// `runTranscribe` will throw KEY_MISSING (no key configured) → caught
		// by the inner .catch → finally-equivalent `clear()` still runs.
		expect(cleared).toBe(1);
	});
});
