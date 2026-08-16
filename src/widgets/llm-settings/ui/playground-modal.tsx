import {
	PlusSignIcon,
	SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { computeModelExclusionConfig } from "@/shared/ui/model-picker/lib/model-exclusion";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { type LlmPreviewConfig, runLlmPreview } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { useMountEffect } from "@/shared/lib/use-mount-effect";
import {
	CreatableCombobox,
	type CreatableComboboxItem,
} from "@/shared/ui/creatable-combobox";
import {
	DialogActionButton,
	DialogBody,
	DialogFooter,
	DialogHeader,
	DialogSection,
} from "@/shared/ui/dialog";
import { FormControl } from "@/shared/ui/form-control";
import { IconButton } from "@/shared/ui/icon-button";
import { Modal } from "@/shared/ui/modal";
import { Switcher } from "@/shared/ui/switcher";
import { TextField } from "@/shared/ui/text-field";
import { resolvePlaygroundLocalModel } from "../lib/llm-settings-helpers";
import type { LlmFeatureDraft } from "../lib/llm-settings-panel-test-helpers";
import {
	cloneLlmConfiguration,
	type LlmConfiguration,
	loadPlaygroundSession,
	type SavedConfiguration,
	savePlaygroundSession,
	useLlmConfigurationsStore,
} from "../model/configurations";
import type { LlmSettingsPanelModel } from "../model/use-llm-settings-panel";
import { FeaturePresetControls } from "./modifier-presets";
import { seedDraftFromFeature } from "./modifier-presets-state";
import { Playground } from "./Playground";
import { ProviderSection } from "./provider-sections";
import type { LlmProvider, TranslateFn } from "./types";

// ── Playground modal ──────────────────────────────────────────────────
//
// A single, detached LLM playground (one modal in the AI-processing tab, not a
// duplicated inline block per feature). The config combobox seeds an EDITABLE,
// ephemeral config from the live post-processing config or a saved preset —
// and typing a new name saves the current config as a preset. Tweaks here
// never touch saved settings. The composed config
// (tone + modifiers + provider/model) is sent to the preview IPC as an explicit
// override so the user can test how the LLM behaves under arbitrary configs.

// Built-in (non-deletable) selection — the live unified post-processing config.
// Saved config presets use their own ids.
const LIVE_POST_PROCESSING = "live:post-processing";

/** True for combobox values the restored session can legitimately point at:
 *  the live entry always, a saved preset only while it still exists. */
function isResolvableSelection(
	selection: string,
	presets: readonly SavedConfiguration[],
): boolean {
	return (
		selection === LIVE_POST_PROCESSING ||
		presets.some((p) => p.id === selection)
	);
}

function initialPlaygroundSelection(
	presets: readonly SavedConfiguration[],
): string {
	// A remembered session wins — but if its label was a since-deleted preset,
	// fall back to the live profile entry (the draft itself is still restored).
	const session = loadPlaygroundSession();
	if (session) {
		return isResolvableSelection(session.selection, presets)
			? session.selection
			: LIVE_POST_PROCESSING;
	}
	return LIVE_POST_PROCESSING;
}

/** Resolve the editable draft for the chosen combobox value — a live config or
 *  a clone of a saved preset. */
function seedForSelection(
	selection: string,
	model: LlmSettingsPanelModel,
	presets: readonly SavedConfiguration[],
): LlmConfiguration {
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
	// Only restore the remembered draft when its label still resolves. If the
	// remembered preset was deleted, `initialPlaygroundSelection` falls back to the
	// live entry — so seed the draft from that same live selection instead of
	// restoring the deleted preset's tweaks under a "live post-processing" label.
	if (session && isResolvableSelection(session.selection, presets)) {
		return cloneLlmConfiguration(session.config);
	}
	return seedForSelection(initialPlaygroundSelection(presets), model, presets);
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
	// Shared "Source" label so the playground's provider row matches the
	// settings tabs (options are the translated Local/Cloud strings).
	const tSource = useTranslations("integrations");

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
		<div className="flex flex-col divide-y divide-divider">
			<FormControl
				label={tSource("sourceLabel")}
				layout="row"
				tooltip={t("providerTooltip")}
			>
				<Switcher
					className="w-52"
					fullWidth
					onChange={(v) => handleProvider(v as LlmProvider)}
					options={providerOpts}
					value={draft.provider}
				/>
			</FormControl>
			<ProviderSection
				beginOllamaSwap={() => undefined}
				dense
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

/** Combobox items for the playground config selector: the live config
 *  (non-deletable) followed by the saved config presets (deletable). */
function buildConfigItems(
	presets: readonly SavedConfiguration[],
	t: TranslateFn,
): CreatableComboboxItem[] {
	return [
		{ id: LIVE_POST_PROCESSING, label: t("title") },
		...presets.map((p) => ({ id: p.id, label: p.name, deletable: true })),
	];
}

/**
 * The header's profile control: pick a profile, or add one.
 *
 * Adding used to be reachable ONLY by typing a name into the picker's search
 * box and then hitting the synthesized "Create …" row — an affordance you had
 * to already know about, because nothing on screen said "you can add one here".
 * So adding now has its own button, and pressing it swaps the picker for a
 * name field: a profile is referenced by name everywhere else (per-mode
 * pickers, per-app rules), so naming is real content, not a step to skip. The
 * type-to-create path still works for anyone who already learned it.
 */
function ProfilePicker({
	items,
	onCreate,
	onDelete,
	onSelect,
	t,
	tc,
	value,
}: {
	items: CreatableComboboxItem[];
	onCreate: (name: string) => void;
	onDelete: (id: string) => void;
	onSelect: (id: string) => void;
	t: TranslateFn;
	tc: TranslateFn;
	value: string;
}) {
	const [naming, setNaming] = useState(false);

	if (naming) {
		return (
			<ProfileNameField
				onCancel={() => setNaming(false)}
				onCommit={(name) => {
					onCreate(name);
					setNaming(false);
				}}
				t={t}
				tc={tc}
			/>
		);
	}

	return (
		<>
			<CreatableCombobox
				className="w-56"
				createLabel={(name) => t("modifierPresetCreate", { name })}
				deleteAriaLabel={t("playgroundDeletePreset")}
				emptyLabel={t("modifierPresetEmpty")}
				// The same action, pinned to the bottom of the open popup — that is
				// where you already are when you go looking for "is there another
				// one?" and find there isn't.
				footerAction={{
					label: t("profileAdd"),
					onSelect: () => setNaming(true),
				}}
				items={items}
				onCreate={onCreate}
				onDelete={onDelete}
				onSelect={onSelect}
				placeholder={t("playgroundSelectConfig")}
				value={value}
			/>
			{/* IconButton carries its own tooltip (defaults to the aria-label), so
			    the label is both the accessible name and the hover hint. */}
			<IconButton
				aria-label={t("profileAdd")}
				icon={<HugeiconsIcon icon={PlusSignIcon} size={14} />}
				onClick={() => setNaming(true)}
			/>
		</>
	);
}

/** Name-and-confirm state for a new profile. Mounted only while naming, so the
 *  focus lands on a fresh field and the text never survives a cancel. */
function ProfileNameField({
	onCancel,
	onCommit,
	t,
	tc,
}: {
	onCancel: () => void;
	onCommit: (name: string) => void;
	t: TranslateFn;
	tc: TranslateFn;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [name, setName] = useState("");
	const canCommit = name.trim().length > 0;

	// External DOM side effect on a component that exists only while naming —
	// no prop-driven reset needed, the mount IS the reset.
	useMountEffect(() => {
		inputRef.current?.focus();
	});

	return (
		<>
			<TextField
				aria-label={t("profileNamePlaceholder")}
				className="w-44"
				onChange={(event) => setName(event.target.value)}
				onKeyDown={(event) => {
					// Enter commits; Escape backs out of naming WITHOUT closing the
					// dialog, so it must not reach the popup's own Escape handler.
					if (event.key === "Enter" && canCommit) {
						onCommit(name);
					} else if (event.key === "Escape") {
						event.stopPropagation();
						onCancel();
					}
				}}
				placeholder={t("profileNamePlaceholder")}
				ref={inputRef}
				value={name}
			/>
			{/* A worded Cancel, not an ✕: the dialog's own close ✕ sits immediately
			    to the right, and two identical glyphs side by side is a coin flip
			    between "discard this name" and "throw away the whole dialog". */}
			<DialogActionButton onClick={onCancel} variant="neutral">
				{tc("cancel")}
			</DialogActionButton>
			<DialogActionButton
				disabled={!canCommit}
				onClick={() => onCommit(name)}
				variant="accent"
			>
				{tc("add")}
			</DialogActionButton>
		</>
	);
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
		initialPlaygroundSelection(presets),
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
			handleSelect(LIVE_POST_PROCESSING);
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

	// Auto-select an installed model whenever the Local (Ollama) provider is
	// active so the playground opens ready-to-run instead of gated on a manual
	// pick. The catalog scan is async, so this reacts to the model list
	// resolving as well as to a provider flip. A previously-selected model that's
	// still installed is kept; one that was since deleted is swapped for the
	// nearest install; an empty selection defaults to the first install. The
	// resulting pick is remembered by the session-write effect above (it mirrors
	// every draft change to localStorage). Adjusted DURING render (not an effect)
	// so there's no cascading commit — the resolver returns null once `draft.model`
	// names a valid install, so this converges. See react.dev "You Might Not Need
	// an Effect" → adjusting state while rendering.
	if (draft.provider === "ollama") {
		const next = resolvePlaygroundLocalModel(
			model.ollamaCatalogState.models,
			draft.model,
		);
		if (next !== null) {
			setDraft((prev) => ({ ...prev, model: next }));
		}
	}

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
		return runLlmPreview(sample, "dictation", config);
	};

	return (
		<div className="flex max-h-[86vh] w-[44rem] max-w-[94vw] flex-col">
			{/* Header / body / footer rails. The profile picker rides in the header's
			    trailing slot rather than sitting as the first body row: it selects
			    WHICH profile everything below edits, so it belongs to the dialog's
			    identity, not to its content. That also keeps it on screen while the
			    body scrolls. */}
			<DialogHeader
				closeLabel={tc("close")}
				icon={<HugeiconsIcon icon={SlidersHorizontalIcon} size={15} />}
				onClose={onClose}
				rail
				title={t("profileEditorTitle")}
				trailing={
					<ProfilePicker
						items={configItems}
						onCreate={handleCreatePreset}
						onDelete={deletePreset}
						onSelect={handleSelect}
						t={t}
						tc={tc}
						value={selection}
					/>
				}
			/>
			<DialogBody className="flex-1" maxHeight="none">
				{/* The config groups stay unlabelled: every row inside them already
				    carries its own label (Source / Model / Tone / Modifiers), so a
				    group heading would only repeat one of them. The rule between
				    sections is what does the grouping. The run surface DOES get a
				    heading — it is the one block that stops being configuration. */}
				<DialogSection divided={false}>
					<PlaygroundModelPicker
						draft={draft}
						model={model}
						onChange={update}
					/>
				</DialogSection>
				{/* Everything below the model selection — tone/modifiers and the run
				    surface — is inert until a usable model is configured for the
				    chosen provider: there's nothing to tune or test without one. The
				    Playground's own `disabled` still surfaces the reason. */}
				<div
					aria-disabled={!hasModel || undefined}
					className={cn(
						// settings-dim (not opacity-40) so the divide-y hairlines
						// stay crisp while the group greys out.
						!hasModel && "settings-dim pointer-events-none",
					)}
				>
					<DialogSection>
						{/* Re-key on `selection` so the preset list's internal level/lang
						    caches reseed from the freshly-seeded draft on switch. */}
						<FeaturePresetControls
							feature="dictation"
							key={selection}
							model={model}
							snapshot={{
								presets: draft.presets,
								customModifiers: draft.customModifiers,
							}}
							update={update}
						/>
					</DialogSection>
					<DialogSection label={t("transformPlaygroundTitle")}>
						<Playground
							disabled={runDisabled}
							disabledReason={disabledReason}
							run={run}
						/>
					</DialogSection>
				</div>
			</DialogBody>
			{/* The caveat that edits here are ephemeral belongs where the user
			    leaves the dialog, not in the header where it competed with the
			    title for two lines. */}
			<DialogFooter
				bar
				leading={
					<p className="m-0 line-clamp-2 text-foreground-muted text-xs-tight">
						{t("playgroundConfigHint")}
					</p>
				}
			>
				<DialogActionButton onClick={onClose} variant="neutral">
					{tc("close")}
				</DialogActionButton>
			</DialogFooter>
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
