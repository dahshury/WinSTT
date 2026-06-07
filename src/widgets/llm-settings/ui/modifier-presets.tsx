import {
	AiBrain02Icon,
	ArrangeIcon,
	BrushIcon,
	Delete02Icon,
	LanguageSkillIcon,
	Layout01Icon,
	MagicWand01Icon,
	PencilIcon,
	PlusSignIcon,
	StickyNote01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type ReactNode, useState } from "react";
import {
	type BuiltinPresetEntry,
	type CustomModifier,
	INDEPENDENT_PRESETS,
	PRESETS_WITH_LEVELS,
	type PresetLevel,
	type TONE_GROUP,
} from "@/entities/llm-catalog";
import {
	supportsTranslateToEnglish,
	useCatalogStore,
} from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { generateId } from "@/shared/lib/generate-id";
import { findLanguage, LANGUAGES } from "@/shared/lib/languages";
import { surfaceClasses, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import {
	CreatableCombobox,
	type CreatableComboboxItem,
} from "@/shared/ui/creatable-combobox";
import {
	DialogActionButton,
	DialogFooter,
	DialogTitle,
} from "@/shared/ui/dialog";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { IconButton } from "@/shared/ui/icon-button";
import { InfoTooltip } from "@/shared/ui/info-tooltip";
import { Modal } from "@/shared/ui/modal";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { Switcher } from "@/shared/ui/switcher";
import { TextField } from "@/shared/ui/text-field";
import { Toggle } from "@/shared/ui/toggle";
import {
	DEFAULT_LEVEL,
	getLevel,
	getTargetLang,
	getToneKey,
	isIndependentEnabled,
	type LlmFeatureDraft,
	PRESET_LABEL_KEY,
	type PresetCarrier,
	setIndependentLevel,
	setIndependentTargetLang,
	setTone,
	toggleIndependent,
} from "../lib/llm-settings-panel-test-helpers";
import {
	type LlmConfiguration,
	matchConfigurationId,
	useLlmConfigurationsStore,
} from "../model/configurations";
import type { LlmSettingsPanelModel } from "./LlmSettingsPanel";
import type { TranslateFn } from "./types";

type IndependentKey = (typeof INDEPENDENT_PRESETS)[number];

const INDEPENDENT_PRESET_ICONS: Readonly<
	Record<IndependentKey, IconSvgElement>
> = {
	summarize: StickyNote01Icon,
	concise: BrushIcon,
	reorder: ArrangeIcon,
	restructure: Layout01Icon,
	rewordForClarity: MagicWand01Icon,
	translate: LanguageSkillIcon,
};

/** Combobox options for the translate row. The persisted value is the English
 *  name (also the option id), so an unknown/legacy `targetLang` still round-
 *  trips. Code is the badge; native name is appended so speakers recognize
 *  their language regardless of UI locale. */
const LANGUAGE_OPTS: readonly SelectOption[] = LANGUAGES.map((l) => ({
	id: l.englishName,
	label:
		l.englishName === l.nativeName
			? l.englishName
			: `${l.englishName} — ${l.nativeName}`,
	badge: l.code.toUpperCase(),
}));

function languageOptsFor(value: string): readonly SelectOption[] {
	// A persisted language no longer in the catalog must still be selectable
	// (and visible) rather than silently snapping to English.
	if (value && !findLanguage(value)) {
		return [{ id: value, label: value }, ...LANGUAGE_OPTS];
	}
	return LANGUAGE_OPTS;
}

// ── Custom-modifier list mutators ─────────────────────────────────────
// Pure, immutable transforms over `dictation.customModifiers`. The id is
// client-generated and stable for the row's lifetime so React keys / patches
// stay anchored while the user edits the name.

/** A blank modifier for the "Add" dialog. Starts unchecked — a modifier
 *  must not enter the system prompt before the user has written and saved
 *  it; the checkbox is ticked deliberately afterwards. */
function makeDraftModifier(): CustomModifier {
	return {
		id: generateId(),
		name: "",
		prompt: "",
		enabled: false,
		levelsEnabled: false,
		level: DEFAULT_LEVEL,
	};
}

/** Insert (new id) or replace (existing id) — the dialog Save path. */
function upsertCustomModifier(
	list: readonly CustomModifier[],
	modifier: CustomModifier,
): CustomModifier[] {
	return list.some((m) => m.id === modifier.id)
		? list.map((m) => (m.id === modifier.id ? modifier : m))
		: [...list, modifier];
}

function patchCustomModifier(
	list: readonly CustomModifier[],
	id: string,
	patch: Partial<CustomModifier>,
): CustomModifier[] {
	return list.map((m) => (m.id === id ? { ...m, ...patch } : m));
}

function removeCustomModifier(
	list: readonly CustomModifier[],
	id: string,
): CustomModifier[] {
	return list.filter((m) => m.id !== id);
}

// Built-in independent presets + custom rows share one scrollable group;
// past this many total rows the group scrolls instead of growing the panel.
const MODIFIER_SCROLL_THRESHOLD = 7;

interface IndependentPresetListProps {
	customModifiers: readonly CustomModifier[];
	levelOpts: ReadonlyArray<{ value: PresetLevel; label: string }>;
	onLevelChange: (
		key: (typeof INDEPENDENT_PRESETS)[number],
		level: PresetLevel,
	) => void;
	onModifierLevelChange: (id: string, level: PresetLevel) => void;
	onModifierRemove: (id: string) => void;
	onModifierSave: (modifier: CustomModifier) => void;
	onModifierToggle: (id: string, enabled: boolean) => void;
	onTargetLangChange: (lang: string) => void;
	onToggle: (
		key: (typeof INDEPENDENT_PRESETS)[number],
		on: boolean,
		level?: PresetLevel,
		targetLang?: string,
	) => void;
	presets: readonly BuiltinPresetEntry[];
	t: TranslateFn;
	tc: TranslateFn;
	/** True when the STT decoder is already translating to English, so the
	 *  built-in "Translate" modifier is force-off and locked (the transcript
	 *  would otherwise be translated twice). Dictation-only. */
	translateLocked?: boolean;
}

interface CustomModifierRowProps {
	index: number;
	levelOpts: ReadonlyArray<{ value: PresetLevel; label: string }>;
	modifier: CustomModifier;
	onEdit: (modifier: CustomModifier) => void;
	onLevelChange: (id: string, level: PresetLevel) => void;
	onRemove: (id: string) => void;
	onToggle: (id: string, enabled: boolean) => void;
	t: TranslateFn;
}

/** One custom-modifier row, rendered inside the shared CheckboxGroup so it
 *  inherits the same selection/hover visuals as the built-in preset rows.
 *  The checkbox is the `enabled` state; the name/prompt/levels are edited in
 *  the modal opened by the pencil button. The Low/Medium/High switcher only
 *  appears when the modifier has levels enabled. */
function CustomModifierRow({
	index,
	levelOpts,
	modifier,
	onEdit,
	onLevelChange,
	onRemove,
	onToggle,
	t,
}: CustomModifierRowProps) {
	return (
		<CheckboxItem
			checked={modifier.enabled}
			index={index}
			label={modifier.name || t("modifierUnnamed")}
			leading={
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0 text-foreground"
					icon={AiBrain02Icon}
					size={16}
				/>
			}
			onToggle={() => onToggle(modifier.id, !modifier.enabled)}
			trailing={
				<div className="flex items-center gap-1">
					{modifier.levelsEnabled ? (
						// `inline` drops ElevatedSurface's p-1.5 gutter so the L/M/H
						// control stays as short as the row (no row-height growth);
						// w-64 keeps it compact instead of stretching the row.
						<ElevatedSurface className="w-64" inline>
							<Switcher
								fullWidth
								onChange={(v) => onLevelChange(modifier.id, v as PresetLevel)}
								options={levelOpts}
								value={modifier.level ?? DEFAULT_LEVEL}
							/>
						</ElevatedSurface>
					) : null}
					<IconButton
						aria-label={t("modifierEdit")}
						icon={<HugeiconsIcon icon={PencilIcon} size={15} />}
						onClick={() => onEdit(modifier)}
					/>
					<IconButton
						aria-label={t("modifierRemove")}
						icon={<HugeiconsIcon icon={Delete02Icon} size={15} />}
						onClick={() => onRemove(modifier.id)}
					/>
				</div>
			}
		/>
	);
}

interface ModifierDialogProps {
	isEdit: boolean;
	isOpen: boolean;
	modifier: CustomModifier | null;
	onClose: () => void;
	onSave: (modifier: CustomModifier) => void;
	t: TranslateFn;
	tc: TranslateFn;
}

/** Add / edit dialog for a custom modifier: a name, the prompt body, and a
 *  toggle that enables the Low/Medium/High intensity tier. The tier *value*
 *  is chosen on the row's switcher, not here — this toggle only decides
 *  whether the tier exists. `modifier` is a fresh draft (Add) or a copy of an
 *  existing row (Edit); `id` and the persisted `enabled`/`level` flow
 *  straight back through on Save. */
function ModifierDialog({
	isEdit,
	isOpen,
	modifier,
	onClose,
	onSave,
	t,
	tc,
}: ModifierDialogProps) {
	// Seeded once from the initial modifier prop; the parent remounts the
	// dialog with a fresh key when switching rows (Add vs Edit), so re-syncing
	// state from props inside a useEffect would be both redundant and a
	// no-derived-state / cascading-set-state pattern react-doctor flags.
	const [name, setName] = useState(modifier?.name ?? "");
	const [prompt, setPrompt] = useState(modifier?.prompt ?? "");
	const [levelsEnabled, setLevelsEnabled] = useState(
		modifier?.levelsEnabled ?? false,
	);
	// Lift the prompt textarea one step above the popup surface — the same
	// elevation the shared TextField uses — so it reads as an input on the modal
	// rather than a dark inset well (the old hardcoded `bg-surface-1`).
	const inputLevel = Math.min(useSurface() + 1, 8);

	// A modifier needs both a name (its row label) and a prompt body before
	// it can be saved.
	const canSave = name.trim().length > 0 && prompt.trim().length > 0;
	const submit = () => {
		if (!(modifier && canSave)) {
			return;
		}
		// `level` is intentionally preserved from `modifier` (the spread) — the
		// L/M/H value is owned by the row switcher, never set in this dialog.
		onSave({
			...modifier,
			name: name.trim(),
			prompt: prompt.trim(),
			levelsEnabled,
		});
	};

	return (
		<Modal isOpen={isOpen} onClose={onClose}>
			<div className="flex w-[28rem] max-w-[90vw] flex-col gap-4 p-6">
				<DialogTitle>
					{isEdit ? t("modifierEditTitle") : t("modifierAddTitle")}
				</DialogTitle>
				<label className="flex flex-col gap-1.5" htmlFor="modifier-name-input">
					<span className="text-foreground-secondary text-sm">
						{t("modifierName")}
					</span>
					<TextField
						id="modifier-name-input"
						onChange={(e) => setName(e.target.value)}
						placeholder={t("modifierNamePlaceholder")}
						value={name}
					/>
				</label>
				<label
					className="flex flex-col gap-1.5"
					htmlFor="modifier-prompt-input"
				>
					<span className="text-foreground-secondary text-sm">
						{t("modifierPrompt")}
					</span>
					<textarea
						aria-label={t("modifierPrompt")}
						className={`min-h-[120px] w-full resize-y rounded-lg p-2.5 text-body text-foreground caret-accent outline-none placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1 ${surfaceClasses(inputLevel)}`}
						id="modifier-prompt-input"
						onChange={(e) => setPrompt(e.target.value)}
						placeholder={t("modifierPromptPlaceholder")}
						value={prompt}
					/>
				</label>
				<div className="flex items-center justify-between gap-3">
					<div className="flex flex-col">
						<span className="text-foreground text-sm">
							{t("modifierLevels")}
						</span>
						<span className="text-foreground-muted text-xs">
							{t("modifierLevelsCaption")}
						</span>
					</div>
					<Toggle
						aria-label={t("modifierLevels")}
						checked={levelsEnabled}
						onCheckedChange={setLevelsEnabled}
					/>
				</div>
				<DialogFooter>
					<DialogActionButton onClick={onClose} variant="neutral">
						{tc("cancel")}
					</DialogActionButton>
					<DialogActionButton
						disabled={!canSave}
						onClick={submit}
						variant="accent"
					>
						{t("modifierSave")}
					</DialogActionButton>
				</DialogFooter>
			</div>
		</Modal>
	);
}

type IndependentKeyT = (typeof INDEPENDENT_PRESETS)[number];

/** Index persisted presets by key once so per-key level lookups are O(1)
 *  instead of an O(n*m) `.find()` inside the preset loop. */
function indexPresetLevels(
	presets: readonly BuiltinPresetEntry[],
): Map<string, PresetLevel | undefined> {
	const byKey = new Map<string, PresetLevel | undefined>();
	for (const p of presets) {
		byKey.set(p.key, p.level);
	}
	return byKey;
}

/** Seed the local "last-known level" cache from whatever's persisted. */
function seedLevelCache(
	presets: readonly BuiltinPresetEntry[],
): Record<IndependentKeyT, PresetLevel> {
	const levelByKey = indexPresetLevels(presets);
	const cache: Record<string, PresetLevel> = {};
	for (const key of INDEPENDENT_PRESETS) {
		cache[key] = levelByKey.get(key) ?? DEFAULT_LEVEL;
	}
	return cache as Record<IndependentKeyT, PresetLevel>;
}

function IndependentPresetList({
	customModifiers,
	levelOpts,
	onLevelChange,
	onModifierLevelChange,
	onModifierRemove,
	onModifierSave,
	onModifierToggle,
	onTargetLangChange,
	onToggle,
	presets,
	t,
	tc,
	translateLocked,
}: IndependentPresetListProps) {
	// `null` ⇒ dialog closed. A draft (id not in the list) ⇒ Add mode; a copy
	// of an existing row ⇒ Edit mode. The instance is reused; the dialog
	// reseeds its form off `modifier` whenever it (re)opens.
	const [dialogModifier, setDialogModifier] = useState<CustomModifier | null>(
		null,
	);
	const isEditingExisting =
		dialogModifier !== null &&
		customModifiers.some((m) => m.id === dialogModifier.id);

	const closeDialog = () => setDialogModifier(null);
	const handleSave = (modifier: CustomModifier) => {
		onModifierSave(modifier);
		setDialogModifier(null);
	};
	// Remember each preset's last-known level locally so toggling off then on
	// restores the user's previous choice instead of snapping back to medium.
	// Seeded once from whatever's persisted; updated via the row's switcher
	// event handler. We intentionally don't re-sync from `presets` in an
	// effect: every legitimate update flows through `handleLevel` below
	// (which writes both the cache AND the persisted store), so a separate
	// effect that mirrors `presets → cache` would just round-trip the same
	// value and trips no-derived-state / cascading-set-state.
	const [levelCache, setLevelCache] = useState<
		Record<IndependentKeyT, PresetLevel>
	>(() => seedLevelCache(presets));

	// Same toggle-off-then-on memory as `levelCache`, but for the translate
	// row's target language (a single value — only one translate entry can
	// exist). Seeded once; updated via `handleLang` below.
	const [langCache, setLangCache] = useState<string>(() =>
		getTargetLang(presets),
	);

	const builtinCount = INDEPENDENT_PRESETS.length;
	const checkedIndices = new Set<number>();
	INDEPENDENT_PRESETS.forEach((key, i) => {
		if (
			isIndependentEnabled(presets, key) &&
			!(key === "translate" && translateLocked)
		) {
			checkedIndices.add(i);
		}
	});
	customModifiers.forEach((m, i) => {
		if (m.enabled) {
			checkedIndices.add(builtinCount + i);
		}
	});

	const disabledLevelOpts = levelOpts.map((opt) => ({
		...opt,
		disabled: true,
	}));
	const totalRows = builtinCount + customModifiers.length;
	const scrollable = totalRows > MODIFIER_SCROLL_THRESHOLD;

	const group = (
		<CheckboxGroup checkedIndices={checkedIndices} className="w-full">
			{INDEPENDENT_PRESETS.map((key, i) => {
				const checked = isIndependentEnabled(presets, key);
				const isTranslate = key === "translate";
				// STT-side translate-to-English already covers this transcript, so
				// the built-in Translate modifier is force-off and the row locked.
				const rowLocked = isTranslate && Boolean(translateLocked);
				const hasLevel = (PRESETS_WITH_LEVELS as readonly string[]).includes(
					key,
				);
				const displayedLevel = checked
					? getLevel(presets, key)
					: levelCache[key];
				const handleLevel = (lvl: PresetLevel) => {
					setLevelCache((prev) =>
						prev[key] === lvl ? prev : { ...prev, [key]: lvl },
					);
					if (checked) {
						onLevelChange(key, lvl);
					}
				};
				const displayedLang = checked ? getTargetLang(presets) : langCache;
				const handleLang = (lang: string) => {
					setLangCache((prev) => (prev === lang ? prev : lang));
					if (checked) {
						onTargetLangChange(lang);
					}
				};
				// Translate carries the target language in the same trailing
				// slot the leveled presets use for the L/M/H switcher — a
				// searchable combobox over the full language catalog. When the
				// row is unchecked the picker is disabled (parity with the
				// greyed-out `disabledLevelOpts` switcher) but still shows the
				// remembered language so re-enabling restores the choice.
				let trailing: ReactNode = null;
				if (isTranslate) {
					trailing = rowLocked ? (
						<InfoTooltip content={t("translateLockedBySttTooltip")} />
					) : (
						<ElevatedSurface inline>
							<div className="w-44">
								<SearchableSelect
									disabled={!checked}
									onChange={handleLang}
									options={languageOptsFor(displayedLang)}
									placeholder={t("translateLanguagePlaceholder")}
									value={displayedLang}
								/>
							</div>
						</ElevatedSurface>
					);
				} else if (hasLevel) {
					trailing = (
						<ElevatedSurface className="w-64" inline>
							<Switcher
								fullWidth
								onChange={(v) => handleLevel(v as PresetLevel)}
								options={checked ? levelOpts : disabledLevelOpts}
								value={displayedLevel}
							/>
						</ElevatedSurface>
					);
				}
				return (
					<CheckboxItem
						checked={checked && !rowLocked}
						disabled={rowLocked}
						index={i}
						key={key}
						label={t(PRESET_LABEL_KEY[key])}
						leading={
							<HugeiconsIcon
								aria-hidden="true"
								className="shrink-0 text-foreground"
								icon={INDEPENDENT_PRESET_ICONS[key]}
								size={16}
							/>
						}
						onToggle={() =>
							onToggle(
								key,
								!checked,
								levelCache[key],
								isTranslate ? langCache : undefined,
							)
						}
						trailing={trailing}
					/>
				);
			})}
			{customModifiers.map((m, i) => (
				<CustomModifierRow
					index={builtinCount + i}
					key={m.id}
					levelOpts={levelOpts}
					modifier={m}
					onEdit={setDialogModifier}
					onLevelChange={onModifierLevelChange}
					onRemove={onModifierRemove}
					onToggle={onModifierToggle}
					t={t}
				/>
			))}
		</CheckboxGroup>
	);

	return (
		<div className="flex w-full flex-col gap-1.5">
			{scrollable ? (
				<ScrollArea viewportClassName="max-h-[19rem]">{group}</ScrollArea>
			) : (
				group
			)}
			<Button
				className="ml-3 flex items-center gap-1 self-start rounded-md border border-border border-dashed bg-transparent px-3 py-1.5 text-foreground-muted text-sm transition-colors hover:border-accent hover:text-accent"
				onClick={() => setDialogModifier(makeDraftModifier())}
			>
				<HugeiconsIcon icon={PlusSignIcon} size={14} />
				{t("modifierAdd")}
			</Button>
			<ModifierDialog
				isEdit={isEditingExisting}
				isOpen={dialogModifier !== null}
				key={dialogModifier?.id ?? "closed"}
				modifier={dialogModifier}
				onClose={closeDialog}
				onSave={handleSave}
				t={t}
				tc={tc}
			/>
		</div>
	);
}

// Mutable variants of the carrier fields — the helpers below return mutable
// arrays and the underlying updateLlmDictation / updateLlmTransforms expect
// the same. Read-side `PresetCarrier` keeps `readonly` so consumers don't
// accidentally mutate store state in place.
export type PresetUpdate = Partial<{
	customModifiers: CustomModifier[];
	presets: BuiltinPresetEntry[];
}>;

// The full per-feature snapshot (provider/model fields + the tone/modifiers
// carrier). The Configuration combobox needs the model half too, so saving from
// the tone row captures a complete configuration that's also runnable in the
// Playground — `seedDraftFromFeature` (hoisted, defined below) projects it.
export type FullFeatureSnapshot = LlmFeatureDraft & PresetCarrier;

export function seedDraftFromFeature(
	f: LlmFeatureDraft & PresetCarrier,
): LlmConfiguration {
	return {
		enabled: f.enabled,
		maxOutputTokens: f.maxOutputTokens,
		provider: f.provider,
		model: f.model,
		openrouterModel: f.openrouterModel,
		openrouterFallbackModel: f.openrouterFallbackModel,
		reasoningEffort: f.reasoningEffort,
		thinkingEffort: f.thinkingEffort,
		verbosity: f.verbosity,
		presets: [...f.presets],
		customModifiers: [...f.customModifiers],
	};
}

/**
 * Configuration combobox for a feature's Tone row. Lists every saved
 * configuration (shared across both features AND the Playground via
 * `useLlmConfigurationsStore`):
 *   - selecting one applies its tone + modifiers to THIS section (the
 *     provider/model half is left untouched — that's the Playground's job);
 *   - typing a name saves the section's CURRENT full state as a configuration;
 *   - the inline delete removes one.
 * The closed value reflects the configuration whose tone + modifiers currently
 * match the section, or blank once the user diverges. Applying restores custom
 * modifiers wholesale — including ones the user had since deleted, whose full
 * definitions live on inside the saved configuration.
 */
export function ConfigurationsCombobox({
	snapshot,
	t,
	update,
}: {
	snapshot: FullFeatureSnapshot;
	t: TranslateFn;
	update: (patch: PresetUpdate) => void;
}) {
	const configurations = useLlmConfigurationsStore((s) => s.configurations);
	const saveConfiguration = useLlmConfigurationsStore(
		(s) => s.saveConfiguration,
	);
	const removeConfiguration = useLlmConfigurationsStore(
		(s) => s.removeConfiguration,
	);

	const items: CreatableComboboxItem[] = configurations.map((c) => ({
		id: c.id,
		label: c.name,
		deletable: true,
	}));

	const applyConfiguration = (id: string) => {
		const cfg = configurations.find((c) => c.id === id);
		if (!cfg) {
			return;
		}
		update({
			presets: cfg.config.presets.map((p) => ({ ...p })),
			customModifiers: cfg.config.customModifiers.map((m) => ({ ...m })),
		});
	};

	const handleCreate = (rawName: string) => {
		const name = rawName.trim();
		if (name) {
			saveConfiguration(name, seedDraftFromFeature(snapshot));
		}
	};

	return (
		<CreatableCombobox
			className="ml-auto w-52"
			createLabel={(name) => t("modifierPresetCreate", { name })}
			deleteAriaLabel={t("playgroundDeletePreset")}
			emptyLabel={t("modifierPresetEmpty")}
			items={items}
			onCreate={handleCreate}
			onDelete={removeConfiguration}
			onSelect={applyConfiguration}
			placeholder={t("playgroundSelectConfig")}
			value={matchConfigurationId(snapshot, configurations)}
		/>
	);
}

export function FeaturePresetControls({
	configControl,
	feature,
	model,
	snapshot,
	update,
}: {
	/** Configuration combobox rendered on the trailing edge of the Tone row — the
	 *  head of the tone + modifiers group, which is exactly what applying a
	 *  configuration affects (provider/model above the divider are untouched). The
	 *  settings panel passes one; the Playground omits it (it has its own config
	 *  selector). */
	configControl?: ReactNode;
	feature: "dictation" | "transforms";
	model: Pick<LlmSettingsPanelModel, "t" | "tc" | "toneOpts" | "levelOpts">;
	snapshot: PresetCarrier;
	update: (patch: PresetUpdate) => void;
}) {
	const { t, tc, toneOpts, levelOpts } = model;
	const activeTone = getToneKey(snapshot.presets);
	// When the active STT model decodes straight to English, the built-in
	// "Translate" modifier would translate the transcript a second time — lock
	// it off for the dictation pass. Transforms operate on already-selected
	// text, so the STT toggle has no bearing there (lock stays dictation-only).
	const sttTranslateOn = useSettingsStore(
		(s) => s.settings.model?.translateToEnglish ?? false,
	);
	const activeSttModelId = useSettingsStore(
		(s) => s.settings.model?.model ?? "",
	);
	const activeSttModel = useCatalogStore((s) => s.getModel(activeSttModelId));
	const translateLocked =
		feature === "dictation" &&
		sttTranslateOn &&
		activeSttModel !== undefined &&
		supportsTranslateToEnglish(activeSttModel);
	return (
		<div className="flex flex-col divide-y divide-surface-1">
			<div className="col-span-2">
				<FormControl
					label={t("tone")}
					labelTrailing={configControl}
					tooltip={t("toneTooltip")}
				>
					<ElevatedSurface>
						<Switcher
							fullWidth
							onChange={(v) =>
								update({
									presets: setTone(
										snapshot.presets,
										v as (typeof TONE_GROUP)[number],
									),
								})
							}
							options={toneOpts}
							value={activeTone}
						/>
					</ElevatedSurface>
				</FormControl>
			</div>
			<div className="col-span-2">
				<FormControl
					label={t("modifiers")}
					tooltip={`${t("modifiersTooltip")} ${t("modifiersCaption")}`}
				>
					<ElevatedSurface>
						<IndependentPresetList
							customModifiers={snapshot.customModifiers}
							levelOpts={levelOpts}
							onLevelChange={(key, lvl) =>
								update({
									presets: setIndependentLevel(snapshot.presets, key, lvl),
								})
							}
							onModifierLevelChange={(id, level) =>
								update({
									customModifiers: patchCustomModifier(
										snapshot.customModifiers,
										id,
										{ level },
									),
								})
							}
							onModifierRemove={(id) =>
								update({
									customModifiers: removeCustomModifier(
										snapshot.customModifiers,
										id,
									),
								})
							}
							onModifierSave={(modifier) =>
								update({
									customModifiers: upsertCustomModifier(
										snapshot.customModifiers,
										modifier,
									),
								})
							}
							onModifierToggle={(id, enabled) =>
								update({
									customModifiers: patchCustomModifier(
										snapshot.customModifiers,
										id,
										{
											enabled,
										},
									),
								})
							}
							onTargetLangChange={(lang) =>
								update({
									presets: setIndependentTargetLang(snapshot.presets, lang),
								})
							}
							onToggle={(key, on, level, targetLang) =>
								update({
									presets: toggleIndependent(
										snapshot.presets,
										key,
										on,
										level,
										targetLang,
									),
								})
							}
							presets={snapshot.presets}
							t={t}
							tc={tc}
							translateLocked={translateLocked}
						/>
					</ElevatedSurface>
				</FormControl>
			</div>
		</div>
	);
}
