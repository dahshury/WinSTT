import { useSettingsStore } from "@/entities/setting";
import type { AppSettingsOutput } from "@/shared/config/settings-schema";
import {
	type AssignableFeature,
	assignmentContext,
	collapseToSharedLocalModel,
	featurePatchFromConfiguration,
	resolveLocalModel,
	sharedLocalModelPatch,
} from "./configuration-assignment";
import type { LlmConfiguration } from "./configuration-types";
import { ASSIGNABLE_FEATURES } from "./feature-meta";
import {
	cloneLlmConfiguration,
	DEFAULT_CONFIGURATION_ID,
	useLlmConfigurationsStore,
} from "./configurations";

/**
 * The Processing tab's editing model.
 *
 * A CONFIGURATION is authored once (provider, model, tone, modifiers, tuning)
 * and ASSIGNED to features. Nothing here edits a feature's stack directly — the
 * feature's fields are a resolved, denormalized copy of whatever configuration
 * it points at, so every write goes:
 *
 *     edit / assign  →  resolve (configuration-assignment.ts)  →  feature fields
 *
 * which is what keeps the backend able to read the same per-feature fields it
 * always has, knowing nothing about configurations.
 */

type LlmSettings = AppSettingsOutput["llm"];

/** One consumer's live state, as the assignment list renders it. */
export interface FeatureAssignment {
	/**
	 * False only when NO configuration is resolvable at all (the user deleted
	 * every one, the shipped Default included). Enabling then would arm a feature
	 * with no prompt to run, so the row's toggle is blocked and says why.
	 */
	canEnable: boolean;
	/** What the row's picker shows: the stored assignment, or the shipped Default
	 *  when the stored id no longer resolves. Never blank while any configuration
	 *  exists — a feature always has an answer to "which stack?". */
	configurationId: string;
	enabled: boolean;
	feature: AssignableFeature;
	/** The resolved provider — the row shows whether this one runs local or cloud
	 *  without the user having to open the configuration. */
	provider: LlmConfiguration["provider"];
}

function featureSlice(
	llm: LlmSettings,
	feature: AssignableFeature,
):
	| LlmSettings["dictation"]
	| LlmSettings["transforms"]
	| LlmSettings["readAloud"] {
	if (feature === "dictation") {
		return llm.dictation;
	}
	return feature === "transforms" ? llm.transforms : llm.readAloud;
}

