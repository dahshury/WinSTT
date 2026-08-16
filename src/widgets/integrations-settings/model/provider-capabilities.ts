import {
	type ClearableProvider,
	planReverts,
	type SurfaceSnapshot,
} from "@/features/revert-cloud-on-key-removal";

/**
 * Stable capability ids rendered as chips on a provider card. Ids only — the
 * i18n label for each one is owned by the UI, which maps id → message key.
 * Never put user-facing text in this module.
 */
export type CapabilityId =
	| "cloudStt"
	| "cloudTts"
	| "dictation"
	| "readAloud"
	| "transforms";

/**
 * Every provider the Integrations tab renders a card for. `ClearableProvider`
 * (`elevenlabs | openrouter`) is exactly the key-backed set; Ollama is the
 * local, keyless one — it gates the same LLM surfaces without a credential.
 */
export type IntegrationProvider = "ollama" | ClearableProvider;

/** One chip: what the provider gates, and whether something points at it now. */
export interface ProviderCapability {
	active: boolean;
	id: CapabilityId;
}

/**
 * The structural slice of settings the capability model reads. Declared as the
 * minimum shape (not `AppSettingsOutput`) so the pure function stays trivially
 * constructible in tests; the real settings object is assignable to it.
 */
export interface CapabilitySurfaceSettings {
	llm: {
		dictation: { enabled: boolean; provider: string };
		readAloud: { enabled: boolean; provider: string };
		transforms: { enabled: boolean; provider: string };
	};
	tts: {
		cloud: { provider: string };
		source: string;
	};
}

/**
 * What each provider gates, in chip render order. Cloud capabilities are absent
 * from Ollama by construction — it is a local runtime with no cloud surface at
 * all, so the card can never claim one.
 */
export const PROVIDER_CAPABILITY_IDS: Record<
	IntegrationProvider,
	readonly CapabilityId[]
> = {
	elevenlabs: ["cloudStt", "cloudTts"],
	ollama: ["dictation", "transforms", "readAloud"],
	openrouter: ["dictation", "transforms", "readAloud", "cloudStt", "cloudTts"],
};

/** Providers whose capabilities are gated by an API key. */
export function isKeyedProvider(
	provider: IntegrationProvider,
): provider is ClearableProvider {
	return provider !== "ollama";
}

/** Field mapping only — mirrors `currentSurfaces()` in the revert feature. */
function toSurfaceSnapshot(
	settings: CapabilitySurfaceSettings,
	activeModelId: string,
): SurfaceSnapshot {
	return {
		dictationProvider: settings.llm.dictation.provider,
		model: activeModelId,
		transformsProvider: settings.llm.transforms.provider,
		ttsProvider: settings.tts.cloud.provider,
		ttsSource: settings.tts.source,
	};
}

/**
 * Whether an LLM feature's own provider selection points at `provider`.
 *
 * Provider-match ONLY, ignoring the feature's `enabled` flag, because for a
 * KEYED provider the chip answers "what does removing this key rewrite" — and
 * `planReverts` rewrites a disabled feature too. A chip that went inactive on
 * `enabled: false` would call the removal harmless while the planner still
 * changes the setting.
 *
 * That framing does not survive the trip to Ollama, which has no key and no
 * Remove action — see {@link llmSurfaceRunsOn}.
 */
function llmSurfaceUsesProvider(
	surfaceProvider: string,
	provider: IntegrationProvider,
): boolean {
	return surfaceProvider === provider;
}

/**
 * Whether an LLM feature is actually RUNNING on `provider` right now.
 *
 * The keyless-provider counterpart to {@link llmSurfaceUsesProvider}. Ollama
 * has no key to remove, so "what breaks on removal" is not a question its card
 * can ask; its chips can only mean "is this running here". Provider-match alone
 * would mark all three chips Active on a fresh install — every LLM feature
 * defaults to `provider: "ollama"` while `enabled` defaults to false — telling
 * the user three features are live when none of them are.
 */
function llmSurfaceRunsOn(
	surface: { enabled: boolean; provider: string },
	provider: IntegrationProvider,
): boolean {
	return surface.enabled && surface.provider === provider;
}

/**
 * "Currently in use" is exactly "what breaks if this key is removed", so for
 * the keyed providers we ask the revert planner itself rather than restating
 * its rules: `planReverts` with a single-provider cleared set returns precisely
 * the surfaces that removal would rewrite. The two therefore cannot disagree.
 *
 * Two surfaces are outside that delegation:
 *   - Ollama has no key, so `ClearableProvider` (and the planner) cannot speak
 *     for it; its LLM surfaces use the same provider-match predicate.
 *   - `llm.readAloud` is a surface `planReverts` does not model at all (a real
 *     gap in the planner — removing an OpenRouter key leaves read-aloud cleanup
 *     pointed at a dead provider). Until the planner grows an `llmReadAloud`
 *     field, the chip reports the honest answer via the shared predicate.
 */
function capabilityActivity(
	provider: IntegrationProvider,
	settings: CapabilitySurfaceSettings,
	activeModelId: string,
): Record<CapabilityId, boolean> {
	const readAloud = llmSurfaceUsesProvider(
		settings.llm.readAloud.provider,
		provider,
	);
	if (!isKeyedProvider(provider)) {
		// Keyless: the chips mean "running here now", not "breaks on removal".
		return {
			cloudStt: false,
			cloudTts: false,
			dictation: llmSurfaceRunsOn(settings.llm.dictation, provider),
			readAloud: llmSurfaceRunsOn(settings.llm.readAloud, provider),
			transforms: llmSurfaceRunsOn(settings.llm.transforms, provider),
		};
	}
	const plan = planReverts(
		new Set([provider]),
		toSurfaceSnapshot(settings, activeModelId),
	);
	return {
		cloudStt: plan.stt,
		cloudTts: plan.ttsCloud,
		dictation: plan.llmDictation,
		readAloud,
		transforms: plan.llmTransforms,
	};
}

/**
 * The chips for one provider card: what it gates, and which of those a surface
 * is pointing at right now. Pure — no store, no React — so the Integrations tab
 * and the unit tests see the same answer.
 */
export function providerCapabilities(
	provider: IntegrationProvider,
	settings: CapabilitySurfaceSettings,
	activeModelId: string,
): ProviderCapability[] {
	const activity = capabilityActivity(provider, settings, activeModelId);
	return PROVIDER_CAPABILITY_IDS[provider].map((id) => ({
		active: activity[id],
		id,
	}));
}

/** True when at least one of the provider's capabilities is in use. */
export function hasActiveCapability(
	capabilities: readonly ProviderCapability[],
): boolean {
	return capabilities.some((capability) => capability.active);
}
