import type {
	LlmWarmupModelStatus,
	LlmWarmupStatus,
} from "@/shared/api/ipc-client";

function modelMatcher(target: string) {
	return (entry: LlmWarmupModelStatus) => entry.model === target;
}

function searchStatus(
	status: LlmWarmupStatus,
	model: string,
): LlmWarmupModelStatus | null {
	return status.models.find(modelMatcher(model)) ?? null;
}

function isUsableInput(
	status: LlmWarmupStatus | null,
	model: string,
): status is LlmWarmupStatus {
	return status !== null && model.length > 0;
}

export function findModelStatus(
	status: LlmWarmupStatus | null,
	model: string,
): LlmWarmupModelStatus | null {
	if (!isUsableInput(status, model)) {
		return null;
	}
	return searchStatus(status, model);
}

/** One enabled, locally-running consumer, as banner ownership sees it. */
export interface WarmupBannerRow {
	feature: string;
	model: string;
}

/**
 * Does `row` own the warm-up banner?
 *
 * A warm-up broadcast is machine-wide: it describes the DAEMON or a MODEL,
 * never one consumer. Rendering the banner under every enabled local row
 * produced byte-identical copies — with the shared-local-model rule on (the
 * default) all three consumers resolve to the same model, so "Ollama is not
 * responding" appeared once per enabled row, each with its own Retry.
 *
 * Daemon-level failures belong to the FIRST enabled local row; model-level ones
 * to the first row running that model (with the rule off, two rows on different
 * models are genuinely two different failures and both banners are wanted).
 */
export function ownsWarmupBanner(
	rows: readonly WarmupBannerRow[],
	row: WarmupBannerRow,
	daemonUnreachable: boolean,
): boolean {
	if (daemonUnreachable) {
		return rows[0]?.feature === row.feature;
	}
	return (
		rows.find((candidate) => candidate.model === row.model)?.feature ===
		row.feature
	);
}
