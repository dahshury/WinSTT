import { create } from "zustand";
import { useSettingsStore } from "@/entities/setting/@x/cloud-stt-credential";
import type { IntegrationCloudProvider } from "@/shared/api/models";

/**
 * Per-provider status for the cloud STT key probe.
 *
 *   - `idle`       — initial / after the key changed (no probe in flight)
 *   - `verifying`  — IPC probe in flight
 *   - `verified`   — last probe returned `{ ok: true }`
 *   - `invalid`    — last probe returned `{ ok: false, code: "auth"|"key_missing" }`
 *   - `offline`    — last probe failed due to network/transport (key may be fine)
 */
export type CredentialStatus =
	| "idle"
	| "verifying"
	| "verified"
	| "invalid"
	| "offline";

export interface ProviderStatusEntry {
	lastError?: string | undefined;
	status: CredentialStatus;
}

interface CredentialStatusState {
	byProvider: Record<IntegrationCloudProvider, ProviderStatusEntry>;
	reset: (provider: IntegrationCloudProvider) => void;
	setStatus: (provider: IntegrationCloudProvider, entry: ProviderStatusEntry) => void;
}

const INITIAL: Record<IntegrationCloudProvider, ProviderStatusEntry> = {
	elevenlabs: { status: "idle" },
};

export const useCredentialStatusStore = create<CredentialStatusState>()(
	(set) => ({
		byProvider: INITIAL,
		setStatus: (provider, entry) =>
			set((state) => ({
				byProvider: { ...state.byProvider, [provider]: entry },
			})),
		reset: (provider) =>
			set((state) => ({
				byProvider: { ...state.byProvider, [provider]: { status: "idle" } },
			})),
	}),
);

/**
 * Subscribe to settings so that any change to a provider's `apiKey` (other
 * than what the verifier just persisted alongside `verified`) resets the
 * in-memory status back to `idle`. We compare last-seen keys per provider
 * and only reset when one of them changed AND the status was not already
 * idle. This keeps a freshly typed key from staying "verified" against the
 * previous value.
 */
let lastKeys: Record<IntegrationCloudProvider, string> = {
	elevenlabs: "",
};

/**
 * Snapshot of the per-provider API-key pair carried in settings. Pulled out
 * so `syncOnSettingsChange` doesn't have to construct it inline.
 */
function readApiKeySnapshot(settings: {
	integrations: {
		elevenlabs: { apiKey: string };
	};
}): Record<IntegrationCloudProvider, string> {
	return {
		elevenlabs: settings.integrations.elevenlabs.apiKey,
	};
}

const CLOUD_PROVIDERS: readonly IntegrationCloudProvider[] = ["elevenlabs"];

/**
 * True when `provider`'s key changed since the last sync AND its previous
 * status wasn't already `idle` — i.e. a freshly typed key shouldn't keep
 * masquerading as "verified" against the previous value.
 */
function providerNeedsReset(
	provider: IntegrationCloudProvider,
	next: Record<IntegrationCloudProvider, string>,
	prev: Record<IntegrationCloudProvider, string>,
	store: CredentialStatusState,
): boolean {
	return (
		next[provider] !== prev[provider] &&
		store.byProvider[provider].status !== "idle"
	);
}

/**
 * Reset every provider whose key changed since the last tick, but only when
 * its current status is not already `idle`. Pulled out of
 * `syncOnSettingsChange` so the subscriber stays trivially branchy.
 */
function resetProvidersWithChangedKeys(
	next: Record<IntegrationCloudProvider, string>,
	prev: Record<IntegrationCloudProvider, string>,
	store: CredentialStatusState,
): void {
	for (const provider of CLOUD_PROVIDERS) {
		if (providerNeedsReset(provider, next, prev, store)) {
			store.reset(provider);
		}
	}
}

function syncOnSettingsChange(): void {
	const next = readApiKeySnapshot(useSettingsStore.getState().settings);
	resetProvidersWithChangedKeys(
		next,
		lastKeys,
		useCredentialStatusStore.getState(),
	);
	lastKeys = next;
}

if (typeof window !== "undefined") {
	// Seed lastKeys from whatever the settings store boots with so the first
	// real subscription-fired change (key edit) is the first reset trigger.
	const boot = useSettingsStore.getState().settings;
	lastKeys = {
		elevenlabs: boot.integrations.elevenlabs.apiKey,
	};
	useSettingsStore.subscribe(syncOnSettingsChange);
}

/** Hook returning the live status entry for a single provider. */
export function useCredentialStatus(
	provider: IntegrationCloudProvider,
): ProviderStatusEntry {
	return useCredentialStatusStore((s) => s.byProvider[provider]);
}
