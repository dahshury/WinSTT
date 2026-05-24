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

function isVerifyPayload(value: unknown): value is VerifyCredentialPayload {
	if (!value || typeof value !== "object") {
		return false;
	}
	const obj = value as Record<string, unknown>;
	if (obj.provider !== "openai" && obj.provider !== "elevenlabs" && obj.provider !== "openrouter") {
		return false;
	}
	if (typeof obj.apiKey !== "string") {
		return false;
	}
	return true;
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

function classifyHttpStatus(status: number): "auth" | "rate_limit" | "provider_error" {
	if (status === 401 || status === 403) {
		return "auth";
	}
	if (status === 429) {
		return "rate_limit";
	}
	return "provider_error";
}

async function verifyCredential(
	provider: VerifiableProvider,
	apiKey: string
): Promise<VerifyCredentialResult> {
	const trimmed = apiKey.trim();
	if (!trimmed) {
		return { ok: false, code: "auth", message: "API key is empty" };
	}
	const url = probeUrlFor(provider);
	const headers = authHeadersFor(provider, trimmed);
	try {
		const response = await fetch(url, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
		});
		if (response.ok) {
			return { ok: true };
		}
		const code = classifyHttpStatus(response.status);
		let message = `HTTP ${response.status}`;
		try {
			const text = await response.text();
			if (text) {
				message = `HTTP ${response.status}: ${text.slice(0, 200)}`;
			}
		} catch {
			// Body unreadable — keep the HTTP-status-only message.
		}
		return { ok: false, code, message };
	} catch (err) {
		const message = getErrorMessage(err);
		dbg("credentials", `${provider} verify failed:`, message);
		return { ok: false, code: "network", message };
	}
}

export function setupCredentials(): () => void {
	const handleVerify = async (_event: unknown, payload: unknown) => {
		if (!isVerifyPayload(payload)) {
			return {
				ok: false as const,
				code: "provider_error" as const,
				message: "Invalid verify payload",
			};
		}
		return await verifyCredential(payload.provider, payload.apiKey);
	};

	ipcMain.handle(IPC.INTEGRATIONS_VERIFY, handleVerify);

	return () => {
		ipcMain.removeHandler(IPC.INTEGRATIONS_VERIFY);
	};
}

// Exported for unit tests.
export {
	authHeadersFor,
	classifyHttpStatus,
	isVerifyPayload,
	probeUrlFor,
	VERIFY_TIMEOUT_MS,
	verifyCredential,
};
