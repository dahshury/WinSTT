import { Cancel01Icon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { computeModelExclusionConfig } from "@/widgets/model-picker";
import { useEffect, useRef, useState } from "react";
import { type LlmPreviewConfig, runLlmPreview } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { useMountEffect } from "@/shared/lib/use-mount-effect";
import {
	CreatableCombobox,
	type CreatableComboboxItem,
} from "@/shared/ui/creatable-combobox";
import { DialogTitle } from "@/shared/ui/dialog";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { IconButton } from "@/shared/ui/icon-button";
import { Modal } from "@/shared/ui/modal";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Switcher } from "@/shared/ui/switcher";
import type { LlmFeatureDraft } from "../lib/llm-settings-panel-test-helpers";
import {
	cloneLlmConfiguration,
	type LlmConfiguration,
	loadPlaygroundSession,
	type SavedConfiguration,
	savePlaygroundSession,
	useLlmConfigurationsStore,
} from "../model/configurations";
import type { LlmSettingsPanelModel } from "./LlmSettingsPanel";
import {
	FeaturePresetControls,
	seedDraftFromFeature,
} from "./modifier-presets";
import { Playground } from "./Playground";
import { ProviderSection } from "./provider-sections";
import type { LlmProvider, TranslateFn } from "./types";

// ── Playground modal ──────────────────────────────────────────────────
//
// A single, detached LLM playground (one modal in the AI-processing tab, not a
// duplicated inline block per feature). The config combobox seeds an EDITABLE,
// ephemeral config from the saved Dictation config, the saved Transforms
// config, or a saved preset — and typing a new name saves the current config
// as a preset. Tweaks here never touch saved settings. The composed config
// (tone + modifiers + provider/model) is sent to the preview IPC as an explicit
// override so the user can test how the LLM behaves under arbitrary configs.

// Built-in (non-deletable) selections — the live dictation/transforms configs.
// Saved config presets use their own ids.
const LIVE_DICTATION = "live:dictation";
const LIVE_TRANSFORMS = "live:transforms";

/** True for combobox values the restored session can legitimately point at:
 *  the two live entries always, a saved preset only while it still exists. */
function isResolvableSelection(
	selection: string,
	presets: readonly SavedConfiguration[],
): boolean {
	return (
		selection === LIVE_DICTATION ||
		selection === LIVE_TRANSFORMS ||
		presets.some((p) => p.id === selection)
	);
}

function initialPlaygroundSelection(
	model: LlmSettingsPanelModel,
	presets: readonly SavedConfiguration[],
): string {
	// A remembered session wins — but if its label was a since-deleted preset,
	// fall back to the Dictation entry (the draft itself is still restored).
	const session = loadPlaygroundSession();
	if (session) {
		return isResolvableSelection(session.selection, presets)
			? session.selection
			: LIVE_DICTATION;
	}
	return model.dictation.enabled || !model.transforms.enabled
		? LIVE_DICTATION
		: LIVE_TRANSFORMS;
}

/** Resolve the editable draft for the chosen combobox value — a live config or
 *  a clone of a saved preset. */
function seedForSelection(
	selection: string,
	model: LlmSettingsPanelModel,
	presets: readonly SavedConfiguration[],
): LlmConfiguration {
	if (selection === LIVE_TRANSFORMS) {
		return seedDraftFromFeature(model.transforms);
	}
	const preset = presets.find((p) => p.id === selection);
	if (preset) {
		return cloneLlmConfiguration(preset.config);
	}
	return seedDraftFromFeature(model.dictation);
}

/** Initial editable draft when the playground opens: the model/config the user
 *  last left it on (restored from the persisted session) if present, otherwise
 *  the live config for the feature they're most likely tuning. */
function initialPlaygroundDraft(
	model: LlmSettingsPanelModel,
	presets: readonly SavedConfiguration[],
): LlmConfiguration {
	const session = loadPlaygroundSession();
	if (session) {
		return cloneLlmConfiguration(session.config);
	}
	return seedForSelection(
		initialPlaygroundSelection(model, presets),
		model,
		presets,
	);
}

/**
 * Provider + model picker for the playground. Reuses the SAME `ProviderSection`
 * the settings panel uses (real Ollama picker with install/download/swap, real
 * OpenRouter picker, Apple Intelligence stub) — no bespoke combobox. The
 * editable draft is a structural superset of `LlmFeatureDraft`, so the picker
 * drives it directly via `updateAny`. Swap-tracking is a no-op here (the
 * playground doesn't need the from→to animation).
 */
