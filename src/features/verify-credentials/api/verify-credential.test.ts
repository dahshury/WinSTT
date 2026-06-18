import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import * as realBindings from "@/bindings";
import { useCredentialStatusStore } from "@/entities/cloud-stt-credential";

// `invokeVerify` now calls the generated `commands.verifyCredential` binding
// directly (no IPC string channel). Mock it to return the tauri-specta `Result`
// shape (`{ status:"ok", data }`) so `verifyCredentialCommand`'s unwrap is
// exercised; a thrown rejection still flows through the network-fallback path.
type VerifyCredentialResult = Awaited<
	ReturnType<typeof realBindings.commands.verifyCredential>
>;

const mockVerify = mock(
	async (
		_provider: string,
		_apiKey: string,
	): Promise<VerifyCredentialResult> => ({
		status: "ok" as const,
		data: { ok: true } as { ok: boolean; code?: string; message?: string },
	}),
);

// Spread the REAL bindings and override only `verifyCredential`. A bare
// `{ commands: { verifyCredential } }` would clobber every other `commands.*`
// for any test that runs later in the same worker (bun `mock.module` is global),
// silently breaking unrelated suites (e.g. AboutSettingsPanel diagnostics).
mock.module("@/bindings", () => ({
	...realBindings,
	commands: {
		...realBindings.commands,
		verifyCredential: (provider: string, apiKey: string) =>
			mockVerify(provider, apiKey),
	},
}));

mock.module("@/shared/api/ipc-client", () => ipcClientMock());

/** Build the success `Result` the binding returns for a given payload. */
function okResult(data: { ok: boolean; code?: string; message?: string }) {
	return { status: "ok" as const, data };
}

const {
	applyVerifyResponse,
	errorMessage,
	invokeVerify,
	missingKeyResponse,
	verifyCredential,
} = await import("./verify-credential");

beforeEach(() => {
	mockVerify.mockReset();
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
	test("returns the unwrapped command payload on success", async () => {
		mockVerify.mockImplementationOnce(async () => okResult({ ok: true }));
		const r = await invokeVerify("elevenlabs", "sk-abc");
		expect(r).toEqual({ ok: true });
	});

	test("maps a thrown error to {ok:false, code:'network'}", async () => {
		mockVerify.mockImplementationOnce(async () => {
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
		mockVerify.mockImplementationOnce(() => Promise.reject("kaboom"));
		const r = await invokeVerify("elevenlabs", "sk-abc");
		expect(r.message).toBe("kaboom");
	});

	test("a Result error status rejects → maps to network", async () => {
		mockVerify.mockImplementationOnce(async () => ({
			status: "error" as const,
			error: "backend boom",
		}));
		const r = await invokeVerify("elevenlabs", "sk-abc");
		expect(r.code).toBe("network");
		expect(r.message).toBe("backend boom");
	});
});

describe("applyVerifyResponse", () => {
	test("ok=true sets status to verified", () => {
		applyVerifyResponse("elevenlabs", { ok: true });
		expect(
			useCredentialStatusStore.getState().byProvider.elevenlabs.status,
		).toBe("verified");
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
		applyVerifyResponse("elevenlabs", {
			ok: false,
			code: "auth",
			message: "401",
		});
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
		expect(mockVerify).not.toHaveBeenCalled();
		expect(
			useCredentialStatusStore.getState().byProvider.elevenlabs.status,
		).toBe("idle");
	});

	test("ok response flips status to verified", async () => {
		mockVerify.mockImplementationOnce(async () => okResult({ ok: true }));
		const result = await verifyCredential("elevenlabs", "sk-abc");
		expect(result.ok).toBe(true);
		expect(
			useCredentialStatusStore.getState().byProvider.elevenlabs.status,
		).toBe("verified");
	});

	test("network failure (thrown) maps to offline", async () => {
		mockVerify.mockImplementationOnce(async () => {
			throw new Error("ETIMEDOUT");
		});
		const result = await verifyCredential("elevenlabs", "key");
		expect(result.code).toBe("network");
		expect(
			useCredentialStatusStore.getState().byProvider.elevenlabs.status,
		).toBe("offline");
	});

	test("auth failure (response.code !== network) maps to invalid", async () => {
		mockVerify.mockImplementationOnce(async () =>
			okResult({ ok: false, code: "auth", message: "bad key" }),
		);
		const result = await verifyCredential("elevenlabs", "sk-bad");
		expect(result.ok).toBe(false);
		expect(
			useCredentialStatusStore.getState().byProvider.elevenlabs.status,
		).toBe("invalid");
	});

	test("flips to verifying before the IPC resolves", async () => {
		let observedDuringInvoke: string | undefined;
		mockVerify.mockImplementationOnce(async () => {
			observedDuringInvoke =
				useCredentialStatusStore.getState().byProvider.elevenlabs.status;
			return okResult({ ok: true });
		});
		await verifyCredential("elevenlabs", "sk-abc");
		expect(observedDuringInvoke).toBe("verifying");
	});
});
