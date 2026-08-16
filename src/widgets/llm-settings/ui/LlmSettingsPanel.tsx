import {
	BrainCircuitIcon,
	SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { Button } from "@/shared/ui/button";
import { FormControl } from "@/shared/ui/form-control";
import { Toggle } from "@/shared/ui/toggle";
import { ownsWarmupBanner } from "../lib/warmup-banner-test-helpers";
import type { AssignableFeature } from "../model/configuration-assignment";
import { useConfigurationWorkbench } from "../model/use-configuration-workbench";
import { useFeatureToggles } from "../model/use-feature-toggles";
import { useLlmSettingsPanel } from "../model/use-llm-settings-panel";
import { AppProfileRulesSection } from "./AppProfileRulesSection";
import { FeatureRow } from "./FeatureRow";
import { LlmSettingsDialogs } from "./LlmSettingsDialogs";
import { PlaygroundModal } from "./playground-modal";
import { DictionaryAutoAddControl } from "./provider-sections";
import { WarmupStatusBanner } from "./WarmupStatusBanner";

/**
 * The Processing tab.
 *
 * The tab ROUTES; it does not author. Everything that defines a profile — model,
 * tone, modifiers, request tuning — lives in the profile editor, which is also
 * where you try it, so there is exactly one place a profile is shaped and no
 * half-copy of those controls here.
 *
 * The body is one list of THREE FEATURE ROWS — dictation, transformations, read
 * aloud — each owning its own switch, its own profile picker, and whatever
 * extras that feature needs (dictionary auto-add, warm-up status), nested under
 * it. Cause and effect share a row. All three are always present, on or off: an
 * off feature fades its icon but keeps its text readable and both controls
 * live, because the switch is how you turn it on and assigning a profile before
 * enabling is a normal order of operations.
 *
 * Under the rows sit the things that are NOT per-feature: the entry point to the
 * profile editor, per-app overrides, and the one machine-wide policy (share a
 * single local model), parked in an "Advanced" group at the bottom.
 *
 * Deliberately flat: no inner tabs, no accordions.
 */
export function LlmSettingsPanel() {
	const model = useLlmSettingsPanel();
	const workbench = useConfigurationWorkbench();
	const toggles = useFeatureToggles(model, workbench);
	const [editorOpen, setEditorOpen] = useState(false);
	const isListenMode = useSettingsStore(
		(s) => (s.settings.general?.recordingMode ?? "ptt") === "listen",
	);
	const listenModeLlmTooltip =
		"Listen mode does not run LLM post-processing or transforms; it only transcribes speaker audio inside the app window.";
	const { t } = model;

	// Local models are VRAM-resident, so "one model for every local profile" is a
	// MACHINE policy, not a property of any one profile — which is why it stays on
	// the tab rather than moving into the per-profile editor.
	const showLocalModelPolicy = workbench.assignments.some(
		(row) => row.provider === "ollama",
	);
	// Dictation-pipeline switch, not a profile property — it stays on the tab so
	// removing the tab's profile editor did not take it with it. Only meaningful
	// while dictation is actually running on Ollama (tool-calling is an Ollama
	// capability).
	const dictation = model.dictation;
	const showDictionaryAutoAdd =
		dictation.enabled && dictation.provider === "ollama";
	// The warm-up banner needs a PER-FEATURE model, not the shared one: the
	// one-model rule can be switched off, and then two rows really are running
	// two different models.
	const featureModel: Record<AssignableFeature, string> = {
		dictation: dictation.model,
		transforms: model.transforms.model,
		readAloud: model.readAloud.model,
	};
	// One banner per distinct failure, not per row — see `ownsWarmupBanner`.
	const ollamaRows = workbench.assignments
		.filter((row) => row.enabled && row.provider === "ollama")
		.map((row) => ({ feature: row.feature, model: featureModel[row.feature] }));
	const daemonUnreachable = model.warmupStatus?.reachable === false;

	return (
		<>
			<SettingSection boxed icon={BrainCircuitIcon} title={t("title")}>
				{/* Provider connection inputs (Ollama endpoint, OpenRouter API key)
				    live in the dedicated Integrations tab — every profile reads the
				    same shared values. */}
				<div className="flex flex-col py-1.5">
					{/* Hairlines between the rows, so three independent switches read as
					    three items rather than one contiguous mode strip. */}
					<div className="flex flex-col divide-y divide-divider">
						{workbench.assignments.map((row) => (
							<FeatureRow
								assignment={row}
								configurations={workbench.configurations}
								disabled={isListenMode}
								disabledTooltip={
									isListenMode ? listenModeLlmTooltip : undefined
								}
								key={row.feature}
								onAssign={(configurationId) =>
									workbench.assign(row.feature, configurationId)
								}
								onCreateProfile={() => setEditorOpen(true)}
								onToggle={(next) => {
									// Always through the controller: it runs the model preflight
									// on the way on and arms the warm/unload spinner. A direct
									// `enabled` write would skip both.
									void toggles[row.feature].toggle(next);
								}}
								pending={toggles[row.feature].pending}
								t={t}
							>
								{row.feature === "dictation" && showDictionaryAutoAdd ? (
									<DictionaryAutoAddControl
										featureSnapshot={dictation}
										ollamaModels={model.ollamaCatalogState.models}
										t={t}
										updateAny={model.updatePostProcessing}
									/>
								) : null}
								{row.enabled &&
								row.provider === "ollama" &&
								ownsWarmupBanner(
									ollamaRows,
									{ feature: row.feature, model: featureModel[row.feature] },
									daemonUnreachable,
								) ? (
									// Surfaces "Ollama not running" / "model failed to load"
									// under a feature the user switched on, instead of one
									// banner for whichever ran first — but only ONCE per
									// failure, since the broadcast describes the daemon or a
									// model rather than any single consumer.
									<WarmupStatusBanner
										feature={row.feature}
										model={featureModel[row.feature]}
										onRetry={model.retryOllamaWarmup}
										provider="ollama"
										status={model.warmupStatus}
									/>
								) : null}
							</FeatureRow>
						))}
					</div>
					{/* Authoring lives in the editor, so the tab needs exactly one door
					    into it. Always enabled: profiles are worth editing whether or
					    not anything is currently running them. */}
					<div className="flex justify-end pt-3 pb-1">
						<Button
							className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 font-medium text-body-sm text-foreground-secondary transition-colors hover:border-accent hover:text-accent"
							onClick={() => setEditorOpen(true)}
						>
							<HugeiconsIcon
								aria-hidden="true"
								icon={SlidersHorizontalIcon}
								size={14}
							/>
							{t("manageProfiles")}
						</Button>
					</div>
					<AppProfileRulesSection
						enabled={workbench.anyEnabled && !isListenMode}
					/>
					{showLocalModelPolicy ? (
						// Last, and labelled as such: a machine-wide memory policy is not
						// something most users touch, and it belongs below the per-feature
						// rows it constrains rather than between them.
						<div className="mt-8 border-divider border-t pt-7">
							<h4 className="font-semibold text-2xs text-foreground-muted uppercase tracking-[0.11em]">
								{t("advancedTitle")}
							</h4>
							<FormControl
								caption={t("allowMultipleLocalModelsCaption")}
								label={t("allowMultipleLocalModels")}
								layout="row"
								tooltip={t("allowMultipleLocalModelsTooltip")}
							>
								<Toggle
									aria-label={t("allowMultipleLocalModels")}
									checked={workbench.allowMultipleLocalModels}
									disabled={isListenMode}
									onCheckedChange={workbench.setAllowMultipleLocalModels}
								/>
							</FormControl>
						</div>
					) : null}
				</div>
			</SettingSection>

			<LlmSettingsDialogs model={model} />
			{/* Modal pins the surface baseline internally, so the editor gets a
			    settings-like elevation ramp (popup → cards → inputs) regardless of
			    how deeply this panel is nested — no wrapper needed here. */}
			<PlaygroundModal
				model={model}
				onClose={() => setEditorOpen(false)}
				open={editorOpen}
			/>
		</>
	);
}
