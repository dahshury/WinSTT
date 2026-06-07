/**
 * Render-side helpers for turning a ``FitAssessmentEntry`` into something
 * a model-picker row can show. The badge text is intentionally compact
 * (single token) so it fits inline with the model name and size label;
 * fuller details live in the warning modal.
 */

import type {
	FitAssessmentEntry,
	FitSeverity,
	FitTarget,
} from "@/shared/api/ipc-client";
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

export function badgeFor(
	assessment: FitAssessmentEntry | null,
): FitBadge | null {
	return assessment ? SEVERITY_TO_BADGE[assessment.severity] : null;
}

const TARGET_LABEL_KEY: Record<FitTarget, string> = {
	gpu: "targetGpu",
	cpu: "targetCpu",
	neither: "targetNeither",
};

const HINT_KEY_BY_SEVERITY: Record<FitSeverity, string> = {
	ok: "rowHintOk",
	warning: "rowHintWarning",
	critical: "rowHintCritical",
};

type Translator = (
	key: string,
	vars?: Record<string, string | number>,
) => string;

export function hasUsableFootprint(
	assessment: FitAssessmentEntry | null,
): assessment is FitAssessmentEntry {
	return assessment !== null && assessment.required_bytes > 0;
}

export function labelBytes(bytes: number): string {
	return formatBytes(bytes, { minUnit: "MB" }) ?? "?";
}

export function targetLabel(target: FitTarget, t: Translator): string {
	return t(TARGET_LABEL_KEY[target]);
}

/** Compact per-row hint: "~600 MB · fits on GPU", "~12 GB · ⚠ tight on CPU",
 * "~30 GB · ⛔ exceeds VRAM (24 GB free)". Empty string when there's no
 * useful info (unknown footprint with no resource probe). */
export function rowHint(
	assessment: FitAssessmentEntry | null,
	t: Translator,
): string {
	if (!hasUsableFootprint(assessment)) {
		return "";
	}
	return t(HINT_KEY_BY_SEVERITY[assessment.severity], {
		req: labelBytes(assessment.required_bytes),
		avail: labelBytes(assessment.available_bytes),
		target: targetLabel(assessment.target, t),
	});
}
