import type { ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";

function systemHasGpu(sys: SystemInfoEntry | null): boolean {
	return sys !== null && sys.gpus.length > 0;
}

function fitsSomewhere(entry: ModelStateEntry, sys: SystemInfoEntry | null): boolean {
	const onGpu = systemHasGpu(sys) && entry.comfortable_on_gpu;
	return onGpu || entry.comfortable_on_cpu;
}

/** True when the model's estimated footprint won't fit comfortably on the host. */
export function isUncomfortable(
	entry: ModelStateEntry | undefined,
	sys: SystemInfoEntry | null
): boolean {
	if (!entry || entry.estimated_bytes <= 0) {
		return false;
	}
	return !fitsSomewhere(entry, sys);
}
