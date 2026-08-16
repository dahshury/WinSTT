import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { brandLogoFor } from "@/shared/ui/brand-logo";
import { CAPABILITY_MESSAGE } from "../lib/capability-messages";
import type {
	IntegrationProvider,
	ProviderCapability,
} from "../model/provider-capabilities";

export interface ProviderCardProps {
	capabilities: readonly ProviderCapability[];
	/** The credential row: a key row for the hosted providers, the endpoint row
	 *  for Ollama. */
	children: ReactNode;
	/** Always-visible one-liner. The whole point of the card: what this provider
	 *  buys you must not hide behind a hover tooltip. */
	description: string;
	/** Display name — also the card's accessible name. */
	name: string;
	provider: IntegrationProvider;
	statusPill: ReactNode;
}

function CapabilityChip({
	capability,
	chipLevel,
}: {
	capability: ProviderCapability;
	chipLevel: number;
}) {
	const t = useTranslations("integrations");
	const label = t(CAPABILITY_MESSAGE[capability.id]);
	// "In use" is carried by THREE independent signals — a tick glyph, the word
	// "Active", and the raised fill — so it never depends on colour alone
	// (WCAG 1.4.1), and the aria-label spells it out for screen readers.
	return (
		<li
			{...(capability.active
				? { "aria-label": t("capabilityActiveAria", { capability: label }) }
				: {})}
			className={cn(
				"inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs leading-none ring-1",
				capability.active
					? cn(
							"font-medium text-foreground ring-divider-strong",
							surfaceBg(chipLevel),
						)
					: "text-foreground-muted ring-divider",
			)}
		>
			{capability.active ? (
				<HugeiconsIcon aria-hidden="true" icon={Tick02Icon} size={10} />
			) : null}
			{label}
			{capability.active ? (
				<span className="text-foreground-muted">{t("capabilityActive")}</span>
			) : null}
		</li>
	);
}

/**
 * One integration, end to end: who it is, what it unlocks, whether it is
 * connected, and the credential row that changes that.
 *
 * Replaces the two drifted "API key + info tooltip" rows. Everything that used
 * to be hover-only — the description and the list of surfaces a key gates — is
 * now static body text, because the audit's core complaint was that "what each
 * of the providers actually unlocks" was a mystery.
 */
export function ProviderCard({
	capabilities,
	children,
	description,
	name,
	provider,
	statusPill,
}: ProviderCardProps) {
	const chipLevel = Math.min(useSurface() + 1, 8);
	return (
		<div
			aria-label={name}
			className="flex flex-col gap-3 rounded-xl bg-foreground/[0.03] p-4 ring-1 ring-divider"
			role="group"
		>
			<div className="flex items-start gap-2.5">
				<span className="flex shrink-0 items-center pt-0.5 text-foreground">
					{brandLogoFor(provider)}
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<h4 className="font-medium text-body text-foreground leading-tight">
						{name}
					</h4>
					<p className="text-body-sm text-foreground-muted leading-snug">
						{description}
					</p>
				</div>
				<div className="flex shrink-0 items-center">{statusPill}</div>
			</div>

			<ul className="flex flex-wrap items-center gap-1.5">
				{capabilities.map((capability) => (
					<CapabilityChip
						capability={capability}
						chipLevel={chipLevel}
						key={capability.id}
					/>
				))}
			</ul>

			{children}
		</div>
	);
}
