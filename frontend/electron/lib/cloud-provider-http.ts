/**
 * Shared HTTP primitives for authenticated cloud-provider REST calls from the
 * main process (the credential auth probe in `ipc/credentials.ts`). Kept
 * provider-agnostic so auth-header construction and status-code classification
 * live in one place — one source of truth for "how do we authenticate against
 * provider X".
 */

/** Providers we make authenticated REST calls to from the main process.
 *  STT providers (`openai` / `elevenlabs`) plus `openrouter` (an LLM
 *  credential that shares the same Bearer-auth + classify shape). */
export type CloudHttpProvider = "openai" | "elevenlabs" | "openrouter";

export function authHeadersFor(
	provider: CloudHttpProvider,
	apiKey: string
): Record<string, string> {
	if (provider === "elevenlabs") {
		// ElevenLabs uses a custom header, not Bearer auth.
		return { "xi-api-key": apiKey };
	}
	// OpenAI and OpenRouter both use standard Bearer auth.
	return { Authorization: `Bearer ${apiKey}` };
}

const AUTH_STATUS_CODES = new Set([401, 403]);

export function classifyHttpStatus(status: number): "auth" | "rate_limit" | "provider_error" {
	if (AUTH_STATUS_CODES.has(status)) {
		return "auth";
	}
	if (status === 429) {
		return "rate_limit";
	}
	return "provider_error";
}
