import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import { useCredentialStatusStore } from "@/entities/cloud-stt-credential";

const mockInvoke = mock(async (_channel: string, _payload?: unknown) => ({
	ok: true,
}));

mock.module("@/shared/api/ipc-client", () => ({
	...ipcClientMock(),
	ipcInvoke: (channel: string, payload?: unknown) =>
		mockInvoke(channel, payload),
}));

const {
	applyVerifyResponse,
	errorMessage,
	invokeVerify,
	missingKeyResponse,
	verifyCredential,
} = await import("./verify-credential");

beforeEach(() => {
	mockInvoke.mockReset();
	useCredentialStatusStore.setState({
		byProvider: {
			elevenlabs: { status: "idle" },
		},
	});
});

describe("missingKeyResponse", () => {
	test("returns a stable {ok:false, code:'key_missing'} value", () => {
		expect(missingKeyResponse()).toEqual({
			ok: false,
			code: "key_missing",
			message: "No API key configured",
		});
	});
});

describe("errorMessage", () => {
	test("returns the Error.message for thrown Errors", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
	});
	test("string-coerces non-Error throws", () => {
		expect(errorMessage("nope")).toBe("nope");
		expect(errorMessage(404)).toBe("404");
		expect(errorMessage(null)).toBe("null");
	});
});

describe("invokeVerify", () => {
	test("returns the IPC response on success", async () => {
		mockInvoke.mockImplementationOnce(async () => ({ ok: true }));
		const r = await invokeVerify("elevenlabs", "sk-abc");
		expect(r).toEqual({ ok: true });
	});

	test("maps a thrown error to {ok:false, code:'network'}", async () => {
		mockInvoke.mockImplementationOnce(async () => {
			throw new Error("ECONNREFUSED");
		});
		const r = await invokeVerify("elevenlabs", "sk-abc");
		expect(r.ok).toBe(false);
		expect(r.code).toBe("network");
		expect(r.message).toBe("ECONNREFUSED");
	});

	test("maps a non-Error throw to its string form", async () => {
		// Bun's `Promise.reject` bypasses `useThrowOnlyError` (which inspects
		// literal `throw` statements). We need a non-Error rejection so the
		// `String(err)` fallback in `errorMessage` is exercised.
		mockInvoke.mockImplementationOnce(() => Promise.reject("kaboom"));
		const r = await invokeVerify("elevenlabs", "sk-abc");
		expect(r.message).toBe("kaboom");
	});
});

describe("applyVerifyResponse", () => {
	test("ok=true sets status to verified", () => {
		applyVerifyResponse("elevenlabs", { ok: true });
		expect(useCredentialStatusStore.getState().byProvider.elevenlabs.status).toBe(
			"verified",
		);
	});

	test("ok=false + code=network sets status to offline with the message", () => {
		applyVerifyResponse("elevenlabs", {
			ok: false,
			code: "network",
			message: "down",
		});
		const entry = useCredentialStatusStore.getState().byProvider.elevenlabs;
		expect(entry.status).toBe("offline");
		expect(entry.lastError).toBe("down");
	});

	test("ok=false + other code sets status to invalid with the message", () => {
		applyVerifyResponse("elevenlabs", { ok: false, code: "auth", message: "401" });
		const entry = useCredentialStatusStore.getState().byProvider.elevenlabs;
		expect(entry.status).toBe("invalid");
		expect(entry.lastError).toBe("401");
	});

	test("returns the response unchanged", () => {
		const r = { ok: false, code: "auth" as const, message: "nope" };
		expect(applyVerifyResponse("elevenlabs", r)).toBe(r);
	});
});

describe("verifyCredential", () => {
	test("blank key short-circuits to idle without an IPC call", async () => {
		const result = await verifyCredential("elevenlabs", "   ");
		expect(result.code).toBe("key_missing");
		expect(mockInvoke).not.toHaveBeenCalled();
		expect(useCredentialStatusStore.getState().byProvider.elevenlabs.status).toBe(
			"idle",
		);
	});

	test("ok response flips status to verified", async () => {
		mockInvoke.mockImplementationOnce(async () => ({ ok: true }));
		const result = await verifyCredential("elevenlabs", "sk-abc");
		expect(result.ok).toBe(true);
		expect(useCredentialStatusStore.getState().byProvider.elevenlabs.status).toBe(
			"verified",
		);
	});

	test("network failure (thrown) maps to offline", async () => {
		mockInvoke.mockImplementationOnce(async () => {
			throw new Error("ETIMEDOUT");
		});
		const result = await verifyCredential("elevenlabs", "key");
		expect(result.code).toBe("network");
		expect(
			useCredentialStatusStore.getState().byProvider.elevenlabs.status,
		).toBe("offline");
	});

	test("auth failure (response.code !== network) maps to invalid", async () => {
		mockInvoke.mockImplementationOnce(async () => ({
			ok: false,
			code: "auth",
			message: "bad key",
		}));
		const result = await verifyCredential("elevenlabs", "sk-bad");
		expect(result.ok).toBe(false);
		expect(useCredentialStatusStore.getState().byProvider.elevenlabs.status).toBe(
			"invalid",
		);
	});

	test("flips to verifying before the IPC resolves", async () => {
		let observedDuringInvoke: string | undefined;
		mockInvoke.mockImplementationOnce(async () => {
			observedDuringInvoke =
				useCredentialStatusStore.getState().byProvider.elevenlabs.status;
			return { ok: true };
		});
		await verifyCredential("elevenlabs", "sk-abc");
		expect(observedDuringInvoke).toBe("verifying");
	});
});
