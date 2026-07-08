import {
	AiBrain02Icon,
	ArrangeIcon,
	BrushIcon,
	ArrowLeft01Icon,
	ArrowRight01Icon,
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
import { cn } from "@/shared/lib/cn";
import {
	surfaceClasses,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
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
import { type SelectOption, usePopupSurfaceLevels } from "@/shared/ui/select";
import { Switcher } from "@/shared/ui/switcher";
import { TextField } from "@/shared/ui/text-field";
import { Toggle } from "@/shared/ui/toggle";
import { Tooltip } from "@/shared/ui/tooltip";
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
	configurationsEqual,
	type LlmConfiguration,
	matchPostProcessingProfileId,
	postProcessingPatchFromConfiguration,
	useLlmConfigurationsStore,
	withAvailableLlmProvider,
} from "../model/configurations";
import { iconForPostProcessingProfileId } from "../model/profile-icons";
import type { LlmSettingsPanelModel } from "../model/use-llm-settings-panel";
import { seedDraftFromFeature } from "./modifier-presets-state";
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

/** i18n keys for each built-in modifier's hover tooltip: a one-line
 *  description plus a tiny before → after example. */
const PRESET_TOOLTIP_KEYS = {
	summarize: {
		desc: "presetSummarizeDesc",
		before: "presetSummarizeExampleBefore",
		after: "presetSummarizeExampleAfter",
	},
	concise: {
		desc: "presetConciseDesc",
		before: "presetConciseExampleBefore",
		after: "presetConciseExampleAfter",
	},
	reorder: {
		desc: "presetReorderDesc",
		before: "presetReorderExampleBefore",
		after: "presetReorderExampleAfter",
	},
	restructure: {
		desc: "presetRestructureDesc",
		before: "presetRestructureExampleBefore",
		after: "presetRestructureExampleAfter",
	},
	rewordForClarity: {
		desc: "presetRewordForClarityDesc",
		before: "presetRewordForClarityExampleBefore",
		after: "presetRewordForClarityExampleAfter",
	},
	translate: {
		desc: "presetTranslateDesc",
		before: "presetTranslateExampleBefore",
		after: "presetTranslateExampleAfter",
	},
} as const satisfies Readonly<
	Record<IndependentKey, { after: string; before: string; desc: string }>
>;

/** Beautified tooltip body for a modifier row: the description up top, then a
 *  framed example card showing the transformation (before → after). Rendered
 *  inside the tooltip popup's SurfaceProvider, so the card sits one surface
 *  step above the popup. */
function ModifierTooltipBody({
	after,
	before,
	desc,
	exampleLabel,
}: {
	after?: string;
	before?: string;
	desc: string;
	exampleLabel: string;
}) {
	const cardLevel = Math.min(useSurface() + 1, 8);
	return (
		<span className="flex w-60 flex-col gap-1.5">
			<span className="text-foreground-secondary">{desc}</span>
			{before && after ? (
				<span
					className={`flex flex-col gap-0.5 rounded-md px-2 py-1.5 ring-1 ring-divider-strong ring-inset ${surfaceClasses(cardLevel)}`}
				>
					<span className="text-[9.5px] text-foreground-muted uppercase tracking-[0.08em]">
						{exampleLabel}
					</span>
					<span className="text-foreground-muted italic" dir="auto">
						“{before}”
					</span>
					<span aria-hidden="true" className="text-accent leading-none">
						↓
					</span>
					<span className="text-foreground" dir="auto">
						“{after}”
					</span>
				</span>
			) : null}
		</span>
	);
}

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
			tooltip={
				modifier.prompt ? (
					<ModifierTooltipBody
						desc={modifier.prompt}
						exampleLabel={t("modifierExampleLabel")}
					/>
				) : undefined
			}
			trailing={
				<div className="flex items-center gap-1">
					{modifier.levelsEnabled ? (
						// `size="sm"` keeps the L/M/H control within the row's line-box
						// (no row-height growth vs a modifier without levels); w-52
						// keeps it compact instead of stretching the row.
						<Switcher
							className="w-52"
							fullWidth
							onChange={(v) => onLevelChange(modifier.id, v as PresetLevel)}
							options={levelOpts}
							size="sm"
							value={modifier.level ?? DEFAULT_LEVEL}
						/>
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
			<div className="flex w-[28rem] max-w-[90vw] flex-col p-6">
				<DialogTitle>
					{isEdit ? t("modifierEditTitle") : t("modifierAddTitle")}
				</DialogTitle>
				{/* Same hairline-divided, self-padded row column the settings panels
				    use — text inputs stacked, the compact toggle as a one-liner row. */}
				<div className="flex flex-col divide-y divide-divider">
					<FormControl label={t("modifierName")}>
						<TextField
							id="modifier-name-input"
							onChange={(e) => setName(e.target.value)}
							placeholder={t("modifierNamePlaceholder")}
							value={name}
						/>
					</FormControl>
					<FormControl label={t("modifierPrompt")}>
						<textarea
							aria-label={t("modifierPrompt")}
							className={`min-h-[120px] w-full resize-y rounded-lg p-2.5 text-body text-foreground caret-accent outline-none placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1 ${surfaceClasses(inputLevel)}`}
							id="modifier-prompt-input"
							onChange={(e) => setPrompt(e.target.value)}
							placeholder={t("modifierPromptPlaceholder")}
							value={prompt}
						/>
					</FormControl>
					<FormControl
						caption={t("modifierLevelsCaption")}
						label={t("modifierLevels")}
						layout="row"
					>
						<Toggle
							aria-label={t("modifierLevels")}
							checked={levelsEnabled}
							onCheckedChange={setLevelsEnabled}
						/>
					</FormControl>
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
						// Bare + `size="sm"`: the picker self-elevates (no wrapping
						// ElevatedSurface) and its 18px-tall trigger matches the
						// leveled rows' `size="sm"` switcher, so the Translate row
						// stays exactly as tall as the others.
						<SearchableSelect
							className="w-44"
							disabled={!checked}
							onChange={handleLang}
							options={languageOptsFor(displayedLang)}
							placeholder={t("translateLanguagePlaceholder")}
							size="sm"
							value={displayedLang}
						/>
					);
				} else if (hasLevel) {
					trailing = (
						<Switcher
							className="w-52"
							fullWidth
							onChange={(v) => handleLevel(v as PresetLevel)}
							options={checked ? levelOpts : disabledLevelOpts}
							size="sm"
							value={displayedLevel}
						/>
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
						tooltip={
							<ModifierTooltipBody
								after={t(PRESET_TOOLTIP_KEYS[key].after)}
								before={t(PRESET_TOOLTIP_KEYS[key].before)}
								desc={t(PRESET_TOOLTIP_KEYS[key].desc)}
								exampleLabel={t("modifierExampleLabel")}
							/>
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
		<div className="flex w-full flex-col gap-1.5 pb-1.5">
			{scrollable ? (
				<ScrollArea viewportClassName="max-h-[19rem]">{group}</ScrollArea>
			) : (
				group
			)}
			<Button
				className="ml-3 inline-flex shrink-0 items-center gap-1.5 self-start rounded-md bg-foreground/[0.06] px-2.5 py-1.5 font-medium text-body-sm text-foreground transition-colors duration-150 hover:bg-foreground/10 active:scale-[0.98]"
				onClick={() => setDialogModifier(makeDraftModifier())}
			>
				<HugeiconsIcon icon={PlusSignIcon} size={12} />
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
// carrier). Saved post-processing profiles capture a complete configuration
// that's also runnable in the Playground.
export type FullFeatureSnapshot = LlmFeatureDraft & PresetCarrier;

/**
 * Full-profile picker for the unified post-processing header. Selecting a saved
 * profile applies provider/model, tone, modifiers and request-tuning settings
 * together; the enable toggle is deliberately excluded so profile swaps do not
 * silently turn post-processing on or off.
 */
export function PostProcessingProfilesCombobox({
	disabled = false,
	snapshot,
	t,
	update,
}: {
	disabled?: boolean;
	snapshot: FullFeatureSnapshot;
	t: TranslateFn;
	update: (patch: Partial<LlmConfiguration>) => void;
}) {
	const configurations = useLlmConfigurationsStore((s) => s.configurations);
	const saveConfiguration = useLlmConfigurationsStore(
		(s) => s.saveConfiguration,
	);
	const removeConfiguration = useLlmConfigurationsStore(
		(s) => s.removeConfiguration,
	);
	const moveConfiguration = useLlmConfigurationsStore(
		(s) => s.moveConfiguration,
	);
	const activeConfigurationId = useLlmConfigurationsStore(
		(s) => s.activeConfigurationId,
	);
	const setActiveConfiguration = useLlmConfigurationsStore(
		(s) => s.setActiveConfiguration,
	);
	const updateConfiguration = useLlmConfigurationsStore(
		(s) => s.updateConfiguration,
	);
	const openrouterKey = useSettingsStore(
		(s) => s.settings.llm.openrouterApiKey,
	);
	const draft = seedDraftFromFeature(snapshot);
	const matchedId = matchPostProcessingProfileId(draft, configurations);
	// The applied preset is "modified" once the live settings diverge from the
	// config it was applied from — that dirty row exposes Save (overwrite) and
	// Reset (revert) actions inside the dropdown. Compare against the key-gated
	// form so a keyless OpenRouter preset (which applies as its local fallback)
	// isn't perpetually "dirty" and its Reset actually clears.
	const activeConfig =
		configurations.find((c) => c.id === activeConfigurationId) ?? null;
	const activeModified =
		activeConfig != null &&
		!configurationsEqual(
			withAvailableLlmProvider(activeConfig.config, openrouterKey),
			draft,
		);
	const { triggerLevel } = usePopupSurfaceLevels({ selfElevate: false });
	// Nav arrows cycle prev/next between saved presets, so they need at least two
	// to do anything. With 0 or 1 preset there is nothing to cycle to — leaving
	// them enabled would let a click re-apply the lone preset and silently swap the
	// live provider/model (e.g. onto an OpenRouter cloud config).
	const navigationDisabled = disabled || configurations.length < 2;

	const items: CreatableComboboxItem[] = configurations.map((c) => ({
		id: c.id,
		label: c.name,
		icon: iconForPostProcessingProfileId(c.id),
		deletable: true,
		modified: activeModified && c.id === activeConfigurationId,
	}));

	const applyConfiguration = (id: string) => {
		const cfg = configurations.find((c) => c.id === id);
		if (!cfg) {
			return;
		}
		// Gate cloud providers behind their key so selecting / navigating to / or
		// resetting to an OpenRouter preset can't silently strand dictation on a
		// keyless cloud provider — it falls back to local instead.
		update(
			postProcessingPatchFromConfiguration(
				withAvailableLlmProvider(cfg.config, openrouterKey),
			),
		);
		setActiveConfiguration(id);
	};

	const applyConfigurationAtOffset = (offset: -1 | 1) => {
		if (configurations.length < 2) {
			return;
		}
		const currentIndex = configurations.findIndex((c) => c.id === matchedId);
		const activeIndex = configurations.findIndex(
			(c) => c.id === activeConfigurationId,
		);
		const fallbackIndex = offset > 0 ? 0 : configurations.length - 1;
		const startIndex =
			currentIndex >= 0
				? currentIndex
				: activeIndex >= 0
					? activeIndex
					: offset > 0
						? -1
						: 0;
		const nextIndex =
			startIndex >= 0
				? (startIndex + offset + configurations.length) % configurations.length
				: fallbackIndex;
		const next = configurations[nextIndex];
		if (next) {
			applyConfiguration(next.id);
		}
	};

	const handleCreate = (rawName: string) => {
		const name = rawName.trim();
		if (name) {
			saveConfiguration(name, draft);
		}
	};

	const handleDelete = (id: string) => {
		removeConfiguration(id);
		if (activeConfigurationId === id) {
			setActiveConfiguration(null);
		}
	};

	// Overwrite the preset with the current live settings (clears the dirty state).
	const handleSaveActive = (id: string) => {
		updateConfiguration(id, draft);
	};

	// Revert the live settings back to the preset's saved state.
	const handleResetActive = (id: string) => {
		applyConfiguration(id);
	};

	// Each arrow carries the SAME filled surface as the middle combobox (fill +
	// elevation shadow via surfaceClasses at the same level), so the three read as
	// equally "poppy" segments of one bar instead of flat/disabled-looking cutouts.
	// Hover lifts one surface level; hairline dividers separate the segments.
	const navButtonBase = cn(
		"h-8 w-9 shrink-0 text-foreground-dim transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40",
		surfaceClasses(triggerLevel),
		surfaceHoverBg(Math.min(triggerLevel + 1, 8)),
	);

	return (
		<div
			aria-label="Post-processing preset navigation"
			className="flex min-w-0 items-center"
			role="group"
		>
			<Tooltip content="Previous preset">
				<Button
					aria-label="Previous preset"
					className={cn(
						navButtonBase,
						"rounded-l-lg border-divider-strong border-e",
					)}
					disabled={navigationDisabled}
					onClick={() => applyConfigurationAtOffset(-1)}
				>
					<HugeiconsIcon aria-hidden="true" icon={ArrowLeft01Icon} size={15} />
				</Button>
			</Tooltip>
			<CreatableCombobox
				className="w-64 min-w-0 max-w-[40vw]"
				createLabel={(name) => t("modifierPresetCreate", { name })}
				deleteAriaLabel={t("playgroundDeletePreset")}
				disabled={disabled}
				emptyLabel={t("modifierPresetEmpty")}
				hideSelectedCheck
				inputClassName="rounded-none focus-visible:ring-inset focus-visible:ring-offset-0"
				items={items}
				leadingReorderHandle
				onCreate={handleCreate}
				onDelete={handleDelete}
				onReorder={moveConfiguration}
				onReset={handleResetActive}
				onSave={handleSaveActive}
				onSelect={applyConfiguration}
				placeholder={t("modifierPresetPlaceholder")}
				reorderAriaLabel={(item) => `Drag ${item.label} to reorder`}
				resetAriaLabel="Reset to saved settings"
				saveAriaLabel="Overwrite preset with current settings"
				value={matchedId}
			/>
			<Tooltip content="Next preset">
				<Button
					aria-label="Next preset"
					className={cn(
						navButtonBase,
						"rounded-r-lg border-divider-strong border-s",
					)}
					disabled={navigationDisabled}
					onClick={() => applyConfigurationAtOffset(1)}
				>
					<HugeiconsIcon aria-hidden="true" icon={ArrowRight01Icon} size={15} />
				</Button>
			</Tooltip>
		</div>
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
		<div className="flex flex-col divide-y divide-divider">
			<div>
				<FormControl
					label={t("tone")}
					labelTrailing={configControl}
					tooltip={t("toneTooltip")}
				>
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
				</FormControl>
			</div>
			<div>
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
