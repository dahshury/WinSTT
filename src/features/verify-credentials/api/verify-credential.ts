import { commands } from "@/bindings";
import { useCredentialStatusStore } from "@/entities/cloud-stt-credential";
import { useSettingsStore } from "@/entities/setting";
import type {
	CloudSttErrorCode,
	CloudSttProvider,
	IntegrationCloudProvider,
} from "@/shared/api/models";

interface VerifyResponse {
	code?: CloudSttErrorCode;
	message?: string;
	ok: boolean;
}

/**
 * The ONE renderer verify seam — calls the generated `verify_credential`
 * binding directly (no IPC string channel) and collapses its tauri-specta
 * `Result` to the bare `VerifyResponse`: `ok` → the payload; `error` → THROW
 * (the caller's `try/catch` maps it to `{ ok:false, code:"network" }`), exactly
 * as the old `ipcInvoke(INTEGRATIONS_VERIFY)` → `unwrapResult` did. Shared by
 * every verify call site so the unwrap rule lives in one place.
 */
export async function verifyCredentialCommand(
	provider: CloudSttProvider,
	apiKey: string,
): Promise<VerifyResponse> {
	const result = await commands.verifyCredential(provider, apiKey);
	if (result.status === "error") {
		throw result.error;
	}
	const { ok, code, message } = result.data;
	return {
		ok,
		...(code != null ? { code: code as CloudSttErrorCode } : {}),
		...(message != null ? { message } : {}),
	};
}

/** Stable response when the API key is blank — never hits IPC. */
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
 * failures.
 */
export async function invokeVerify(
	provider: IntegrationCloudProvider,
	apiKey: string,
): Promise<VerifyResponse> {
	try {
		return await verifyCredentialCommand(provider, apiKey);
	} catch (err) {
		const message = errorMessage(err);
		return { ok: false, code: "network", message };
	}
}

/** Persist the verified/invalid flag and update settings for a provider. */
function persistVerifiedSetting(
	provider: IntegrationCloudProvider,
	verified: boolean,
): void {
	useSettingsStore.getState().updateIntegrations({
		[provider]: { verified, lastVerifiedAt: Date.now() },
	});
}

/** Apply the per-status side effects when verify succeeds. */
function commitVerifiedResult(provider: IntegrationCloudProvider): void {
	useCredentialStatusStore
		.getState()
		.setStatus(provider, { status: "verified" });
	persistVerifiedSetting(provider, true);
}

/** Apply the per-status side effects for an offline (network) result. */
function commitOfflineResult(
	provider: IntegrationCloudProvider,
	message: string | undefined,
): void {
	useCredentialStatusStore
		.getState()
		.setStatus(provider, { status: "offline", lastError: message });
}

/** Apply the per-status side effects when the key is invalid. */
function commitInvalidResult(
	provider: IntegrationCloudProvider,
	message: string | undefined,
): void {
	useCredentialStatusStore
		.getState()
		.setStatus(provider, { status: "invalid", lastError: message });
	persistVerifiedSetting(provider, false);
}

/**
 * Route a probe response into the appropriate state mutation. Centralised
 * so the entry point stays linear and the routing rule is testable in
 * isolation (three branches: ok / network / invalid).
 */
export function applyVerifyResponse(
	provider: IntegrationCloudProvider,
	response: VerifyResponse,
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
	provider: IntegrationCloudProvider,
	apiKey: string,
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
