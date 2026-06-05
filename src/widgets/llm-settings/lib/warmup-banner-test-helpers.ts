import type { LlmWarmupModelStatus, LlmWarmupStatus } from "@/shared/api/ipc-client";

function modelMatcher(target: string) {
	return (entry: LlmWarmupModelStatus) => entry.model === target;
}

function searchStatus(status: LlmWarmupStatus, model: string): LlmWarmupModelStatus | null {
	return status.models.find(modelMatcher(model)) ?? null;
}

function isUsableInput(status: LlmWarmupStatus | null, model: string): status is LlmWarmupStatus {
	return status !== null && model.length > 0;
}

export function findModelStatus(
	status: LlmWarmupStatus | null,
	model: string
): LlmWarmupModelStatus | null {
	if (!isUsableInput(status, model)) {
		return null;
	}
	return searchStatus(status, model);
}
