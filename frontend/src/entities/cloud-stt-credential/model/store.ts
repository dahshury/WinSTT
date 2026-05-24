import { create } from "zustand";
import { useSettingsStore } from "@/entities/setting/@x/cloud-stt-credential";
import type { CloudSttProvider } from "@/shared/api/models";

/**
 * Per-provider status for the cloud STT key probe.
 *
 *   - `idle`       — initial / after the key changed (no probe in flight)
 *   - `verifying`  — IPC probe in flight
 *   - `verified`   — last probe returned `{ ok: true }`
 *   - `invalid`    — last probe returned `{ ok: false, code: "auth"|"key_missing" }`
 *   - `offline`    — last probe failed due to network/transport (key may be fine)
 */
export type CredentialStatus = "idle" | "verifying" | "verified" | "invalid" | "offline";

export interface ProviderStatusEntry {
	lastError?: string | undefined;
	status: CredentialStatus;
}

interface CredentialStatusState {
	byProvider: Record<CloudSttProvider, ProviderStatusEntry>;
	reset: (provider: CloudSttProvider) => void;
	setStatus: (provider: CloudSttProvider, entry: ProviderStatusEntry) => void;
}

const INITIAL: Record<CloudSttProvider, ProviderStatusEntry> = {
	openai: { status: "idle" },
	elevenlabs: { status: "idle" },
};

export const useCredentialStatusStore = create<CredentialStatusState>()((set) => ({
	byProvider: INITIAL,
	setStatus: (provider, entry) =>
		set((state) => ({
			byProvider: { ...state.byProvider, [provider]: entry },
		})),
	reset: (provider) =>
		set((state) => ({
			byProvider: { ...state.byProvider, [provider]: { status: "idle" } },
		})),
}));

/**
 * Subscribe to settings so that any change to a provider's `apiKey` (other
 * than what the verifier just persisted alongside `verified`) resets the
 * in-memory status back to `idle`. We compare last-seen keys per provider
 * and only reset when one of them changed AND the status was not already
 * idle. This keeps a freshly typed key from staying "verified" against the
 * previous value.
 */
let lastKeys: Record<CloudSttProvider, string> = {
	openai: "",
	elevenlabs: "",
};

function syncOnSettingsChange(): void {
	const settings = useSettingsStore.getState().settings;
	const next: Record<CloudSttProvider, string> = {
		openai: settings.integrations.openai.apiKey,
		elevenlabs: settings.integrations.elevenlabs.apiKey,
	};
	const store = useCredentialStatusStore.getState();
	for (const provider of ["openai", "elevenlabs"] as CloudSttProvider[]) {
		if (next[provider] !== lastKeys[provider] && store.byProvider[provider].status !== "idle") {
			store.reset(provider);
		}
	}
	lastKeys = next;
}

if (typeof window !== "undefined") {
	// Seed lastKeys from whatever the settings store boots with so the first
	// real subscription-fired change (key edit) is the first reset trigger.
	const boot = useSettingsStore.getState().settings;
	lastKeys = {
		openai: boot.integrations.openai.apiKey,
		elevenlabs: boot.integrations.elevenlabs.apiKey,
	};
	useSettingsStore.subscribe(syncOnSettingsChange);
}

/** Hook returning the live status entry for a single provider. */
export function useCredentialStatus(provider: CloudSttProvider): ProviderStatusEntry {
	return useCredentialStatusStore((s) => s.byProvider[provider]);
}
