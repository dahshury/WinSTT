import { providerOf } from "@/entities/cloud-stt-provider";
import {
	type CatalogModels,
	type ModelInfo,
	type ModelStatesById as StatesById,
	pickDefaultSttModel,
} from "@/entities/model-catalog";
import { DEFAULT_SETTINGS } from "@/entities/setting";
import type { CloudSttProvider } from "@/shared/api/models";
import type { TranscriberBackend } from "@/shared/api/schema.zod";

/**
 * Every cloud integration whose API key, once removed, must revert the
 * surfaces it backs to a local engine. `elevenlabs` gates the cloud STT model
 * AND cloud TTS; `openrouter` gates the LLM dictation / transforms providers AND
 * an active `openrouter:*` STT selection. `openrouter` is part of
 * `CloudSttProvider`, so this union is `CloudSttProvider` (the explicit
 * `| "openrouter"` is kept for readability). (OpenAI was removed.)
 */
export type ClearableProvider = CloudSttProvider | "openrouter";

/** The API keys we watch, flattened from settings. */
export interface KeySnapshot {
	elevenlabs: string;
	openrouter: string;
}

/** The surface-selection fields that decide whether a cleared key is "active". */
export interface SurfaceSnapshot {
	dictationProvider: string;
	model: string;
	transformsProvider: string;
	ttsSource: string;
}

/** Which surfaces a key-removal must revert to local. */
export interface RevertPlan {
	llmDictation: boolean;
	llmTransforms: boolean;
	stt: boolean;
	ttsCloud: boolean;
}

/** Local STT target (`{ model, backend }`) the main slot reverts to. */
export interface SttTarget {
	backend: TranscriberBackend;
	model: string;
}

/**
 * A key counts as "cleared" only on a non-whitespace → empty transition.
 * Mirrors the whitespace rule the legacy removal guard used so a key of
 * `"   "` going to `""` is not treated as a real removal.
 */
function wasCleared(prev: string, next: string): boolean {
	return prev.trim() !== "" && next.trim() === "";
}

/** Which providers' keys went non-empty → empty between two snapshots. */
export function detectClearedKeys(
	prev: KeySnapshot,
	next: KeySnapshot,
): ReadonlySet<ClearableProvider> {
	const cleared = new Set<ClearableProvider>();
	if (wasCleared(prev.elevenlabs, next.elevenlabs)) {
		cleared.add("elevenlabs");
	}
	if (wasCleared(prev.openrouter, next.openrouter)) {
		cleared.add("openrouter");
	}
	return cleared;
}

/**
 * Given the set of just-cleared providers and the current surface selections,
 * decide which surfaces must revert. A surface only reverts when it is
 * actively using a cleared provider — a cleared key for a provider nothing
 * is using is a no-op.
 */
export function planReverts(
	cleared: ReadonlySet<ClearableProvider>,
	surfaces: SurfaceSnapshot,
): RevertPlan {
	const activeSttProvider = providerOf(surfaces.model);
	const orCleared = cleared.has("openrouter");
	return {
		stt: activeSttProvider !== null && cleared.has(activeSttProvider),
		llmDictation: orCleared && surfaces.dictationProvider === "openrouter",
		llmTransforms: orCleared && surfaces.transformsProvider === "openrouter",
		ttsCloud: cleared.has("elevenlabs") && surfaces.ttsSource === "cloud",
	};
}

/** True when the plan reverts at least one surface. */
export function planHasWork(plan: RevertPlan): boolean {
	return plan.stt || plan.llmDictation || plan.llmTransforms || plan.ttsCloud;
}

/**
 * The providers a plan actually reverted a surface for — used to drive the
 * confirmation toast. Deduped, so an elevenlabs key that backed both STT and
 * cloud TTS yields a single notice.
 */
export function affectedProviders(
	plan: RevertPlan,
	model: string,
): ReadonlySet<ClearableProvider> {
	const providers = new Set<ClearableProvider>();
	if (plan.stt) {
		const sttProvider = providerOf(model);
		if (sttProvider) {
			providers.add(sttProvider);
		}
	}
	if (plan.ttsCloud) {
		providers.add("elevenlabs");
	}
	if (plan.llmDictation || plan.llmTransforms) {
		providers.add("openrouter");
	}
	return providers;
}

/**
 * Resolve the `{ model, backend }` to swap the main STT slot to. Prefers the
 * smallest *cached* local model (so the revert never triggers a download),
 * falling back to the schema default (`tiny` / `faster_whisper`, the vendored
 * offline base) when the catalog is empty or lacks a backend.
 */
export function resolveLocalSttTarget(
	models: CatalogModels,
	statesById: StatesById,
): SttTarget {
	const fallback: SttTarget = {
		model: DEFAULT_SETTINGS.model.model,
		backend: DEFAULT_SETTINGS.model.backend,
	};
	const pick = pickDefaultSttModel(models, statesById);
	if (!pick) {
		return fallback;
	}
	const entry = models.find((m: ModelInfo) => m.id === pick);
	if (!entry?.backend) {
		return fallback;
	}
	return { model: pick, backend: entry.backend };
}

/** Human-readable label for a cleared provider (used in the revert toast). */
export function clearableProviderLabel(provider: ClearableProvider): string {
	if (provider === "elevenlabs") {
		return "ElevenLabs";
	}
	return "OpenRouter";
}
