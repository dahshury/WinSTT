/**
 * Cloud-STT credentials IPC.
 *
 * SET/REMOVE/GET intentionally absent — keys live as plain settings fields
 * (`integrations.openai.apiKey`, `integrations.elevenlabs.apiKey`) encrypted
 * at rest via the secret-storage layer (see `electron/lib/secret-storage.ts`),
 * so the renderer reads/writes them through the normal SETTINGS_SAVE flow
 * exactly like the existing `llm.openrouterApiKey`. Adding parallel
 * SET/GET/REMOVE handlers would create two sources of truth and break the
 * existing settings-sync invariants.
 *
 * Only `verify` is a new IPC: it's a side-effect-free probe that takes a
 * plaintext key (the user-typed value from the integrations panel — may
 * differ from the persisted value if the user is editing) and returns a
 * typed pass/fail. The renderer uses the result to drive the status pill
 * and (on success) writes verified/lastVerifiedAt back through the
 * settings store.
 *
 * Probe endpoints (chosen for being the cheapest auth-checking call each
 * provider exposes — no audio uploaded):
 *
 *   - OpenAI:     GET https://api.openai.com/v1/models
 *   - ElevenLabs: GET https://api.elevenlabs.io/v1/user
 *
 * Both return 200 with a small JSON body on success, 401 on bad key, and
 * connection errors on no-internet. We map all three to the
 * CloudSttErrorCode enum in the spec for symmetry with the transcribe
 * failure path.
 */
import { ipcMain } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";
import { getErrorMessage } from "../../src/shared/lib/errors";
import { dbg } from "../lib/debug-log";

export type CloudSttProvider = "openai" | "elevenlabs";

/** Providers the verify-credentials IPC accepts. STT-only (`CloudSttProvider`)
 *  plus `openrouter`, which is an LLM credential but shares the same probe-and-
 *  classify shape. Kept distinct from `CloudSttProvider` so the cloud-STT type
 *  union doesn't grow non-STT members. */
export type VerifiableProvider = CloudSttProvider | "openrouter";

export type VerifyCredentialResult =
	| { ok: true }
	| {
			ok: false;
			code: "auth" | "network" | "rate_limit" | "provider_error";
			message: string;
	  };

/** 10s — verify is a single round-trip and shouldn't block the UI longer. */
const VERIFY_TIMEOUT_MS = 10_000;

interface VerifyCredentialPayload {
	apiKey: string;
	provider: VerifiableProvider;
}

const VERIFIABLE_PROVIDERS = new Set<VerifiableProvider>(["openai", "elevenlabs", "openrouter"]);

function isVerifiableProvider(value: unknown): value is VerifiableProvider {
	return typeof value === "string" && VERIFIABLE_PROVIDERS.has(value as VerifiableProvider);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function isVerifyPayload(value: unknown): value is VerifyCredentialPayload {
	if (!isObjectRecord(value)) {
		return false;
	}
	return isVerifiableProvider(value.provider) && typeof value.apiKey === "string";
}

function probeUrlFor(provider: VerifiableProvider): string {
	if (provider === "openai") {
		return "https://api.openai.com/v1/models";
	}
	if (provider === "openrouter") {
		// OpenRouter's cheapest auth-check endpoint — returns 200 + key info
		// on a valid Bearer token, 401 on a bad one. No quota consumed.
		return "https://openrouter.ai/api/v1/auth/key";
	}
	return "https://api.elevenlabs.io/v1/user";
}

function authHeadersFor(provider: VerifiableProvider, apiKey: string): Record<string, string> {
	if (provider === "elevenlabs") {
		// ElevenLabs uses a custom header, not Bearer auth.
		return { "xi-api-key": apiKey };
	}
	// OpenAI and OpenRouter both use standard Bearer auth.
	return { Authorization: `Bearer ${apiKey}` };
}

const AUTH_STATUS_CODES = new Set([401, 403]);

function classifyHttpStatus(status: number): "auth" | "rate_limit" | "provider_error" {
	if (AUTH_STATUS_CODES.has(status)) {
		return "auth";
	}
	if (status === 429) {
		return "rate_limit";
	}
	return "provider_error";
}

async function readErrorBody(response: Response): Promise<string> {
	try {
		const text = await response.text();
		// Body unreadable / empty — keep the HTTP-status-only message.
		return text ? `: ${text.slice(0, 200)}` : "";
	} catch {
		return "";
	}
}

async function buildFailureFromResponse(response: Response): Promise<VerifyCredentialResult> {
	const code = classifyHttpStatus(response.status);
	const suffix = await readErrorBody(response);
	return { ok: false, code, message: `HTTP ${response.status}${suffix}` };
}

async function probeProvider(
	provider: VerifiableProvider,
	apiKey: string
): Promise<VerifyCredentialResult> {
	const response = await fetch(probeUrlFor(provider), {
		method: "GET",
		headers: authHeadersFor(provider, apiKey),
		signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
	});
	if (response.ok) {
		return { ok: true };
	}
	return await buildFailureFromResponse(response);
}

async function verifyCredential(
	provider: VerifiableProvider,
	apiKey: string
): Promise<VerifyCredentialResult> {
	const trimmed = apiKey.trim();
	if (!trimmed) {
		return { ok: false, code: "auth", message: "API key is empty" };
	}
	try {
		return await probeProvider(provider, trimmed);
	} catch (err) {
		const message = getErrorMessage(err);
		dbg("credentials", `${provider} verify failed:`, message);
		return { ok: false, code: "network", message };
	}
}

const INVALID_PAYLOAD_RESULT: VerifyCredentialResult = {
	ok: false,
	code: "provider_error",
	message: "Invalid verify payload",
};

async function handleVerifyInvocation(payload: unknown): Promise<VerifyCredentialResult> {
	if (!isVerifyPayload(payload)) {
		return INVALID_PAYLOAD_RESULT;
	}
	return await verifyCredential(payload.provider, payload.apiKey);
}

export function setupCredentials(): () => void {
	ipcMain.handle(IPC.INTEGRATIONS_VERIFY, (_event, payload) => handleVerifyInvocation(payload));

	return () => {
		ipcMain.removeHandler(IPC.INTEGRATIONS_VERIFY);
	};
}

// Exported for unit tests.
export {
	authHeadersFor,
	classifyHttpStatus,
	handleVerifyInvocation,
	isVerifyPayload,
	probeUrlFor,
	verifyCredential,
};
