import type { LlmWarmupModelStatus, LlmWarmupStatus } from "@/shared/api/ipc-client";

export function findModelStatus(
	status: LlmWarmupStatus | null,
	model: string
): LlmWarmupModelStatus | null {
	if (!(status && model)) {
		return null;
	}
	return status.models.find((m) => m.model === model) ?? null;
}

// Test-only exports
export const __warmup_banner_test_helpers__ = {
	findModelStatus,
};
