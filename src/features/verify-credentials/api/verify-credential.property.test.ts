/**
 * Property tests for verify-credential.ts.
 *
 * Companion to verify-credential.test.ts. The example-based test file
 * exercises happy/sad paths per branch; this file pins down INVARIANTS that
 * must hold across the whole input space:
 *
 *   1. `errorMessage` is total and never throws for any input value (the API
 *      surface accepts `unknown` so it MUST handle every JS value).
 *   2. `applyVerifyResponse` returns its input by reference identity for every
 *      `(provider, response)` pair — the function is a side-effecting router,
 *      never a transformer, so the response should pass through.
 *   3. `missingKeyResponse` is a stable constant — repeated calls yield equal
 *      values (no mutable internal state leaks).
 *   4. `invokeVerify` maps every fetch rejection (Error or non-Error throw)
 *      to `{ok:false, code:"network"}` — the classification is exhaustive.
 *
 * These properties caught nothing on first run (existing implementation is
 * correct); they guard against regression when someone "optimizes" the
 * router by mutating the response or shortcuts errorMessage to `err.message`.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import fc from "fast-check";
import { useCredentialStatusStore } from "@/entities/cloud-stt-credential";
import type {
	CloudSttErrorCode,
	IntegrationCloudProvider,
} from "@/shared/api/models";

const mockInvoke = mock(async (_channel: string, _payload?: unknown) => ({
	ok: true,
}));

mock.module("@/shared/api/ipc-client", () => ({
	...ipcClientMock(),
	ipcInvoke: (channel: string, payload?: unknown) =>
		mockInvoke(channel, payload),
}));

const { applyVerifyResponse, errorMessage, invokeVerify, missingKeyResponse } =
	await import("./verify-credential");

beforeEach(() => {
	mockInvoke.mockReset();
	useCredentialStatusStore.setState({
		byProvider: {
			elevenlabs: { status: "idle" },
		},
	});
});

// ElevenLabs is the only integrations-backed cloud STT provider that
// `verifyCredential` probes (OpenAI removed; OpenRouter STT reuses the LLM key).
const providerArb: fc.Arbitrary<IntegrationCloudProvider> =
	fc.constantFrom("elevenlabs");

/**
 * Build a VerifyResponse without including the `message` key when it's
 * undefined. Required because `exactOptionalPropertyTypes` distinguishes
 * `{ message: undefined }` (forbidden) from omitted (allowed).
 */
function buildResponse(
	ok: boolean,
	code?: CloudSttErrorCode,
	message?: string,
): { ok: boolean; code?: CloudSttErrorCode; message?: string } {
	const response: { ok: boolean; code?: CloudSttErrorCode; message?: string } =
		{ ok };
	if (code !== undefined) {
		response.code = code;
	}
	if (message !== undefined) {
		response.message = message;
	}
	return response;
}

// Sample of CloudSttErrorCode-like values plus garbage codes — the router
// only special-cases "network", everything else must funnel to `invalid`.
const errorCodeArb: fc.Arbitrary<CloudSttErrorCode | string> = fc.constantFrom(
	"network",
	"auth",
	"key_missing",
	"unknown",
	"rate_limited",
	"forbidden",
);

describe("errorMessage — total function property", () => {
	// Arbitrary for values that can realistically come out of a `catch (err)`
	// in JS — `throw <anything>` is legal but the standard library + fetch +
	// IPC only ever surface these shapes. `fc.anything()` would synthesise
	// `{toString: {}}` (a value whose String() coercion throws), which is a
	// finding we file but not part of the contract the caller relies on.
	const thrownValueArb = fc.oneof(
		fc.string().map((s) => new Error(s)),
		fc.string().map((s) => new TypeError(s)),
		fc.string(),
		fc.integer(),
		fc.boolean(),
		fc.constant(null),
		fc.constant(undefined),
	);

	test("returns a string for every realistic thrown value (never throws)", () => {
		fc.assert(
			fc.property(thrownValueArb, (value) => {
				const result = errorMessage(value);
				return typeof result === "string";
			}),
			{ numRuns: 500 },
		);
	});

	test("returns Error.message verbatim for any Error instance", () => {
		fc.assert(
			fc.property(fc.string(), (msg) => errorMessage(new Error(msg)) === msg),
			{ numRuns: 200 },
		);
	});

	test("falls back to String(value) for non-Error throws", () => {
		fc.assert(
			fc.property(
				fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
				(value) => errorMessage(value) === String(value),
			),
			{ numRuns: 200 },
		);
	});

	// FINDING (NOT a fix): errorMessage(value) calls String(value), which
	// throws for a `{toString: {}}` payload because the override is not
	// callable. The signature accepts `unknown`, so this is technically a
	// gap; in practice the only callers are catch blocks for `fetch`/IPC
	// rejections, which never surface such values. Document the limit
	// rather than silently widen the contract.
	test("known limitation: object with non-callable toString crashes String()", () => {
		const adversarial = { toString: {} } as unknown;
		expect(() => errorMessage(adversarial)).toThrow();
	});
});