export function useConfigurationWorkbench() {
	const llm = useSettingsStore((s) => s.settings.llm);
	const updateShared = useSettingsStore((s) => s.updateLlmSettings);
	const updateSharedLocalModel = useSettingsStore(
		(s) => s.updateLlmSharedLocalModel,
	);
	const updateDictation = useSettingsStore((s) => s.updateLlmPostProcessing);
	const updateTransforms = useSettingsStore((s) => s.updateLlmTransforms);
	const updateReadAloud = useSettingsStore((s) => s.updateLlmReadAloud);

	const configurations = useLlmConfigurationsStore((s) => s.configurations);
	const activeConfigurationId = useLlmConfigurationsStore(
		(s) => s.activeConfigurationId,
	);
	const setActiveConfiguration = useLlmConfigurationsStore(
		(s) => s.setActiveConfiguration,
	);
	const updateConfiguration = useLlmConfigurationsStore(
		(s) => s.updateConfiguration,
	);

	const context = assignmentContext(llm);

	// The configuration under the editor. Falls back to whatever dictation is
	// assigned (the most-used consumer), then to the first saved one, so the
	// editor is never blank while configurations exist.
	const editingId =
		configurations.find((c) => c.id === activeConfigurationId)?.id ??
		configurations.find((c) => c.id === llm.dictation.configurationId)?.id ??
		configurations[0]?.id ??
		"";
	const editing = configurations.find((c) => c.id === editingId) ?? null;

	// A feature's stored assignment can stop resolving — the configuration was
	// deleted, or the settings file predates assignments. Fall back to the shipped
	// Default so the row still shows a real answer instead of an empty picker; the
	// stored value is only rewritten when the user acts (see `setFeatureEnabled`),
	// never during render.
	const fallbackId =
		configurations.find((c) => c.id === DEFAULT_CONFIGURATION_ID)?.id ??
		configurations[0]?.id ??
		"";
	const effectiveConfigurationId = (feature: AssignableFeature): string => {
		const stored = featureSlice(llm, feature).configurationId;
		return configurations.some((c) => c.id === stored) ? stored : fallbackId;
	};

	const assignments: FeatureAssignment[] = ASSIGNABLE_FEATURES.map(
		(feature) => {
			const slice = featureSlice(llm, feature);
			const configurationId = effectiveConfigurationId(feature);
			return {
				feature,
				enabled: slice.enabled,
				configurationId,
				canEnable: configurationId !== "",
				provider: slice.provider,
			};
		},
	);

	/** True when ANY consumer is on. Drives the section's master toggle and
	 *  whether the tab's content is live: the editor is pointless while nothing
	 *  runs, and the master switch must reflect reality rather than being a
	 *  fourth, independent flag that can disagree with the rows. */
	const anyEnabled = assignments.some((row) => row.enabled);

	/** Write a resolved patch onto one feature. The three per-feature updaters
	 *  take structurally-different partials, so the shared shape is the widest
	 *  they all accept — every caller here builds it from the resolver. */
	const writeFeature = (
		feature: AssignableFeature,
		patch: Partial<LlmSettings["dictation"]>,
	) => {
		if (feature === "dictation") {
			updateDictation(patch);
			return;
		}
		if (feature === "transforms") {
			updateTransforms(patch);
			return;
		}
		updateReadAloud(patch);
	};

	/** Point `feature` at `configurationId` and resolve it into that feature's
	 *  fields. Never touches `enabled` — the row's toggle owns that. */
	const assign = (feature: AssignableFeature, configurationId: string) => {
		const config = configurations.find((c) => c.id === configurationId);
		if (!config) {
			return;
		}
		writeFeature(
			feature,
			featurePatchFromConfiguration(config.config, configurationId, context),
		);
	};

	/**
	 * Commit one step of a feature's enable/disable flow.
	 *
	 * This is what `performFeatureToggle` calls back into, so the patch can carry
	 * a MODEL the preflight resolved (auto-picked smallest installed, or the one
	 * the model picker just downloaded) as well as the `enabled` flag. That model
	 * is redirected to the SHARED local model while the one-model rule is in
	 * force — otherwise enabling each feature in turn would pick independently
	 * and they would drift apart, which is exactly what the rule exists to stop.
	 *
	 * Enabling also HEALS the assignment: if the stored configuration no longer
	 * resolves, the fallback is written down first, so a feature can never end up
	 * enabled while pointing at a configuration that does not exist. The heal runs
	 * BEFORE the model write, because `assign` resolves a model of its own out of
	 * the render-time context — running it afterwards overwrote the model the
	 * preflight had just picked, with the stale shared model or with `""`.
	 *
	 * The patch is the preflight's own shape, not a two-field subset: the cloud
	 * enable path carries `openrouterModel`, and narrowing the parameter silently
	 * dropped it — enabling a cloud feature with no model id to call.
	 */
	const applyFeatureTogglePatch = (
		feature: AssignableFeature,
		patch: Partial<LlmSettings["dictation"]>,
	) => {
		const slice = featureSlice(llm, feature);
		const { enabled, model, ...rest } = patch;
		if (enabled === true) {
			const resolved = effectiveConfigurationId(feature);
			if (resolved === "") {
				return;
			}
			if (slice.configurationId !== resolved) {
				assign(feature, resolved);
			}
		}
		if (Object.keys(rest).length > 0) {
			writeFeature(feature, rest);
		}
		if (model !== undefined) {
			if (slice.provider === "ollama" && !llm.allowMultipleLocalModels) {
				setSharedLocalModel(model);
			} else {
				writeFeature(feature, { model });
			}
		}
		if (enabled !== undefined) {
			writeFeature(feature, { enabled });
		}
	};

	/** Plain flag write, for callers that have already done their own preflight. */
	const setFeatureEnabled = (feature: AssignableFeature, enabled: boolean) => {
		applyFeatureTogglePatch(feature, { enabled });
	};

	/** Re-resolve every feature assigned to `configurationId` — called after the
	 *  configuration itself changes, so an edit propagates to its consumers
	 *  instead of leaving them on a stale copy. */
	const resyncAssigned = (
		configurationId: string,
		config: LlmConfiguration,
	) => {
		for (const feature of ASSIGNABLE_FEATURES) {
			if (featureSlice(llm, feature).configurationId !== configurationId) {
				continue;
			}
			writeFeature(
				feature,
				featurePatchFromConfiguration(config, configurationId, context),
			);
		}
	};

	/** Change THE shared local model and move every locally-running feature onto
	 *  it. Cloud features and — while the power toggle is on — every feature are
	 *  left alone. The settings store owns the propagation so that every surface
	 *  landing a local model (this editor, the model picker) upholds the rule the
	 *  same way, in one write. */
	function setSharedLocalModel(model: string): void {
		updateSharedLocalModel(model);
	}

	/**
	 * Edit the configuration under the editor.
	 *
	 * A `model` write is special: while the shared-local-model rule is in force it
	 * is not a property of THIS configuration at all, it is the one model every
	 * locally-running feature uses — so it is redirected to `llm.localModel` and
	 * pushed to every affected feature. That is why the editor shows a single
	 * model picker whose label says it is shared: the constraint is visible at the
	 * point of editing rather than hidden in a separate section.
	 */
	const editActive = (patch: Partial<LlmConfiguration>) => {
		if (!editing) {
			return;
		}
		const { model, ...rest } = patch;
		const redirectModel =
			model !== undefined &&
			!llm.allowMultipleLocalModels &&
			(rest.provider ?? editing.config.provider) === "ollama";
		if (redirectModel && model !== undefined) {
			setSharedLocalModel(model);
		}
		const next: LlmConfiguration = {
			...cloneLlmConfiguration(editing.config),
			...rest,
			...(model !== undefined && !redirectModel ? { model } : {}),
		};
		updateConfiguration(editing.id, next);
		resyncAssigned(editing.id, next);
	};

	/**
	 * Flip the power toggle.
	 *
	 * Turning it OFF is the interesting direction: features may have drifted onto
	 * different local models, so we collapse them onto one — preferring a model an
	 * enabled feature is already running, because "use fewer models" should not
	 * trigger a fresh download/load.
	 */
	const setAllowMultipleLocalModels = (allow: boolean) => {
		if (allow) {
			updateShared({ allowMultipleLocalModels: true });
			return;
		}
		const collapsed = collapseToSharedLocalModel(
			ASSIGNABLE_FEATURES.map((feature) => featureSlice(llm, feature)),
			context.localModel,
		);
		updateShared({ allowMultipleLocalModels: false, localModel: collapsed });
		for (const feature of ASSIGNABLE_FEATURES) {
			const slice = featureSlice(llm, feature);
			const patch = sharedLocalModelPatch(slice, collapsed, {
				allowMultipleLocalModels: false,
			});
			if (patch) {
				writeFeature(feature, patch);
			}
		}
	};

	// The editor's model picker reads the SHARED model while the rule is in force,
	// so the value on screen is the one that will actually run.
	//
	// `enabled` is NOT the configuration's own flag — a configuration has no
	// meaningful on/off state, and passing its stored `false` through was what
	// left the editor permanently dimmed. It carries "is any consumer running"
	// instead, which is the question the editor's live/inert state should answer.
	const editingSnapshot: LlmConfiguration | null = editing
		? {
				...editing.config,
				enabled: anyEnabled,
				model: resolveLocalModel(
					{
						model: editing.config.model,
						provider: editing.config.provider,
					},
					context,
				),
			}
		: null;

	return {
		allowMultipleLocalModels: llm.allowMultipleLocalModels,
		anyEnabled,
		applyFeatureTogglePatch,
		assign,
		assignments,
		configurations,
		editActive,
		editing,
		editingId,
		editingSnapshot,
		setActiveConfiguration,
		setAllowMultipleLocalModels,
		setFeatureEnabled,
		setSharedLocalModel,
	};
}

export type ConfigurationWorkbench = ReturnType<
	typeof useConfigurationWorkbench
>;
