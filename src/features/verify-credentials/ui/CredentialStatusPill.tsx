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

export interface CredentialStatusPillProps {
	apiKey: string;
	chipLevel: number;
	status: {
		lastError?: string | undefined;
		status: CredentialStatusKind;
	};
	t: TranslateFn;
}

export function CredentialStatusPill({
	apiKey,
	chipLevel,
	status,
	t,
}: CredentialStatusPillProps) {
	if (status.status === "verifying") {
		return (
			<span
				className={cn(
					"inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs text-foreground-muted",
					surfaceBg(chipLevel),
				)}
			>
				<Spinner className="size-2.5 border" />
				{t("verifying")}
			</span>
		);
	}
	if (apiKey.trim().length === 0) {
		return null;
	}
	if (status.status === "verified") {
		return (
			<span className="rounded-sm bg-success/15 px-1.5 py-0.5 text-2xs text-success">
				{t("verified")}
			</span>
		);
	}
	if (status.status === "invalid") {
		const pill = (
			<span className="rounded-sm bg-error/15 px-1.5 py-0.5 text-2xs text-error">
				{t("invalid")}
			</span>
		);
		return status.lastError ? (
			<Tooltip content={status.lastError}>{pill}</Tooltip>
		) : (
			pill
		);
	}
	if (status.status === "offline") {
		const pill = (
			<span className="rounded-sm bg-warning/15 px-1.5 py-0.5 text-2xs text-warning">
				{t("couldNotVerify")}
			</span>
		);
		return status.lastError ? (
			<Tooltip content={status.lastError}>{pill}</Tooltip>
		) : (
			pill
		);
	}
	return null;
}
