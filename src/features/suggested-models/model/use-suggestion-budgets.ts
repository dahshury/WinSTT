import { useModelStateStore } from "@/entities/model-catalog";
import {
	computeBudgets,
	largestGpuVram,
	type MemoryBudgets,
	type SuggestionModality,
} from "@/entities/model-suggestion";
import { useCommittedModels } from "./use-committed-models";

/**
 * The RAM/VRAM budgets left for the modality being picked: total-memory pools
 * minus every OTHER enabled modality's committed footprint (`excludeModality`
 * is skipped so swapping REPLACES its footprint rather than stacking).
 *
 * Returns `null` until the server's system info has arrived — hosts should
 * treat that as "no verdict" (don't hide anything), not as a zero budget.
 */
export function useSuggestionBudgets(
	excludeModality: SuggestionModality,
): MemoryBudgets | null {
	const systemInfo = useModelStateStore((s) => s.systemInfo);
	const committed = useCommittedModels();
	if (!systemInfo || systemInfo.total_ram_bytes <= 0) {
		return null;
	}
	return computeBudgets(
		{
			totalRamBytes: systemInfo.total_ram_bytes,
			largestGpuVramBytes: largestGpuVram(systemInfo.gpus),
		},
		committed,
		excludeModality,
	);
}
