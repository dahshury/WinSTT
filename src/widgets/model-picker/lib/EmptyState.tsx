import { ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import {
	getEmptyStateBody,
	getEmptyStateLabel,
} from "./model-list-content-virtualized-utils/items";

export function EmptyState({
	hasActiveFilters,
}: {
	hasActiveFilters: boolean;
}): ReactNode {
	const level = Math.min(useSurface() + 1, 8);
	return (
		<div className="mx-auto flex w-full max-w-[280px] flex-col items-center gap-2 text-center">
			<div
				className={cn(
					"flex size-10 items-center justify-center rounded-full",
					surfaceBg(level),
				)}
			>
				<HugeiconsIcon
					className="size-5 text-foreground-muted"
					icon={ServerStack01Icon}
				/>
			</div>
			<p className="text-balance font-semibold text-body">
				{getEmptyStateLabel(hasActiveFilters)}
			</p>
			<p className="text-balance text-foreground-muted text-xs-tight">
				{getEmptyStateBody(hasActiveFilters)}
			</p>
		</div>
	);
}
