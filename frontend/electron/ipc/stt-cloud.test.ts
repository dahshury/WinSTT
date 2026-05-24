import { describe, expect, test } from "bun:test";
import { APICallError } from "ai";
import { IPC } from "../../src/shared/api/ipc-channels";
import {
	channelForErrorCode,
	classifyError,
	decodeAudio,
	isCloudTranscribeRequest,
	parseRetryAfter,
} from "./stt-cloud";

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

	test("rejects unknown command names", () => {
		expect(isCloudTranscribeRequest({ ...valid, command: "set_parameter" })).toBe(false);
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

	test("TypeError → network (covers raw fetch failures)", () => {
		expect(classifyError(new TypeError("fetch failed")).code).toBe("network");
	});

	test("Connection-refused string → network", () => {
		expect(classifyError(new Error("connect ECONNREFUSED 127.0.0.1:443")).code).toBe("network");
	});

	test("Random error → provider_error", () => {
		expect(classifyError(new Error("boom")).code).toBe("provider_error");
	});
});
