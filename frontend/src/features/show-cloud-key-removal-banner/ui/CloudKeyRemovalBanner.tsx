"use client";

import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { providerDisplayName } from "@/entities/cloud-stt-provider";
import { useCloudKeyRemovalGuard } from "./use-cloud-key-removal-guard";

/**
 * Sticky red banner rendered at the root layout. Surfaces only when the
 * active main STT model is a cloud `provider:*` AND the user just removed
 * that provider's API key — letting them know dictation will fail until
 * they restore the key OR switch model. Per brief we do NOT auto-switch.
 *
 * Auto-clears when the precondition resolves.
 */
export function CloudKeyRemovalBanner() {
	const notice = useCloudKeyRemovalGuard();
	const t = useTranslations("integrations");

	if (!notice) {
		return null;
	}

	return (
		<div
			aria-live="assertive"
			className="pointer-events-auto fixed top-12 left-1/2 z-toast w-[460px] max-w-[90vw] -translate-x-1/2 rounded-md border border-error/40 bg-surface-secondary p-3 shadow-lg"
			role="alert"
		>
			<div className="flex items-start gap-2">
				<HugeiconsIcon
					aria-hidden="true"
					className="mt-0.5 shrink-0 text-error"
					icon={AlertCircleIcon}
					size={16}
				/>
				<span className="text-body text-foreground">
					{t("keyRemovedMidSession", { provider: providerDisplayName(notice.provider) })}
				</span>
			</div>
		</div>
	);
}