function PlaygroundModelPicker({
	draft,
	model,
	onChange,
}: {
	draft: LlmConfiguration;
	model: LlmSettingsPanelModel;
	onChange: (patch: Partial<LlmConfiguration>) => void;
}) {
	const {
		t,
		tc,
		providerOpts,
		ollamaCatalogState,
		openrouterCatalogState,
		openrouterApiKey,
	} = model;

	const handleProvider = (provider: LlmProvider) => {
		onChange({ provider });
		if (provider === "ollama" && !ollamaCatalogState.isLoaded) {
			ollamaCatalogState.scanModels();
		} else if (
			provider === "openrouter" &&
			openrouterApiKey.trim().length > 0 &&
			!openrouterCatalogState.isLoaded
		) {
			openrouterCatalogState.scanModels();
		}
	};

	// Explicit `LlmFeatureDraft` projection (the picker's prop shape). `enabled`
	// is forced on so the picker is fully interactive regardless of the seeded
	// feature's toggle state.
	const featureSnapshot: LlmFeatureDraft = {
		enabled: true,
		maxOutputTokens: draft.maxOutputTokens,
		model: draft.model,
		openrouterFallbackModel: draft.openrouterFallbackModel,
		openrouterModel: draft.openrouterModel,
		provider: draft.provider,
		reasoningEffort: draft.reasoningEffort,
		thinkingEffort: draft.thinkingEffort,
		verbosity: draft.verbosity,
	};

	return (
		<div className="flex flex-col divide-y divide-surface-1">
			<div className="col-span-2">
				<FormControl label={t("provider")} tooltip={t("providerTooltip")}>
					<ElevatedSurface>
						<Switcher
							onChange={(v) => handleProvider(v as LlmProvider)}
							options={providerOpts}
							value={draft.provider}
						/>
					</ElevatedSurface>
				</FormControl>
			</div>
			<ProviderSection
				beginOllamaSwap={() => undefined}
				fallbackExclusion={computeModelExclusionConfig(draft.openrouterModel)}
				featureSnapshot={featureSnapshot}
				librarySearch={model.librarySearchProps}
				ollamaCatalog={ollamaCatalogState}
				ollamaPullBundle={model.ollamaPullBundle}
				ollamaReachable={model.ollamaReachable}
				ollamaSwap={null}
				openrouterApiKey={openrouterApiKey}
				openrouterCatalog={openrouterCatalogState}
				t={t}
				tc={tc}
				updateAny={onChange}
			/>
		</div>
	);
}

/** True when the chosen provider has enough configured to actually run. */
function playgroundHasModel(
	draft: LlmConfiguration,
	openrouterApiKey: string,
): boolean {
	if (draft.provider === "apple-intelligence") {
		return true;
	}
	if (draft.provider === "openrouter") {
		return (
			openrouterApiKey.trim().length > 0 && draft.openrouterModel.length > 0
		);
	}
	return draft.model.length > 0;
}

/** Combobox items for the playground config selector: the two live configs
 *  (non-deletable) followed by the saved config presets (deletable). */
function buildConfigItems(
	presets: readonly SavedConfiguration[],
	t: TranslateFn,
): CreatableComboboxItem[] {
	return [
		{ id: LIVE_DICTATION, label: t("playgroundConfigDictation") },
		{ id: LIVE_TRANSFORMS, label: t("playgroundConfigTransforms") },
		...presets.map((p) => ({ id: p.id, label: p.name, deletable: true })),
	];
}

