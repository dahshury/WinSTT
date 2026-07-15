"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";
import { Tooltip } from "@/shared/ui/tooltip";

/**
 * The always-visible "Suggested" chip rendered NEXT TO the filter trigger in
 * the search bar. Shares the exact same `suggestedOnly` state as the menu
 * checkbox — a one-tap toggle for the default-on recommender filter. Shared
 * by the STT and Ollama pickers (threaded via `filtersLeadingSlot`).
 */
export function SuggestedFilterChip({
	active,
	onToggle,
}: {
	active: boolean;
	onToggle: () => void;
}) {
	const t = useTranslations("modelPicker");
	return (
		<Tooltip content={t("suggestedChipTooltip")} side="bottom">
			<BaseButton
				aria-label={t("suggested")}
				aria-pressed={active}
				className={cn(
					"inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border px-2",
					"font-medium text-[11px] leading-none outline-none transition-colors",
					"focus-visible:ring-2 focus-visible:ring-accent/50",
					active
						? "border-accent/40 bg-accent/10 text-accent hover:bg-accent/15"
						: "border-border/60 bg-foreground/[0.055] text-foreground-secondary hover:bg-foreground/[0.09] hover:text-foreground",
				)}
				data-active={active ? "" : undefined}
				data-slot="suggested-filter-chip"
				onClick={onToggle}
				type="button"
			>
				<HugeiconsIcon
					aria-hidden="true"
					className="size-3"
					icon={SparklesIcon}
				/>
				<span>{t("suggested")}</span>
			</BaseButton>
		</Tooltip>
	);
}
