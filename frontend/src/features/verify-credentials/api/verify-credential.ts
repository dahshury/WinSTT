import { useCredentialStatusStore } from "@/entities/cloud-stt-credential";
import { useSettingsStore } from "@/entities/setting";
import { IPC } from "@/shared/api/ipc-channels";
import { ipcInvoke } from "@/shared/api/ipc-client";
import type { CloudSttErrorCode, CloudSttProvider } from "@/shared/api/models";

interface VerifyResponse {
	code?: CloudSttErrorCode;
	message?: string;
	ok: boolean;
}

/** Stable response when the API key is blank — never hits IPC (CC 1). */
export function missingKeyResponse(): VerifyResponse {
	return { ok: false, code: "key_missing", message: "No API key configured" };
}

/** Extract the message from a thrown value (string fallback for non-Errors). */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Probe the provider's auth endpoint via the main process. Returns the raw
 * `VerifyResponse` or a synthetic `{ok:false, code:"network"}` for transport
 * failures (CC 2 — one `try/catch`).
 */
export async function invokeVerify(
	provider: CloudSttProvider,
	apiKey: string
): Promise<VerifyResponse> {
	try {
		return await ipcInvoke<VerifyResponse>(IPC.INTEGRATIONS_VERIFY, { provider, apiKey });
	} catch (err) {
		const message = errorMessage(err);
		return { ok: false, code: "network", message };
	}
}

/** Persist the verified/invalid flag and update settings for a provider. */
function persistVerifiedSetting(provider: CloudSttProvider, verified: boolean): void {
	useSettingsStore.getState().updateIntegrations({
		[provider]: { verified, lastVerifiedAt: Date.now() },
	});
}

/** Apply the per-status side effects when verify succeeds (CC 1). */
function commitVerifiedResult(provider: CloudSttProvider): void {
	useCredentialStatusStore.getState().setStatus(provider, { status: "verified" });
	persistVerifiedSetting(provider, true);
}

/** Apply the per-status side effects for an offline (network) result (CC 1). */
function commitOfflineResult(provider: CloudSttProvider, message: string | undefined): void {
	useCredentialStatusStore
		.getState()
		.setStatus(provider, { status: "offline", lastError: message });
}

/** Apply the per-status side effects when the key is invalid (CC 1). */
function commitInvalidResult(provider: CloudSttProvider, message: string | undefined): void {
	useCredentialStatusStore
		.getState()
		.setStatus(provider, { status: "invalid", lastError: message });
	persistVerifiedSetting(provider, false);
}

/**
 * Route a probe response into the appropriate state mutation. Centralised
 * so the entry point stays linear and the routing rule is testable in
 * isolation (CC 3 — three branches: ok / network / invalid).
 */
export function applyVerifyResponse(
	provider: CloudSttProvider,
	response: VerifyResponse
): VerifyResponse {
	if (response.ok) {
		commitVerifiedResult(provider);
		return response;
	}
	if (response.code === "network") {
		commitOfflineResult(provider, response.message);
		return response;
	}
	commitInvalidResult(provider, response.message);
	return response;
}

/**
 * Probe the provider's auth endpoint via the main process and update both
 * the in-memory `useCredentialStatusStore` and the persisted settings
 * (`verified` / `lastVerifiedAt`). Returns the raw response so the caller
 * (typically a button onClick) can decide whether to surface an inline
 * error message.
 *
 * Network/transport failures map to `offline` so the UI can distinguish
 * "your key is wrong" from "we couldn't reach the provider right now".
 */
export async function verifyCredential(
	provider: CloudSttProvider,
	apiKey: string
): Promise<VerifyResponse> {
	const credStore = useCredentialStatusStore.getState();

	if (apiKey.trim().length === 0) {
		credStore.setStatus(provider, { status: "idle" });
		return missingKeyResponse();
	}

	credStore.setStatus(provider, { status: "verifying" });
	const response = await invokeVerify(provider, apiKey);
	return applyVerifyResponse(provider, response);
}

export type { VerifyResponse };
