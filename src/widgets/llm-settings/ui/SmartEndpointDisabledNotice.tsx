"use client";

import { InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import {
	ToastDismissButton,
	ToastShell,
	useAutoDismiss,
} from "@/shared/ui/toast";
import { useSmartEndpointDisabledNoticeStore } from "@/widgets/llm-settings/model/use-llm-settings-panel";

const AUTO_DISMISS_MS = 8000;

/**
 * Informational notice (audit #22): enabling LLM dictation post-processing
 * auto-disabled Smart Endpoint in Recording settings because the two can't both
 * finalize speech. The switch happens silently in the store, so surface it so
 * the user understands why a Recording setting changed. Neutral tone — this is
 * an explained side effect, not an error. Single-slot; auto-dismisses after 8s.
 *
 * Mounted in the settings window, where the LLM panel drives the toggle.
 */
export function SmartEndpointDisabledNotice() {
	const current = useSmartEndpointDisabledNoticeStore((s) => s.current);
	const clear = useSmartEndpointDisabledNoticeStore((s) => s.clear);
	const t = useTranslations("llm");

	useAutoDismiss(current, clear, AUTO_DISMISS_MS);

	if (!current) {
		return null;
	}

	return (
		<ToastShell
			ariaLive="polite"
			className="fixed right-4 bottom-4 z-toast w-[420px] max-w-[90vw]"
			tone="neutral"
		>
			<div className="flex items-start gap-2">
				<HugeiconsIcon
					aria-hidden="true"
					className="mt-0.5 shrink-0 text-foreground-secondary"
					icon={InformationCircleIcon}
					size={16}
				/>
				<div className="flex flex-1 flex-col">
					<span className="font-medium text-body text-foreground">
						{t("smartEndpointDisabledTitle")}
					</span>
					<span className="text-foreground-muted text-sm">
						{t("smartEndpointDisabledBody")}
					</span>
				</div>
				<ToastDismissButton onClick={clear} />
			</div>
		</ToastShell>
	);
}
