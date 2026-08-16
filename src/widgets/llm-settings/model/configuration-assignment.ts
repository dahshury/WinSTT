import type { AppSettingsOutput } from "@/shared/config/settings-schema";
import type { LlmConfiguration } from "./configuration-types";
import {
	cloneLlmConfiguration,
	withAvailableLlmProvider,
} from "./configurations";

/**
 * Resolving an ASSIGNMENT into the settings the backend actually reads.
 *
 * A configuration says what should happen to the text and who should do it; a
 * feature (dictation / transformations / read aloud) points at one. The backend
 * knows nothing about configurations — it reads each feature's own
 * provider/model/presets/customModifiers — so assignment is resolved HERE and
 * written down denormalized, exactly like `llm.appProfiles.rules[].config`
 * already does.
 *
 * The one value a configuration cannot dictate is the LOCAL model; see
 * {@link resolveLocalModel}.
 */

type LlmSettings = AppSettingsOutput["llm"];

/** The three features a configuration can be assigned to. */
export type AssignableFeature = "dictation" | "readAloud" | "transforms";

/** The fields assignment writes onto a feature. Deliberately excludes `enabled`
 *  (the visible toggle owns on/off — swapping configurations must never silently
 *  start or stop a feature) and every feature-specific field (hotkey,
 *  dictionaryAutoAddEnabled), which assignment has no business touching. */
export interface FeatureAssignmentPatch {
	configurationId: string;
	customModifiers: LlmConfiguration["customModifiers"];
	maxOutputTokens: number | null;
	model: string;
	openrouterFallbackModel: string;
	openrouterModel: string;
	presets: LlmConfiguration["presets"];
	provider: LlmConfiguration["provider"];
	reasoningEffort: LlmConfiguration["reasoningEffort"];
	thinkingEffort: LlmConfiguration["thinkingEffort"];
	verbosity: LlmConfiguration["verbosity"];
}

/** What the resolver needs from settings, so it stays callable from a test
 *  without building a whole settings tree. */
export interface AssignmentContext {
	allowMultipleLocalModels: boolean;
	localModel: string;
	openrouterApiKey: string;
}

/**
 * THE shared local model, healed.
 *
 * `llm.localModel` is a newer field than the per-feature ones, so an install
 * that predates it has it blank while `llm.dictation.model` (or another
 * consumer's) still names the model the user has been running all along. Adopt
 * that rather than presenting an empty picker and asking them to choose a model
 * they already chose.
 *
 * Dictation first: it is the primary consumer and the one whose model an older
 * settings file is most likely to carry.
 */
export function effectiveLocalModel(llm: LlmSettings): string {
	if (llm.localModel.trim() !== "") {
		return llm.localModel;
	}
	for (const feature of [llm.dictation, llm.transforms, llm.readAloud]) {
		if (feature.provider === "ollama" && feature.model.trim() !== "") {
			return feature.model;
		}
	}
	return "";
}

export function assignmentContext(llm: LlmSettings): AssignmentContext {
	return {
		allowMultipleLocalModels: llm.allowMultipleLocalModels,
		localModel: effectiveLocalModel(llm),
		openrouterApiKey: llm.openrouterApiKey,
	};
}

/**
 * Which local model a configuration actually runs on.
 *
 * Local models are VRAM-resident and Ollama does NOT refuse to overcommit — it
 * queues the request and evicts an idle model to make room, so letting every
 * configuration name its own local model turns each switch between features
 * into a silent multi-second reload. So by default every locally-running
 * configuration resolves onto THE shared local model, and only the power-user
 * toggle lets a configuration keep its own.
 *
 * Cloud configurations never reach this: their model lives in
 * `openrouterModel` and costs no memory, so they are unconstrained.
 */
export function resolveLocalModel(
	config: Pick<LlmConfiguration, "model" | "provider">,
	context: AssignmentContext,
): string {
	if (config.provider !== "ollama" || context.allowMultipleLocalModels) {
		return config.model;
	}
	// An EMPTY shared model never wins. `llm.localModel` is a newer field, so it
	// is blank on every install that predates it while the feature's own `model`
	// still names a real, working model — resolving to "" there would wipe a
	// configured model and leave the picker showing "Select a model" for a setup
	// that was fine. Blank means "not decided yet", not "no model".
	return context.localModel.trim() === "" ? config.model : context.localModel;
}

/**
 * The patch that assigning `config` (saved under `configurationId`) to a feature
 * produces.
 *
 * `withAvailableLlmProvider` runs first for the same reason it does everywhere
 * else: a configuration saved while an OpenRouter key was installed must not
 * strand a feature on a keyless cloud provider — it degrades to local instead,
 * and then picks up the shared local model like any other local assignment.
 */
export function featurePatchFromConfiguration(
	config: LlmConfiguration,
	configurationId: string,
	context: AssignmentContext,
): FeatureAssignmentPatch {
	const gated = withAvailableLlmProvider(
		cloneLlmConfiguration(config),
		context.openrouterApiKey,
	);
	return {
		configurationId,
		customModifiers: gated.customModifiers,
		maxOutputTokens: gated.maxOutputTokens,
		model: resolveLocalModel(gated, context),
		openrouterFallbackModel: gated.openrouterFallbackModel,
		openrouterModel: gated.openrouterModel,
		presets: gated.presets,
		provider: gated.provider,
		reasoningEffort: gated.reasoningEffort,
		thinkingEffort: gated.thinkingEffort,
		verbosity: gated.verbosity,
	};
}

/**
 * The patch that changing the SHARED local model produces for one feature.
 *
 * Returns `null` when the feature is unaffected — it runs on a cloud provider,
 * or the power toggle has freed it to keep its own local model — so the caller
 * can skip writing (and skip the settings round-trip) instead of rewriting an
 * identical value.
 */
export function sharedLocalModelPatch(
	feature: Pick<LlmConfiguration, "model" | "provider">,
	localModel: string,
	context: Pick<AssignmentContext, "allowMultipleLocalModels">,
): { model: string } | null {
	if (feature.provider !== "ollama" || context.allowMultipleLocalModels) {
		return null;
	}
	return feature.model === localModel ? null : { model: localModel };
}

/**
 * The shared local model to adopt when the power toggle is turned back OFF and
 * features have drifted onto different local models.
 *
 * Picks the model the currently-ENABLED local features already agree on, else
 * the first enabled local feature's, else the existing shared value. Collapsing
 * onto something already in VRAM avoids a gratuitous load the moment the user
 * asks for fewer models, which is the opposite of what they asked for.
 */
export function collapseToSharedLocalModel(
	features: ReadonlyArray<{
		enabled: boolean;
		model: string;
		provider: string;
	}>,
	current: string,
): string {
	const candidates = features
		.filter(
			(f) => f.enabled && f.provider === "ollama" && f.model.trim() !== "",
		)
		.map((f) => f.model);
	if (candidates.length === 0) {
		return current;
	}
	return candidates.includes(current) ? current : (candidates[0] ?? current);
}
