import { useEffect, useState } from "react";
import {
	onLlmUnloadStatus,
	type LlmWarmupStatus,
} from "@/shared/api/ipc-client";
import { resolveUnloadPending } from "./feature-block-helpers";
import type { LlmProvider } from "./types";

function resolveWarmPending(
	armedAtTimestamp: number | null,
	model: string,
	provider: LlmProvider,
	enabled: boolean,
	warmupStatus: LlmWarmupStatus | null,
): boolean {
	if (armedAtTimestamp === null) {
		return false;
	}
	if (provider !== "ollama" || !enabled || model.trim().length === 0) {
		return false;
	}
	if (warmupStatus && warmupStatus.timestamp > armedAtTimestamp) {
		const entry = warmupStatus.models.find(
			(candidate) => candidate.model === model,
		);
		if (entry && entry.outcome !== "loading") {
			return false;
		}
	}
	return true;
}

export function useOllamaWarmTracker(opts: {
	enabled: boolean;
	model: string;
	provider: LlmProvider;
	warmupStatus: LlmWarmupStatus | null;
}): { beginWarm: (model: string) => void; isWarming: boolean } {
	const { enabled, model, provider, warmupStatus } = opts;
	const [armedAt, setArmedAt] = useState<number | null>(null);

	const beginWarm = (target: string) => {
		if (provider !== "ollama" || target.trim().length === 0) {
			return;
		}
		setArmedAt(warmupStatus?.timestamp ?? 0);
	};

	useEffect(() => {
		if (armedAt === null) {
			return;
		}
		const id = window.setTimeout(() => setArmedAt(null), 180_000);
		return () => window.clearTimeout(id);
	}, [armedAt]);

	return {
		beginWarm,
		isWarming: resolveWarmPending(
			armedAt,
			model,
			provider,
			enabled,
			warmupStatus,
		),
	};
}

export function useOllamaUnloadTracker(opts: {
	enabled: boolean;
	provider: LlmProvider;
}): { beginUnload: (model: string) => void; isUnloading: boolean } {
	const { enabled, provider } = opts;
	const [pendingModel, setPendingModel] = useState<string | null>(null);

	const beginUnload = (model: string) => {
		if (provider !== "ollama" || model.trim().length === 0) {
			return;
		}
		setPendingModel(model);
	};

	useEffect(
		() =>
			onLlmUnloadStatus((status) => {
				setPendingModel((pending) =>
					pending !== null &&
					!status.inProgress &&
					status.models.includes(pending)
						? null
						: pending,
				);
			}),
		[],
	);

	useEffect(() => {
		if (pendingModel === null) {
			return;
		}
		const id = window.setTimeout(() => setPendingModel(null), 30_000);
		return () => window.clearTimeout(id);
	}, [pendingModel]);

	return {
		beginUnload,
		isUnloading: resolveUnloadPending(pendingModel, provider, enabled),
	};
}
