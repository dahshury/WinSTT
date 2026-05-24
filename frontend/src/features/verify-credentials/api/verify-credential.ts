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
	const settingsStore = useSettingsStore.getState();

	if (apiKey.trim().length === 0) {
		credStore.setStatus(provider, { status: "idle" });
		return { ok: false, code: "key_missing", message: "No API key configured" };
	}

	credStore.setStatus(provider, { status: "verifying" });

	let response: VerifyResponse;
	try {
		response = await ipcInvoke<VerifyResponse>(IPC.INTEGRATIONS_VERIFY, { provider, apiKey });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		credStore.setStatus(provider, { status: "offline", lastError: message });
		return { ok: false, code: "network", message };
	}

	if (response.ok) {
		credStore.setStatus(provider, { status: "verified" });
		settingsStore.updateIntegrations({
			[provider]: { verified: true, lastVerifiedAt: Date.now() },
		});
		return response;
	}

	if (response.code === "network") {
		credStore.setStatus(provider, { status: "offline", lastError: response.message });
		return response;
	}

	credStore.setStatus(provider, { status: "invalid", lastError: response.message });
	settingsStore.updateIntegrations({
		[provider]: { verified: false, lastVerifiedAt: Date.now() },
	});
	return response;
}
