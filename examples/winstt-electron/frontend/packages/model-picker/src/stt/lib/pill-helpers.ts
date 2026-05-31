import type { ModelCacheInfo } from "@/shared/api/ipc-client";

export function quantCacheStatus(cache: ModelCacheInfo | undefined): string {
	if (cache?.state === "cached") {
		return "Downloaded";
	}
	if (cache?.state === "partial") {
		return `Partly downloaded (${Math.round((cache.progress ?? 0) * 100)}%)`;
	}
	return "Not downloaded";
}
