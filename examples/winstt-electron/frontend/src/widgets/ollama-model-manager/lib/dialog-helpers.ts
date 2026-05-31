import type { OllamaPullProgress, OllamaPullProgressStatus } from "@/shared/api/models";

const PULL_STATUS_I18N_MAP: Partial<Record<OllamaPullProgressStatus, string>> = {
	downloading: "pullStatusDownloading",
	verifying: "pullStatusVerifying",
	writing: "pullStatusWriting",
	success: "pullStatusSuccess",
};

/**
 * Maps a pull status value to its i18n key so callers can translate it.
 * Kept pure (no i18n dependency) so it is testable without mocking hooks.
 */
export function pullStatusToI18nKey(status: OllamaPullProgressStatus | undefined): string {
	// Stryker disable next-line ConditionalExpression: equivalent mutant — when forced true, PULL_STATUS_I18N_MAP[undefined] is undefined → falls through to the same "pullStatusPulling" default.
	return (status !== undefined && PULL_STATUS_I18N_MAP[status]) || "pullStatusPulling";
}

/**
 * Clamps and rounds the percent field from a pull-progress event to an integer
 * in [0, 100].
 */
export function computePullPercent(progress: OllamaPullProgress): number {
	return Math.round(progress.percent ?? 0);
}

/**
 * Flattens the pulls map stored in the Zustand LLM-catalog store
 * (which carries extra metadata alongside the progress object) into the
 * simpler shape consumed by the UI: `{ [modelName]: OllamaPullProgress }`.
 */
export function buildPullsMap(
	pulls: Record<string, { progress: OllamaPullProgress; startedAt: number }>
): Record<string, OllamaPullProgress> {
	const out: Record<string, OllamaPullProgress> = {};
	for (const [k, v] of Object.entries(pulls)) {
		out[k] = v.progress;
	}
	return out;
}
