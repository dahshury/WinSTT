import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import type { ModelCacheInfo } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { Tooltip } from "@/shared/ui/tooltip";

interface PillProps {
	children: ReactNode;
	className?: string;
	icon?: IconSvgElement;
	tooltip?: string;
}

export function Pill({ icon, children, className, tooltip }: PillProps) {
	const content = (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium text-[10.5px] leading-none",
				className
			)}
		>
			{icon ? <HugeiconsIcon className="size-3 shrink-0" icon={icon} /> : null}
			{children}
		</span>
	);
	if (!tooltip) {
		return content;
	}
	return (
		<Tooltip content={tooltip} side="top">
			<span className="inline-flex">{content}</span>
		</Tooltip>
	);
}

const QUANT_DOT_CLASS: Record<ModelCacheInfo["state"], string> = {
	cached: "bg-emerald-500",
	partial: "bg-amber-500",
	not_cached: "bg-transparent ring-1 ring-border",
};

/** Tiny status dot showing what's on disk for one precision. */
export function QuantCacheDot({ cache }: { cache: ModelCacheInfo | undefined }) {
	const state = cache?.state ?? "not_cached";
	return <span className={cn("size-1.5 shrink-0 rounded-full", QUANT_DOT_CLASS[state])} />;
}

/**
 * Compact "NN%" label rendered inline on a precision pill when the cache
 * is partial. Hidden for "cached" / "not_cached" — the coloured dot
 * already conveys those two cleanly. Pulling the percent on screen lets
 * users compare resumable downloads at a glance without hovering each
 * pill to read the tooltip.
 */
export function QuantCachePercent({ cache }: { cache: ModelCacheInfo | undefined }) {
	if (cache?.state !== "partial") {
		return null;
	}
	const percent = Math.round((cache.progress ?? 0) * 100);
	return (
		<span className="font-medium text-[10px] text-amber-600 tabular-nums leading-none dark:text-amber-400">
			{percent}%
		</span>
	);
}

export function quantCacheStatus(cache: ModelCacheInfo | undefined): string {
	if (cache?.state === "cached") {
		return "Downloaded";
	}
	if (cache?.state === "partial") {
		return `Partly downloaded (${Math.round((cache.progress ?? 0) * 100)}%)`;
	}
	return "Not downloaded";
}
