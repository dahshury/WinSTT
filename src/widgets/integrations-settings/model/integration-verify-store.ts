import { create } from "zustand";
import type { CredentialStatusKind } from "@/features/verify-credentials";
import type { IntegrationProvider } from "./provider-capabilities";

export interface IntegrationVerifyEntry {
	lastError?: string | undefined;
	status: CredentialStatusKind;
}

interface IntegrationVerifyState {
	byProvider: Record<IntegrationProvider, IntegrationVerifyEntry>;
	setStatus: (
		provider: IntegrationProvider,
		entry: IntegrationVerifyEntry,
	) => void;
}

const IDLE: IntegrationVerifyEntry = { status: "idle" };

/**
 * Live probe status for every provider card, held at MODULE level rather than in
 * component state.
 *
 * This is what un-drifts the two key rows. `useCredentialStatusStore` (the
 * cloud-stt-credential entity) is keyed by `IntegrationCloudProvider`, which
 * excludes OpenRouter — so OpenRouter's verdict used to live in component state
 * and evaporated on every remount, and Base UI's `Tabs.Panel` unmounts inactive
 * panels, meaning a *rejected* OpenRouter key read as clean-and-sealed the
 * moment the user switched tabs and back. A module-level store survives that.
 *
 * It is NOT persistence: a verdict still resets on app restart. ElevenLabs
 * additionally writes `integrations.elevenlabs.verified` to disk, and the pill
 * falls back to that (see `resolveCredentialPillState`). OpenRouter has no such
 * settings field, so its verdict is session-scoped until one exists.
 */
export const useIntegrationVerifyStore = create<IntegrationVerifyState>()(
	(set) => ({
		byProvider: { elevenlabs: IDLE, ollama: IDLE, openrouter: IDLE },
		setStatus: (provider, entry) =>
			set((state) => ({
				byProvider: { ...state.byProvider, [provider]: entry },
			})),
	}),
);

export function useIntegrationVerifyStatus(
	provider: IntegrationProvider,
): IntegrationVerifyEntry {
	return useIntegrationVerifyStore((s) => s.byProvider[provider]);
}
