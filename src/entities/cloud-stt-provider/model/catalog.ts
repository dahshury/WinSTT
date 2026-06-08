import type { CloudSttProvider } from "@/shared/api/models";
import { GENERATED_CLOUD_MODEL_IDS } from "./cloud-models.generated";

/**
 * Cloud STT model. The renderer-side picker persists the prefixed
 * `<provider>:<id>` into `settings.model.model` so the Python server's
 * `build_transcriber` routes accordingly. Keep `id` stable — it is appended to
 * the provider prefix verbatim and sent in the WS `model_id` envelope.
 */
export interface CloudModel {
	description?: string;
	displayName: string;
	id: string;
	isDefault?: boolean;
}

/**
 * Hand-written metadata (nice names, one-liners, the default flag) for the
 * well-known model ids. This is ONLY metadata — the authoritative *list* of
 * which models exist comes from the AI SDK's own internal unions (see
 * `cloud-models.generated.ts`, produced by
 * `examples/winstt-electron/frontend/scripts/generate-cloud-models.ts`).
 * An id present in the generated list but absent here gets a prettified label;
 * a curated id the SDK has dropped is still shown (union, never drops).
 */
const CURATED_CLOUD_MODELS: Record<CloudSttProvider, readonly CloudModel[]> = {
	// OpenRouter transcription models are fetched live (filtered by
	// output_modalities=transcription) by `useOpenRouterSttCatalogStore`, so there
	// is no curated/generated static list — the picker reads its rows from the scan
	// store, not `CLOUD_CATALOG.openrouter`.
	// OpenAI was removed as a direct cloud STT provider — its models (whisper-1 /
	// gpt-4o-transcribe) are served via `openrouter:openai/*`.
	openrouter: [],
	elevenlabs: [
		{
			id: "scribe_v1",
			displayName: "Scribe v1",
			description: "ElevenLabs transcription, multilingual.",
			isDefault: true,
		},
		{
			id: "scribe_v1_experimental",
			displayName: "Scribe v1 (experimental)",
			description: "Latest experimental Scribe build.",
		},
	],
};

/**
 * The picker's cloud catalog: curated metadata fused with the AI SDK's
 * generated id list, computed once at module load. Curated entries lead (so
 * the default sits first), then any SDK ids without curated metadata follow
 * with a prettified label. Bumping the `@ai-sdk` packages + `bun generate`
 * refreshes the list with no edits here.
 */
export const CLOUD_CATALOG: Record<CloudSttProvider, readonly CloudModel[]> = {
	elevenlabs: mergeCloudModels(
		CURATED_CLOUD_MODELS.elevenlabs,
		GENERATED_CLOUD_MODEL_IDS.elevenlabs.map((id) => ({ id })),
	),
	// Dynamic: populated at runtime from the OpenRouter STT scan store.
	openrouter: [],
};

export const CLOUD_PROVIDERS: readonly CloudSttProvider[] = [
	"elevenlabs",
	"openrouter",
];

export function providerOf(modelId: string): CloudSttProvider | null {
	if (modelId.startsWith("elevenlabs:")) {
		return "elevenlabs";
	}
	if (modelId.startsWith("openrouter:")) {
		return "openrouter";
	}
	// Note: a legacy `openai:` id is intentionally NOT a provider anymore — the
	// settings migration rewrites it to `openrouter:openai/*`; any that slip
	// through resolve to null (treated as a stale/local id → fallback).
	return null;
}

/**
 * Resolve the chosen default model in a provider's catalog: the entry flagged
 * `isDefault`, or the first entry as a fallback. Returns `null` when the
 * catalog is empty — `defaultCloudModelId` turns that into a thrown error.
 */
export function pickDefaultCloudModel(
	catalog: readonly CloudModel[],
): CloudModel | null {
	const explicit = catalog.find((m) => m.isDefault);
	if (explicit !== undefined) {
		return explicit;
	}
	return catalog[0] ?? null;
}

export function defaultCloudModelId(provider: CloudSttProvider): string {
	// OpenRouter has no static catalog — return the bare provider prefix so the
	// picker recognises the provider and self-heals to the first live-scanned
	// transcription model once `useOpenRouterSttCatalogStore` resolves.
	if (provider === "openrouter") {
		return "openrouter:";
	}
	const def = pickDefaultCloudModel(CLOUD_CATALOG[provider]);
	if (def === null) {
		throw new Error(`No models defined for cloud provider ${provider}`);
	}
	return `${provider}:${def.id}`;
}

export function getApiKeyUrl(provider: CloudSttProvider): string {
	switch (provider) {
		case "elevenlabs":
			return "https://elevenlabs.io/app/settings/api-keys";
		case "openrouter":
			return "https://openrouter.ai/keys";
	}
}

export function providerDisplayName(provider: CloudSttProvider): string {
	switch (provider) {
		case "elevenlabs":
			return "ElevenLabs";
		case "openrouter":
			return "OpenRouter";
	}
}

/**
 * Best-effort human label for a model id the curated table doesn't describe
 * (e.g. a dated `gpt-4o-mini-transcribe-2025-…` snapshot the AI SDK ships).
 * Normalizes separators and uppercases the `gpt` token so it reads close to
 * the curated names without per-model curation.
 */
export function prettifyModelId(id: string): string {
	return id
		.replace(/[_-]+/g, " ")
		.replace(/\bgpt\b/gi, "GPT")
		.replace(/\b\w/g, (c) => c.toUpperCase())
		.trim();
}

/**
 * Fuse curated metadata with a list of model ids (from the AI SDK's generated
 * unions). Curated entries come first and keep their hand-written metadata
 * (displayName / description / isDefault); ids without curated metadata are
 * appended in source order with a prettified label. Dedupe is by `id`, so the
 * merge is idempotent, and curated entries the source omits are retained
 * (union) — a stale curated id never disappears.
 */
export function mergeCloudModels(
	curated: readonly CloudModel[],
	dynamic: readonly { id: string; displayName?: string }[],
): CloudModel[] {
	const seen = new Set(curated.map((m) => m.id));
	const merged: CloudModel[] = [...curated];
	for (const entry of dynamic) {
		if (seen.has(entry.id)) {
			continue;
		}
		seen.add(entry.id);
		merged.push({
			id: entry.id,
			displayName: entry.displayName ?? prettifyModelId(entry.id),
		});
	}
	return merged;
}
