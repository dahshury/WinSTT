import type {
	FitAssessmentEntry,
	ModelStateEntry,
	SystemInfoEntry,
} from "@/shared/api/ipc-client";

function systemHasGpu(sys: SystemInfoEntry | null): boolean {
	return sys !== null && sys.gpus.length > 0;
}

function fitsSomewhere(
	entry: ModelStateEntry,
	sys: SystemInfoEntry | null,
): boolean {
	const onGpu = systemHasGpu(sys) && entry.comfortable_on_gpu;
	return onGpu || entry.comfortable_on_cpu;
}

/** True when the model's estimated footprint won't fit comfortably on the host.
 *
 * If a live ``FitAssessmentEntry`` is provided, prefer its verdict — it
 * accounts for currently-loaded models and live free RAM/VRAM, which the
 * static ``comfortable_on_*`` flags don't. Otherwise fall back to the
 * static totals-based check. */
export function isUncomfortable(
	entry: ModelStateEntry | undefined,
	sys: SystemInfoEntry | null,
	live?: FitAssessmentEntry | null,
): boolean {
	if (live) {
		return live.severity === "critical";
	}
	if (!entry || entry.estimated_bytes <= 0) {
		return false;
	}
	return !fitsSomewhere(entry, sys);
}

/** Three-tier classification for a per-row badge. Live assessment takes
 * priority; falls back to the binary "fits somewhere" for legacy callers. */
export function severityFor(
	entry: ModelStateEntry | undefined,
	sys: SystemInfoEntry | null,
	live?: FitAssessmentEntry | null,
): "ok" | "warning" | "critical" {
	if (live) {
		return live.severity;
	}
	return isUncomfortable(entry, sys) ? "critical" : "ok";
}
