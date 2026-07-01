import type { TranslateFn } from "@/shared/i18n/translation-types";
import { cn } from "@/shared/lib/cn";
import { surfaceBg } from "@/shared/lib/surface";
import { Spinner } from "@/shared/ui/spinner";

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
		return (
			<span
				className="rounded-sm bg-error/15 px-1.5 py-0.5 text-2xs text-error"
				title={status.lastError}
			>
				{t("invalid")}
			</span>
		);
	}
	if (status.status === "offline") {
		return (
			<span
				className="rounded-sm bg-warning/15 px-1.5 py-0.5 text-2xs text-warning"
				title={status.lastError}
			>
				{t("couldNotVerify")}
			</span>
		);
	}
	return null;
}
