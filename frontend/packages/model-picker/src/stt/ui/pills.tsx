"use client";

import type { ModelCacheInfo } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";

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
