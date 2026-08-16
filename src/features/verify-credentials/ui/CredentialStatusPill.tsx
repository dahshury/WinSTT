import type { ReactNode } from "react";
import type { TranslateFn } from "@/shared/i18n/translation-types";
import { cn } from "@/shared/lib/cn";
import { surfaceBg } from "@/shared/lib/surface";
import { Spinner } from "@/shared/ui/spinner";
import { Tooltip } from "@/shared/ui/tooltip";

export type CredentialStatusKind =
	| "idle"
	| "verifying"
	| "verified"
	| "invalid"
	| "offline";

/** The six states a provider card's pill can display. Resolved by
 *  `resolveCredentialPillState` in the integrations widget — this component is
 *  deliberately dumb so the decision stays pure and unit-testable. */
export type CredentialPillState =
	| "connected"
	| "notConnected"
	| "rejected"
	| "unreachable"
	| "unverified"
	| "verifying";

export interface CredentialStatusPillProps {
	/** Surface step for the neutral pill fill, so it stays legible inside a card. */
	chipLevel: number;
	/** Probe detail (HTTP message / transport error) shown on hover. */
	lastError?: string | undefined;
	/** Display name interpolated into the "could not reach" copy. */
	providerLabel: string;
	state: CredentialPillState;
	t: TranslateFn;
}

const PILL_BASE =
	"inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs";

/**
 * Live connection state for one integration.
 *
 * It renders in EVERY state, including "no key yet" — the previous version
 * returned `null` whenever the probe was idle or the key field was empty, which
 * is why a provider row could look completely blank and leave the user with no
 * idea whether anything was configured.
 *
 * Grayscale by default (see the no-green-status preference): "Connected" earns a
 * solid dot and full-contrast text rather than a success colour. The error and
 * warning tokens stay reserved for the two failure states.
 */
export function CredentialStatusPill({
	chipLevel,
	lastError,
	providerLabel,
	state,
	t,
}: CredentialStatusPillProps) {
	const isFailure = state === "rejected" || state === "unreachable";
	const label =
		state === "verifying"
			? t("verifying")
			: state === "connected"
				? t("statusConnected")
				: state === "notConnected"
					? t("statusNotConnected")
					: state === "unverified"
						? t("statusUnverified")
						: state === "rejected"
							? t("statusKeyRejected")
							: t("statusUnreachable", { provider: providerLabel });
	const tone =
		state === "rejected"
			? "bg-error/15 text-error"
			: state === "unreachable"
				? "bg-warning/15 text-warning"
				: cn(
						state === "connected"
							? "text-foreground"
							: state === "unverified"
								? "text-foreground-secondary"
								: "text-foreground-muted",
						surfaceBg(chipLevel),
					);
	// Purely decorative: the label already says what the dot/spinner means, and an
	// announced spinner inside an announced pill is the same news twice.
	const leading: ReactNode =
		state === "verifying" ? (
			<Spinner aria-hidden="true" className="size-2.5 border" />
		) : state === "connected" ? (
			<span
				aria-hidden="true"
				className="size-1.5 rounded-full bg-foreground"
			/>
		) : state === "notConnected" ? (
			<span
				aria-hidden="true"
				className="size-1.5 rounded-full ring-1 ring-divider-strong ring-inset"
			/>
		) : null;

	const pill = (
		<span className={cn(PILL_BASE, tone)}>
			{leading}
			{label}
		</span>
	);

	// ONE live region, mounted for the component's whole life, with only its text
	// changing. Giving each state its own `role="status"` (as this did) destroys
	// and recreates the region on every transition: assistive tech then treats the
	// new region's existing content as an update, so static states get announced
	// as if something just happened, and a genuine change can be missed entirely.
	return (
		<span role="status">
			{isFailure && lastError ? (
				// The probe's own message is the only thing that explains WHICH failure
				// this is, but it is far too long for the pill — keep it on hover.
				<Tooltip content={lastError}>{pill}</Tooltip>
			) : (
				pill
			)}
		</span>
	);
}