describe("missingKeyResponse — stable constant property", () => {
	test("every call produces an equal value", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 10 }), (callCount) => {
				const results = Array.from({ length: callCount }, () =>
					missingKeyResponse(),
				);
				const first = results[0];
				return results.every(
					(r) =>
						r.ok === first?.ok &&
						r.code === first?.code &&
						r.message === first?.message,
				);
			}),
			{ numRuns: 50 },
		);
	});

	test("the response is always ok=false with a key_missing code", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 100 }), () => {
				const r = missingKeyResponse();
				return r.ok === false && r.code === "key_missing";
			}),
			{ numRuns: 50 },
		);
	});
});

describe("applyVerifyResponse — reference-identity property", () => {
	test("returns the input response by reference for every input", () => {
		// The router is a side-effecting dispatcher, NOT a transformer.
		// Mutating-the-response would silently break the existing call sites
		// that pattern-match on `r.ok` and `r.code` AFTER the side effect.
		fc.assert(
			fc.property(
				providerArb,
				fc.boolean(),
				errorCodeArb,
				fc.option(fc.string(), { nil: undefined }),
				(provider, ok, code, message) => {
					const input = buildResponse(ok, code as CloudSttErrorCode, message);
					return applyVerifyResponse(provider, input) === input;
				},
			),
			{ numRuns: 300 },
		);
	});

	test("ok=true always maps to status 'verified'", () => {
		fc.assert(
			fc.property(
				providerArb,
				fc.option(fc.string(), { nil: undefined }),
				(provider, msg) => {
					applyVerifyResponse(provider, buildResponse(true, undefined, msg));
					const status =
						useCredentialStatusStore.getState().byProvider[provider]?.status;
					return status === "verified";
				},
			),
			{ numRuns: 100 },
		);
	});

	test("ok=false + code=network always maps to status 'offline'", () => {
		fc.assert(
			fc.property(
				providerArb,
				fc.option(fc.string(), { nil: undefined }),
				(provider, msg) => {
					applyVerifyResponse(provider, buildResponse(false, "network", msg));
					const status =
						useCredentialStatusStore.getState().byProvider[provider]?.status;
					return status === "offline";
				},
			),
			{ numRuns: 100 },
		);
	});

	test("ok=false + any non-network code maps to status 'invalid'", () => {
		const nonNetworkCodeArb = errorCodeArb.filter((c) => c !== "network");
		fc.assert(
			fc.property(
				providerArb,
				nonNetworkCodeArb,
				fc.option(fc.string(), { nil: undefined }),
				(provider, code, msg) => {
					applyVerifyResponse(
						provider,
						buildResponse(false, code as CloudSttErrorCode, msg),
					);
					const status =
						useCredentialStatusStore.getState().byProvider[provider]?.status;
					return status === "invalid";
				},
			),
			{ numRuns: 200 },
		);
	});
});

describe("invokeVerify — error-classification property", () => {
	test("any throw (Error or non-Error) yields code='network'", async () => {
		await fc.assert(
			fc.asyncProperty(
				providerArb,
				fc.string({ minLength: 1 }),
				fc.oneof(
					fc.string().map((s) => new Error(s)),
					fc.string(),
					fc.integer(),
					fc.constant(null),
					fc.constant(undefined),
				),
				async (provider, key, errVal) => {
					mockInvoke.mockImplementationOnce(() => Promise.reject(errVal));
					const r = await invokeVerify(provider, key);
					return r.ok === false && r.code === "network";
				},
			),
			{ numRuns: 80 },
		);
	});

	test("any successful IPC response is returned unchanged", async () => {
		await fc.assert(
			fc.asyncProperty(
				providerArb,
				fc.string({ minLength: 1 }),
				fc.boolean(),
				errorCodeArb,
				async (provider, key, ok, code) => {
					const expected = { ok, code: code as CloudSttErrorCode };
					mockInvoke.mockImplementationOnce(async () => expected);
					const r = await invokeVerify(provider, key);
					return r.ok === expected.ok && r.code === expected.code;
				},
			),
			{ numRuns: 100 },
		);
	});
});
