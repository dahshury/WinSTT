import type { OllamaPullProgress } from "@/shared/api/models";
import type { TriggerPullSummary } from "./ollama-selector-types";

export function pickPrimaryPull(
	pulls: Readonly<Record<string, OllamaPullProgress>>,
): TriggerPullSummary | null {
	let best: TriggerPullSummary | null = null;
	for (const [name, progress] of Object.entries(pulls)) {
		const percent = Math.round(progress.percent ?? 0);
		if (!best || percent > best.percent) {
			best = { model: name, percent, status: progress.status };
		}
	}
	return best;
}