function PlaygroundModalBody({
	model,
	onClose,
}: {
	model: LlmSettingsPanelModel;
	onClose: () => void;
}) {
	const { t, tc } = model;
	// Saved configurations come from the shared store so the Playground and the
	// per-feature tone-row comboboxes all read/write ONE live list. Selection +
	// draft seed once (lazy initializer) from whatever's saved at open.
	const presets = useLlmConfigurationsStore((s) => s.configurations);
	const saveConfiguration = useLlmConfigurationsStore(
		(s) => s.saveConfiguration,
	);
	const removeConfiguration = useLlmConfigurationsStore(
		(s) => s.removeConfiguration,
	);
	const [selection, setSelection] = useState<string>(() =>
		initialPlaygroundSelection(model, presets),
	);
	const [draft, setDraft] = useState<LlmConfiguration>(() =>
		initialPlaygroundDraft(model, presets),
	);

	// Mirror the current config + combobox label to localStorage so the next
	// open restores the model/tweaks instead of re-seeding from the live config.
	// External-store sync (not derived state) — the write lives in the effect
	// body, never a setState, so it's the allowed useEffect shape. The mount run
	// is skipped (the ref resets on each open since the body remounts) so simply
	// opening and closing without touching anything doesn't freeze the live seed;
	// only edits made inside the playground are remembered.
	const sessionWriteArmed = useRef(false);
	useEffect(() => {
		if (!sessionWriteArmed.current) {
			sessionWriteArmed.current = true;
			return;
		}
		savePlaygroundSession({ selection, config: draft });
	}, [selection, draft]);

	const update = (patch: Partial<LlmConfiguration>) =>
		setDraft((prev) => ({ ...prev, ...patch }));

	const handleSelect = (next: string) => {
		setSelection(next);
		setDraft(seedForSelection(next, model, presets));
	};

	const handleCreatePreset = (rawName: string) => {
		const name = rawName.trim();
		if (!name) {
			return;
		}
		// The store clones the draft on save, so later tweaks never mutate it.
		setSelection(saveConfiguration(name, draft));
	};

	const deletePreset = (id: string) => {
		removeConfiguration(id);
		if (selection === id) {
			handleSelect(LIVE_DICTATION);
		}
	};

	// One-shot catalog warm on open so the model dropdown isn't empty for a
	// provider the per-feature settings hadn't already scanned. Mount-only by
	// intent: re-firing on draft.provider / catalog-state changes would re-scan
	// on every interaction. Provider switches do their own scan in `handleProvider`.
	useMountEffect(() => {
		if (draft.provider === "ollama" && !model.ollamaCatalogState.isLoaded) {
			model.ollamaCatalogState.scanModels();
		} else if (
			draft.provider === "openrouter" &&
			model.openrouterApiKey.trim().length > 0 &&
			!model.openrouterCatalogState.isLoaded
		) {
			model.openrouterCatalogState.scanModels();
		}
	});

	// The preview runs the composed config directly — it does NOT require the
	// dictation/transforms feature to be toggled on (the server applies the
	// explicit override regardless). So the only gate is having a usable model
	// for the chosen provider; once that's set, typing a sample enables Run.
	const hasModel = playgroundHasModel(draft, model.openrouterApiKey);
	const runDisabled = !hasModel;
	const disabledReason = hasModel ? undefined : t("playgroundNoModel");

	const configItems = buildConfigItems(presets, t);

	const run = (sample: string) => {
		const config: LlmPreviewConfig = {
			provider: draft.provider,
			model: draft.model,
			openrouterModel: draft.openrouterModel,
			openrouterFallbackModel: draft.openrouterFallbackModel,
			reasoningEffort: draft.reasoningEffort,
			verbosity: draft.verbosity,
			maxOutputTokens: draft.maxOutputTokens,
			thinkingEffort: draft.thinkingEffort,
			presets: draft.presets,
			customModifiers: draft.customModifiers,
		};
		return runLlmPreview(
			sample,
			selection === LIVE_TRANSFORMS ? "transforms" : "dictation",
			config,
		);
	};

	return (
		<div className="flex w-[44rem] max-w-[94vw] flex-col">
			<header className="flex shrink-0 items-center gap-2 px-6 pt-6 pb-3">
				<HugeiconsIcon className="text-accent" icon={PlayIcon} size={18} />
				<DialogTitle className="min-w-0 flex-1 truncate">
					{t("playgroundModalTitle")}
				</DialogTitle>
				<IconButton
					aria-label={tc("cancel")}
					className="ml-auto bg-surface-4 ring-1 ring-divider hover:bg-surface-5"
					icon={<HugeiconsIcon icon={Cancel01Icon} size={16} />}
					onClick={onClose}
				/>
			</header>
			{/* The viewport carries the max-height + overflow so the body scrolls
			    even though the popup is content-sized (a `flex-1` child of a
			    `max-h` popup never gets a definite height to scroll within). */}
			<ScrollArea viewportClassName="max-h-[76vh] px-6 pb-6" verticalOnly>
				<div className="flex flex-col gap-4">
					<FormControl
						label={t("playgroundConfigLabel")}
						tooltip={t("playgroundConfigHint")}
					>
						<CreatableCombobox
							createLabel={(name) => t("modifierPresetCreate", { name })}
							deleteAriaLabel={t("playgroundDeletePreset")}
							emptyLabel={t("modifierPresetEmpty")}
							items={configItems}
							onCreate={handleCreatePreset}
							onDelete={deletePreset}
							onSelect={handleSelect}
							placeholder={t("playgroundSelectConfig")}
							value={selection}
						/>
					</FormControl>
					<PlaygroundModelPicker
						draft={draft}
						model={model}
						onChange={update}
					/>
					{/* Everything below the model selection — tone/modifiers and the
					    run surface — is inert until a usable model is configured for
					    the chosen provider: there's nothing to tune or test without
					    one. The Playground's own `disabled` still surfaces the reason. */}
					<div
						aria-disabled={!hasModel || undefined}
						className={cn(
							"flex flex-col gap-4",
							!hasModel && "pointer-events-none opacity-40",
						)}
					>
						{/* Re-key on `selection` so the preset list's internal level/lang
						    caches reseed from the freshly-seeded draft on switch. */}
						<FeaturePresetControls
							feature="transforms"
							key={selection}
							model={model}
							snapshot={{
								presets: draft.presets,
								customModifiers: draft.customModifiers,
							}}
							update={update}
						/>
						<Playground
							disabled={runDisabled}
							disabledReason={disabledReason}
							run={run}
						/>
					</div>
				</div>
			</ScrollArea>
		</div>
	);
}

/** Detached LLM playground modal. The body is mounted only while open so each
 *  open re-seeds a fresh ephemeral draft from the current saved settings. */
export function PlaygroundModal({
	model,
	onClose,
	open,
}: {
	model: LlmSettingsPanelModel;
	onClose: () => void;
	open: boolean;
}) {
	return (
		<Modal isOpen={open} onClose={onClose}>
			{open ? <PlaygroundModalBody model={model} onClose={onClose} /> : null}
		</Modal>
	);
}
