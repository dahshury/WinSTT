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
 *
 * ElevenLabs scoped-key caveat: ElevenLabs lets users mint permission-scoped
 * API keys. A key granted only e.g. text-to-speech returns 401 with body
 * `{"detail":{"status":"missing_permissions",…}}` on read endpoints like
 * /v1/user — but that response PROVES the key authenticated; it merely lacks
 * read scope on the probe endpoint. A genuinely bad key returns
 * `invalid_api_key` instead. So for ElevenLabs we treat a missing_permissions
 * 401 as a VALID credential (see `isElevenLabsScopedKeyValid`). Verified
 * against the live API 2026-05-30. Whether the key actually grants the
 * `voices_read` scope cloud TTS needs is decided downstream in the TTS section
 * (see `widgets/tts-settings` — it fetches the voice list and surfaces a
 * missing-permission notice), NOT here: this probe only proves authentication.
 */
import { ipcMain } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";
import { getErrorMessage } from "../../src/shared/lib/errors";
import {
	authHeadersFor,
	type CloudHttpProvider,
	classifyHttpStatus,
} from "../lib/cloud-provider-http";
import { dbg } from "../lib/debug-log";

/** Providers the verify-credentials IPC accepts. STT providers (`openai` /
 *  `elevenlabs`) plus `openrouter`, which is an LLM credential but shares the
 *  same probe-and-classify shape. Aliased to the shared `CloudHttpProvider`
 *  union so the auth-header + status-classify helpers apply unchanged. */
type VerifiableProvider = CloudHttpProvider;

type VerifyCredentialResult =
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

/** Read the response body once, defensively. Returns "" if unreadable. A
 *  Response body can only be consumed once, so callers that need both the
 *  classified failure AND the scoped-key check must share this single read. */
async function safeReadBody(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "";
	}
}

/**
 * True when an ElevenLabs 401 body signals a valid-but-scoped key. ElevenLabs
 * returns `{"detail":{"status":"missing_permissions",…}}` when the key
 * authenticated successfully but lacks read scope on the probe endpoint — the
 * credential is still valid for what it IS scoped to (e.g. text-to-speech). A
 * genuinely bad key returns `invalid_api_key`; a missing key
 * `needs_authorization`. Only `missing_permissions` proves authentication.
 */
function isElevenLabsScopedKeyValid(status: number, bodyText: string): boolean {
	if (status !== 401) {
		return false;
	}
	try {
		const parsed = JSON.parse(bodyText) as { detail?: { status?: unknown } };
		return parsed?.detail?.status === "missing_permissions";
	} catch {
		return false;
	}
}

function buildFailureFromBody(status: number, bodyText: string): VerifyCredentialResult {
	const code = classifyHttpStatus(status);
	// Body unreadable / empty — keep the HTTP-status-only message.
	const suffix = bodyText ? `: ${bodyText.slice(0, 200)}` : "";
	return { ok: false, code, message: `HTTP ${status}${suffix}` };
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
	const bodyText = await safeReadBody(response);
	// A scoped ElevenLabs key 401s on /v1/user yet is perfectly valid for TTS —
	// accept it rather than reporting a false "invalid key". See file header.
	if (provider === "elevenlabs" && isElevenLabsScopedKeyValid(response.status, bodyText)) {
		return { ok: true };
	}
	return buildFailureFromBody(response.status, bodyText);
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
	isElevenLabsScopedKeyValid,
	isVerifyPayload,
	probeUrlFor,
	verifyCredential,
};
