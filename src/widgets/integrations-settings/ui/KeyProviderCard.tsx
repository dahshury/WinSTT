import { useTranslations } from "use-intl";
import { providerDisplayName } from "@/entities/cloud-stt-provider";
import type { ClearableProvider } from "@/features/revert-cloud-on-key-removal";
import { CredentialStatusPill } from "@/features/verify-credentials";
import { useSurface } from "@/shared/lib/surface";
import { resolveCredentialPillState } from "../lib/credential-display";
import { useProviderCapabilities } from "../model/use-provider-capabilities";
import { useProviderCredential } from "../model/use-provider-credential";
import { ProviderCard } from "./ProviderCard";
import { ProviderKeyRow } from "./ProviderKeyRow";

export interface KeyProviderCardProps {
	/** Always-visible one-liner describing what this key unlocks. */
	description: string;
	/** Accessible name for the editable key field, e.g. "OpenRouter API Key". */
	keyLabel: string;
	/** Key-shape hint; also the source of the sealed display's visible prefix. */
	placeholder: string;
	provider: ClearableProvider;
}

/**
 * A hosted provider's card: identity + capabilities + status pill + key row.
 *
 * The credential state machine is instantiated HERE, once, and shared with the
 * row — the pill and the field are two views of the same state, and a second
 * hook call would give them separate drafts.
 */
export function KeyProviderCard({
	description,
	keyLabel,
	placeholder,
	provider,
}: KeyProviderCardProps) {
	const t = useTranslations("integrations");
	const capabilities = useProviderCapabilities(provider);
	const credential = useProviderCredential(provider);
	// Same step the capability chips take inside ProviderCard, so the pill and the
	// chips read as one row of chrome rather than two elevations.
	const chipLevel = Math.min(useSurface() + 1, 8);
	const providerLabel = providerDisplayName(provider);

	return (
		<ProviderCard
			capabilities={capabilities}
			description={description}
			name={providerLabel}
			provider={provider}
			statusPill={
				<CredentialStatusPill
					chipLevel={chipLevel}
					lastError={credential.live.lastError}
					providerLabel={providerLabel}
					state={resolveCredentialPillState({
						hasCredential: credential.hasKey,
						persistedVerified: credential.persistedVerified,
						status: credential.live.status,
					})}
					t={t}
				/>
			}
		>
			<ProviderKeyRow
				capabilities={capabilities}
				credential={credential}
				keyLabel={keyLabel}
				placeholder={placeholder}
				provider={provider}
				providerLabel={providerLabel}
			/>
		</ProviderCard>
	);
}
