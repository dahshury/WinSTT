/**
 * Render-side helpers for turning a ``FitAssessmentEntry`` into something
 * a model-picker row can show. The badge text is intentionally compact
 * (single token) so it fits inline with the model name and size label;
 * fuller details live in the warning modal.
 */

import type { FitAssessmentEntry, FitSeverity } from "@/shared/api/ipc-client";
import { formatBytes } from "@/shared/lib/format-bytes";

export interface FitBadge {
	glyph: string;
	severity: FitSeverity;
	tone: "neutral" | "warning" | "error";
}

const SEVERITY_TO_BADGE: Record<FitSeverity, FitBadge> = {
	ok: { glyph: "✓", severity: "ok", tone: "neutral" },
	warning: { glyph: "⚠", severity: "warning", tone: "warning" },
	critical: { glyph: "⛔", severity: "critical", tone: "error" },
};

export function badgeFor(assessment: FitAssessmentEntry | null): FitBadge | null {
	if (!assessment) {
		return null;
	}
	return SEVERITY_TO_BADGE[assessment.severity];
}

/** Compact per-row hint: "~600 MB · fits on GPU", "~12 GB · ⚠ tight on CPU",
 * "~30 GB · ⛔ exceeds VRAM (24 GB free)". Empty string when there's no
 * useful info (unknown footprint with no resource probe). */
export function rowHint(
	assessment: FitAssessmentEntry | null,
	t: (key: string, vars?: Record<string, string | number>) => string
): string {
	if (!assessment || assessment.required_bytes <= 0) {
		return "";
	}
	const reqLabel = formatBytes(assessment.required_bytes, { minUnit: "MB" }) ?? "?";
	const availLabel = formatBytes(assessment.available_bytes, { minUnit: "MB" }) ?? "?";
	const target = assessment.target;
	const targetLabel =
		target === "gpu" ? t("targetGpu") : target === "cpu" ? t("targetCpu") : t("targetNeither");
	if (assessment.severity === "ok") {
		return t("rowHintOk", { req: reqLabel, target: targetLabel });
	}
	if (assessment.severity === "warning") {
		return t("rowHintWarning", { req: reqLabel, avail: availLabel, target: targetLabel });
	}
	return t("rowHintCritical", { req: reqLabel, avail: availLabel, target: targetLabel });
}
