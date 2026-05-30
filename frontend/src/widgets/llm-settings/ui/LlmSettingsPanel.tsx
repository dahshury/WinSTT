import {
	AiBrain02Icon,
	ArrangeIcon,
	BrushIcon,
	Cancel01Icon,
	Delete02Icon,
	LanguageSkillIcon,
	Layout01Icon,
	MagicWand01Icon,
	PencilIcon,
	PlayIcon,
	PlusSignIcon,
	StickyNote01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { computeModelExclusionConfig, OllamaModelSelector, OpenRouterModelSelector } from "@picker";
import { type ReactNode, useEffect, useReducer, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";
import {
	assessOllamaFit,
	type BuiltinPresetEntry,
	type CustomModifier,
	INDEPENDENT_PRESETS,
	type PausedPullState,
	PRESETS_WITH_LEVELS,
	type PresetLevel,
	RECOMMENDED_OLLAMA_MODELS,
	type TONE_GROUP,
	useLlmCatalogStore,
	useOllamaLibraryStore,
	useOpenRouterCatalogStore,
} from "@/entities/llm-catalog";
import {
	supportsTranslateToEnglish,
	useCatalogStore,
	useModelStateStore,
} from "@/entities/model-catalog";
import {
	SettingResetButton,
	SettingSection,
	SettingSubsection,
	useSettingsStore,
} from "@/entities/setting";
import { useLlmModelPickerStore } from "@/features/llm-model-picker";
import { HotkeyRecorder } from "@/features/record-hotkey";
import {
	detectOllama,
	fetchOllamaModels,
	type LlmPreviewConfig,
	runLlmPreview,
	startOllama,
} from "@/shared/api/ipc-client";
import type { OpenRouterModel } from "@/shared/api/models";
import type { AppSettingsOutput } from "@/shared/config/settings-schema";
import { detectAppleIntelligencePlatform } from "@/shared/lib/apple-intelligence-platform";
import { cn } from "@/shared/lib/cn";
import { findLanguage, LANGUAGES } from "@/shared/lib/languages";
import { SurfaceProvider, surfaceBg, useSurface } from "@/shared/lib/surface";
import { useMountEffect } from "@/shared/lib/use-mount-effect";
import { Button } from "@/shared/ui/button";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { IconButton } from "@/shared/ui/icon-button";
import { InfoTooltip } from "@/shared/ui/info-tooltip";
import { Modal } from "@/shared/ui/modal";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { Switcher } from "@/shared/ui/switcher";
import { PasswordField, TextField } from "@/shared/ui/text-field";
import { Toggle } from "@/shared/ui/toggle";
import { useWarmupStatusFeed } from "../api/use-warmup-status-feed";
import {
	buildLevelOpts,
	buildProviderOpts,
	buildToneOpts,
	DEFAULT_LEVEL,
	DEFAULT_OPENROUTER_MODEL,
	getLevel,
	getOllamaDialogTexts,
	getTargetLang,
	getToneKey,
	isIndependentEnabled,
	type LlmFeatureDraft,
	PRESET_LABEL_KEY,
	type PresetCarrier,
	performFeatureToggle,
	pickSmallestInstalledOllama,
	readLlmSnapshot,
	setIndependentLevel,
	setIndependentTargetLang,
	setTone,
	shouldScanOpenRouter,
	shouldSyncOllamaModel,
	toggleIndependent,
} from "../lib/llm-settings-panel-test-helpers";
import {
	clonePlaygroundConfig,
	loadPlaygroundPresets,
	makePlaygroundPresetId,
	type PlaygroundConfig,
	type PlaygroundPreset,
	savePlaygroundPresets,
} from "../model/playground-presets";
import { useWarmupStatusStore } from "../model/warmup-status-store";
import { CreatableCombobox, type CreatableComboboxItem } from "./CreatableCombobox";
import { Playground } from "./Playground";
import { WarmupStatusBanner } from "./WarmupStatusBanner";

type TranslateFn = ReturnType<typeof useTranslations>;

// Re-uses the spec-generated shape so `details.parameterSize` /
// `details.quantizationLevel` flow through to the picker.
type OllamaModel = import("@/shared/api/models").OllamaModel;

type LlmSettings = AppSettingsOutput["llm"];
type LlmDictation = LlmSettings["dictation"];
type LlmTransforms = LlmSettings["transforms"];
type LlmSharedPatch = Partial<Pick<LlmSettings, "endpoint" | "openrouterApiKey">>;
type LlmDictationPatch = Partial<LlmDictation>;
type LlmTransformsPatch = Partial<LlmTransforms>;
type UpdateSharedFn = (patch: LlmSharedPatch) => void;
type UpdateDictationFn = (patch: LlmDictationPatch) => void;
type UpdateTransformsFn = (patch: LlmTransformsPatch) => void;
type LlmProvider = LlmDictation["provider"];

type ReasoningEffort = "low" | "medium" | "high";
type Verbosity = "low" | "medium" | "high";

type IndependentKey = (typeof INDEPENDENT_PRESETS)[number];

const INDEPENDENT_PRESET_ICONS: Readonly<Record<IndependentKey, IconSvgElement>> = {
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
	label: l.englishName === l.nativeName ? l.englishName : `${l.englishName} — ${l.nativeName}`,
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
		id: `mod-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
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
	modifier: CustomModifier
): CustomModifier[] {
	return list.some((m) => m.id === modifier.id)
		? list.map((m) => (m.id === modifier.id ? modifier : m))
		: [...list, modifier];
}

function patchCustomModifier(
	list: readonly CustomModifier[],
	id: string,
	patch: Partial<CustomModifier>
): CustomModifier[] {
	return list.map((m) => (m.id === id ? { ...m, ...patch } : m));
}

function removeCustomModifier(list: readonly CustomModifier[], id: string): CustomModifier[] {
	return list.filter((m) => m.id !== id);
}

// Built-in independent presets + custom rows share one scrollable group;
// past this many total rows the group scrolls instead of growing the panel.
const MODIFIER_SCROLL_THRESHOLD = 7;

interface OllamaPullBundle {
	cancelPull: (name: string) => void;
	deleteModel: (name: string) => Promise<unknown>;
	discardPausedPull: (name: string) => void;
	getFit: (sizeBytes: number) => {
		availableBytes: number;
		fits: boolean;
		requiredBytes: number;
		shortfall: "vram" | "ram" | "unknown" | undefined;
	};
	pausedPulls: Readonly<Record<string, PausedPullState>>;
	pullModel: (name: string) => Promise<unknown>;
	pulls: Readonly<Record<string, import("@/shared/api/models").OllamaPullProgress>>;
	resumePull: (name: string) => Promise<unknown>;
}

type OllamaThinkingEffort = "off" | "low" | "medium" | "high";

interface OllamaSectionProps {
	enabled: boolean;
	librarySearch: import("@picker").OllamaModelSelectorProps["librarySearch"];
	model: string;
	ollamaError: string | null;
	ollamaModels: readonly OllamaModel[];
	ollamaReachable: boolean | null;
	ollamaScanning: boolean;
	pullBundle: OllamaPullBundle;
	scanOllama: () => void;
	setModel: (model: string) => void;
	setThinkingEffort: (value: OllamaThinkingEffort) => void;
	/** In-flight `from → to` for the trigger's switching view. Captured at
	 *  pick time in the parent and cleared when the warmup outcome lands. */
	swap: { fromName?: string | null; toName: string } | null;
	t: TranslateFn;
	tc: TranslateFn;
	thinkingEffort: OllamaThinkingEffort;
}

const OLLAMA_THINKING_EFFORT_OPTIONS: ReadonlyArray<{
	label: string;
	value: OllamaThinkingEffort;
}> = [
	{ value: "off", label: "Off" },
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
];

/** Four-segment radio toggle bound to the per-feature `thinkingEffort`
 *  setting. Mirrors the OpenRouter ReasoningEffortDropdown visually so
 *  the picker stays coherent, but exposes an extra "Off" option because
 *  Ollama's thinking-capable models support disabling thinking outright
 *  via `think: false` whereas OpenRouter's reasoning models are always
 *  reasoning. */
function OllamaThinkingEffortToggle({
	value,
	onChange,
}: {
	onChange: (value: OllamaThinkingEffort) => void;
	value: OllamaThinkingEffort;
}) {
	const activeBg = surfaceBg(Math.min(useSurface() + 1, 8));
	return (
		<div
			aria-label="Thinking effort"
			className="flex w-full min-w-0 max-w-full gap-1 rounded-md border border-border bg-surface-secondary/60 p-1 shadow-inner"
			role="radiogroup"
		>
			{OLLAMA_THINKING_EFFORT_OPTIONS.map((option) => {
				const isSelected = value === option.value;
				return (
					<label
						className={cn(
							"relative flex h-9 min-w-0 flex-1 cursor-pointer items-center justify-center truncate rounded-sm px-2 text-sm transition-[background-color,color,box-shadow] duration-200",
							isSelected
								? cn(activeBg, "font-semibold text-foreground shadow-md ring-1 ring-border")
								: "bg-transparent font-medium text-foreground-muted hover:bg-surface/60 hover:text-foreground"
						)}
						data-state={isSelected ? "selected" : "idle"}
						key={option.value}
					>
						<input
							aria-label={option.label}
							checked={isSelected}
							className="sr-only"
							name="ollama-thinking-effort"
							onChange={() => onChange(option.value)}
							type="radio"
							value={option.value}
						/>
						{option.label}
					</label>
				);
			})}
		</div>
	);
}

/** Shared error banner used by both Ollama and OpenRouter sections.
 *  Null-renders on empty message so callers can pass their error state
 *  through directly without an outer guard. */
function ErrorBanner({ message }: { message: string | null }) {
	if (!message) {
		return null;
	}
	return <div className="col-span-2 rounded bg-error/10 p-3 text-error text-sm">{message}</div>;
}

function OllamaReachabilityWarning({
	enabled,
	reachable,
	t,
}: {
	enabled: boolean;
	reachable: boolean | null;
	t: TranslateFn;
}) {
	const showWarning = enabled && reachable === false;
	if (!showWarning) {
		return null;
	}
	return (
		<div className="col-span-2 rounded bg-warning/10 p-3 text-sm text-warning">
			<div className="font-medium">{t("ollamaNotAvailable")}</div>
			<div className="mt-1">{t("ollamaNotAvailableDescription")}</div>
		</div>
	);
}

function OllamaSection(props: OllamaSectionProps) {
	const {
		t,
		tc,
		librarySearch,
		model,
		enabled,
		ollamaModels,
		ollamaScanning,
		ollamaError,
		ollamaReachable,
		scanOllama,
		setModel,
		setThinkingEffort,
		pullBundle,
		swap,
		thinkingEffort,
	} = props;
	const selectedModel = ollamaModels.find((m) => m.name === model);
	const supportsThinking = selectedModel?.capabilities?.includes("thinking") ?? false;
	return (
		<>
			<FormControl label={t("model")} tooltip={t("modelTooltip")}>
				<OllamaModelSelector
					disabled={ollamaScanning}
					isLoading={ollamaScanning}
					librarySearch={librarySearch}
					models={ollamaModels}
					onChange={setModel}
					onDelete={(name) => {
						pullBundle.deleteModel(name).catch(() => undefined);
					}}
					onDiscardPull={pullBundle.discardPausedPull}
					onOpen={scanOllama}
					onPull={(name) => {
						pullBundle.pullModel(name).catch(() => undefined);
					}}
					onResumePull={(name) => {
						pullBundle.resumePull(name).catch(() => undefined);
					}}
					onStopPull={pullBundle.cancelPull}
					pausedPulls={pullBundle.pausedPulls}
					placeholder={ollamaScanning ? tc("scanning") : t("selectModel")}
					pulls={pullBundle.pulls}
					recommendedModels={RECOMMENDED_OLLAMA_MODELS}
					swap={swap}
					systemFit={pullBundle.getFit}
					value={model}
				/>
			</FormControl>

			{supportsThinking ? (
				<FormControl
					label="Thinking effort"
					tooltip="Reasoning models can spend more or less time thinking before answering. Higher effort improves accuracy on hard inputs but adds latency. Off disables thinking entirely."
				>
					<OllamaThinkingEffortToggle onChange={setThinkingEffort} value={thinkingEffort} />
				</FormControl>
			) : null}

			<ErrorBanner message={ollamaError} />
			<OllamaReachabilityWarning enabled={enabled} reachable={ollamaReachable} t={t} />
		</>
	);
}

interface OpenRouterSectionProps {
	apiKeyMissing: boolean;
	fallbackExclusion: ReturnType<typeof computeModelExclusionConfig>;
	maxOutputTokens: number | null;
	onMaxOutputTokensChange: (value: number | null) => void;
	onReasoningEffortChange: (value: ReasoningEffort) => void;
	onVerbosityChange: (value: Verbosity) => void;
	openrouterError: string | null;
	openrouterFallbackModel: string;
	openrouterModel: string;
	openrouterModels: readonly OpenRouterModel[] | undefined;
	openrouterScanning: boolean;
	reasoningEffort: ReasoningEffort;
	scanOpenRouter: () => void;
	setFallbackModel: (model: string) => void;
	setModel: (model: string) => void;
	t: TranslateFn;
	verbosity: Verbosity;
}

function OpenRouterSection(props: OpenRouterSectionProps) {
	const {
		t,
		apiKeyMissing,
		maxOutputTokens,
		onMaxOutputTokensChange,
		onReasoningEffortChange,
		onVerbosityChange,
		openrouterModel,
		openrouterFallbackModel,
		openrouterModels,
		openrouterScanning,
		openrouterError,
		fallbackExclusion,
		reasoningEffort,
		scanOpenRouter,
		setFallbackModel,
		setModel,
		verbosity,
	} = props;
	return (
		<>
			<div className="col-span-2">
				<FormControl label={t("openrouterModel")} tooltip={t("openrouterModelTooltip")}>
					<OpenRouterModelSelector
						disabled={apiKeyMissing}
						isLoading={openrouterScanning}
						maxOutputTokens={maxOutputTokens}
						models={openrouterModels ? [...openrouterModels] : []}
						onChange={setModel}
						onMaxOutputTokensChange={onMaxOutputTokensChange}
						onOpen={scanOpenRouter}
						onReasoningEffortChange={onReasoningEffortChange}
						onVerbosityChange={onVerbosityChange}
						reasoningEffort={reasoningEffort}
						value={openrouterModel}
						verbosity={verbosity}
					/>
				</FormControl>
			</div>

			<div className="col-span-2">
				<FormControl
					label={t("openrouterFallbackModel")}
					tooltip={`${t("openrouterFallbackModelTooltip")} ${t("openrouterFallbackModelCaption")}`}
				>
					<OpenRouterModelSelector
						disabled={apiKeyMissing}
						exclusionConfig={fallbackExclusion}
						fallback={true}
						isLoading={openrouterScanning}
						models={openrouterModels ? [...openrouterModels] : []}
						onChange={setFallbackModel}
						onOpen={scanOpenRouter}
						placeholder={t("openrouterFallbackModelPlaceholder")}
						value={openrouterFallbackModel}
					/>
				</FormControl>
			</div>

			<ErrorBanner message={openrouterError} />
		</>
	);
}

interface IndependentPresetListProps {
	customModifiers: readonly CustomModifier[];
	levelOpts: ReadonlyArray<{ value: PresetLevel; label: string }>;
	onLevelChange: (key: (typeof INDEPENDENT_PRESETS)[number], level: PresetLevel) => void;
	onModifierLevelChange: (id: string, level: PresetLevel) => void;
	onModifierRemove: (id: string) => void;
	onModifierSave: (modifier: CustomModifier) => void;
	onModifierToggle: (id: string, enabled: boolean) => void;
	onTargetLangChange: (lang: string) => void;
	onToggle: (
		key: (typeof INDEPENDENT_PRESETS)[number],
		on: boolean,
		level?: PresetLevel,
		targetLang?: string
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
					className="shrink-0 text-foreground-dim"
					icon={AiBrain02Icon}
					size={16}
				/>
			}
			onToggle={() => onToggle(modifier.id, !modifier.enabled)}
			trailing={
				<div className="flex items-center gap-1">
					{modifier.levelsEnabled ? (
						<ElevatedSurface inline>
							<Switcher
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
function ModifierDialog({ isEdit, isOpen, modifier, onClose, onSave, t, tc }: ModifierDialogProps) {
	// Seeded once from the initial modifier prop; the parent remounts the
	// dialog with a fresh key when switching rows (Add vs Edit), so re-syncing
	// state from props inside a useEffect would be both redundant and a
	// no-derived-state / cascading-set-state pattern react-doctor flags.
	const [name, setName] = useState(modifier?.name ?? "");
	const [prompt, setPrompt] = useState(modifier?.prompt ?? "");
	const [levelsEnabled, setLevelsEnabled] = useState(modifier?.levelsEnabled ?? false);
	const buttonBg = surfaceBg(Math.min(useSurface() + 2, 8));

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
				<h2 className="font-semibold text-foreground text-lg">
					{isEdit ? t("modifierEditTitle") : t("modifierAddTitle")}
				</h2>
				<label className="flex flex-col gap-1.5" htmlFor="modifier-name-input">
					<span className="text-foreground-secondary text-sm">{t("modifierName")}</span>
					<TextField
						id="modifier-name-input"
						onChange={(e) => setName(e.target.value)}
						placeholder={t("modifierNamePlaceholder")}
						value={name}
					/>
				</label>
				<label className="flex flex-col gap-1.5" htmlFor="modifier-prompt-input">
					<span className="text-foreground-secondary text-sm">{t("modifierPrompt")}</span>
					<textarea
						aria-label={t("modifierPrompt")}
						className="min-h-[120px] w-full resize-y rounded-sm bg-surface-1 p-2.5 text-body text-foreground caret-accent outline-none placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1"
						id="modifier-prompt-input"
						onChange={(e) => setPrompt(e.target.value)}
						placeholder={t("modifierPromptPlaceholder")}
						value={prompt}
					/>
				</label>
				<div className="flex items-center justify-between gap-3">
					<div className="flex flex-col">
						<span className="text-foreground text-sm">{t("modifierLevels")}</span>
						<span className="text-foreground-muted text-xs">{t("modifierLevelsCaption")}</span>
					</div>
					<Toggle
						aria-label={t("modifierLevels")}
						checked={levelsEnabled}
						onCheckedChange={setLevelsEnabled}
					/>
				</div>
				<div className="flex gap-3">
					<Button
						className="flex-1 rounded-md border border-accent bg-accent px-4 py-2 font-medium text-white transition-colors duration-150 hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-60"
						disabled={!canSave}
						onClick={submit}
					>
						{t("modifierSave")}
					</Button>
					<Button
						className={cn(
							"rounded-md border border-border px-4 py-2 font-medium transition-colors duration-150 hover:bg-surface-hover",
							buttonBg
						)}
						onClick={onClose}
					>
						{tc("cancel")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}

type IndependentKeyT = (typeof INDEPENDENT_PRESETS)[number];

/** Index persisted presets by key once so per-key level lookups are O(1)
 *  instead of an O(n*m) `.find()` inside the preset loop. */
function indexPresetLevels(
	presets: readonly BuiltinPresetEntry[]
): Map<string, PresetLevel | undefined> {
	const byKey = new Map<string, PresetLevel | undefined>();
	for (const p of presets) {
		byKey.set(p.key, p.level);
	}
	return byKey;
}

/** Seed the local "last-known level" cache from whatever's persisted. */
function seedLevelCache(
	presets: readonly BuiltinPresetEntry[]
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
	const [dialogModifier, setDialogModifier] = useState<CustomModifier | null>(null);
	const isEditingExisting =
		dialogModifier !== null && customModifiers.some((m) => m.id === dialogModifier.id);

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
	const [levelCache, setLevelCache] = useState<Record<IndependentKeyT, PresetLevel>>(() =>
		seedLevelCache(presets)
	);

	// Same toggle-off-then-on memory as `levelCache`, but for the translate
	// row's target language (a single value — only one translate entry can
	// exist). Seeded once; updated via `handleLang` below.
	const [langCache, setLangCache] = useState<string>(() => getTargetLang(presets));

	const builtinCount = INDEPENDENT_PRESETS.length;
	const checkedIndices = new Set<number>();
	INDEPENDENT_PRESETS.forEach((key, i) => {
		if (isIndependentEnabled(presets, key) && !(key === "translate" && translateLocked)) {
			checkedIndices.add(i);
		}
	});
	customModifiers.forEach((m, i) => {
		if (m.enabled) {
			checkedIndices.add(builtinCount + i);
		}
	});

	const disabledLevelOpts = levelOpts.map((opt) => ({ ...opt, disabled: true }));
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
				const hasLevel = (PRESETS_WITH_LEVELS as readonly string[]).includes(key);
				const displayedLevel = checked ? getLevel(presets, key) : levelCache[key];
				const handleLevel = (lvl: PresetLevel) => {
					setLevelCache((prev) => (prev[key] === lvl ? prev : { ...prev, [key]: lvl }));
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
						<ElevatedSurface inline>
							<Switcher
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
								className="shrink-0 text-foreground-dim"
								icon={INDEPENDENT_PRESET_ICONS[key]}
								size={16}
							/>
						}
						onToggle={() =>
							onToggle(key, !checked, levelCache[key], isTranslate ? langCache : undefined)
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
			{scrollable ? <ScrollArea viewportClassName="max-h-[19rem]">{group}</ScrollArea> : group}
			<Button
				className="flex items-center gap-1 self-start rounded-md border border-border border-dashed bg-transparent px-3 py-1.5 text-foreground-muted text-sm transition-colors hover:border-accent hover:text-accent"
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

interface OllamaCatalogState {
	error: string | null;
	isLoaded: boolean;
	isScanning: boolean;
	models: readonly OllamaModel[];
	scanModels: () => void;
}

interface OpenRouterCatalogState {
	error: string | null;
	isLoaded: boolean;
	isScanning: boolean;
	models: readonly OpenRouterModel[];
	scanModels: () => void;
}

interface FeatureBlockProps {
	dictationLayout?: boolean;
	endpoint: string;
	feature: "dictation" | "transforms";
	featureSnapshot: LlmFeatureDraft;
	librarySearch: import("@picker").OllamaModelSelectorProps["librarySearch"];
	ollamaCatalog: OllamaCatalogState;
	ollamaPullBundle: OllamaPullBundle;
	ollamaReachable: boolean | null;
	/**
	 * Side effect fired when this feature gets enabled, after `update({enabled: true})`.
	 * Used to enforce the dictation ↔ Smart Endpoint mutual-exclusion invariant —
	 * passed in by the parent rather than read from the store here so that
	 * `useFeatureToggleHandler` stays a pure consumer of props.
	 */
	onEnabled?: () => void;
	openrouterApiKey: string;
	openrouterCatalog: OpenRouterCatalogState;
	setShowApiKeyDialog: (v: boolean) => void;
	/** Open the model-picker modal so the user can download a model when none
	 *  is installed — the toggle commits `enabled` only once a model lands. */
	setShowModelPicker: (v: boolean) => void;
	setShowOllamaDialog: (v: boolean) => void;
	t: TranslateFn;
	tc: TranslateFn;
	update: UpdateDictationFn | UpdateTransformsFn;
	updateShared: UpdateSharedFn;
	// Last broadcast from main process; null until first warmup pass.
	// Drives the inline warmup-failure banner so the user can see why
	// dictation didn't run without reading debug logs.
	warmupStatus: import("@/shared/api/ipc-client").LlmWarmupStatus | null;
}

// Toggle handler shared by both feature subsections — pulls together the
// per-feature preflight (Ollama reachability / OpenRouter API key) without
// touching the master switch (there is none anymore).
function useFeatureToggleHandler(
	props: FeatureBlockProps,
	checkOllamaReachable: () => Promise<boolean>
) {
	return async (next: boolean) => {
		await performFeatureToggle(next, {
			provider: props.featureSnapshot.provider,
			openrouterApiKey: props.openrouterApiKey,
			ollamaLoaded: props.ollamaCatalog.isLoaded,
			ollamaModels: props.ollamaCatalog.models,
			openrouterLoaded: props.openrouterCatalog.isLoaded,
			currentOllamaModel: props.featureSnapshot.model,
			currentOpenRouterModel: props.featureSnapshot.openrouterModel,
			checkOllamaReachable,
			scanOllama: props.ollamaCatalog.scanModels,
			scanOpenRouter: props.openrouterCatalog.scanModels,
			apply: (patch) => {
				(props.update as (p: Partial<LlmFeatureDraft>) => void)(patch);
				if (patch.enabled === true && props.onEnabled) {
					props.onEnabled();
				}
			},
			setShowOllamaDialog: props.setShowOllamaDialog,
			setShowApiKeyDialog: props.setShowApiKeyDialog,
			setShowModelPicker: props.setShowModelPicker,
		});
	};
}

/**
 * Owns every store subscription, derived snapshot, effect and handler the
 * panel needs. Extracted out of `LlmSettingsPanel` so the component stays a
 * thin composition root. Behavior is a verbatim move — React Compiler handles
 * memoization, so nothing is wrapped in `useMemo`/`useCallback`.
 */
function useLlmSettingsPanel() {
	const llm = useSettingsStore((s) => s.settings.llm);
	const updateShared = useSettingsStore((s) => s.updateLlmSettings);
	const updateDictation = useSettingsStore((s) => s.updateLlmDictation);
	const updateTransforms = useSettingsStore((s) => s.updateLlmTransforms);
	const updateQuality = useSettingsStore((s) => s.updateQualitySettings);

	// Mutual-exclusion with Smart Endpoint — enabling LLM dictation cleanup
	// must turn Smart Endpoint off. The reverse direction lives in
	// QualitySettingsPanel. Defined once so every dictation-enable path
	// (toggle, post-Ollama dialog, post-API-key dialog) goes through it.
	const disableSmartEndpoint = () => {
		updateQuality({ smartEndpoint: false });
	};
	const t = useTranslations("llm");
	const tc = useTranslations("common");

	// Subscribe to main-process warmup-status broadcasts so the per-feature
	// banners can surface "Ollama not running" / "model missing" / "model
	// failed to load" right next to the toggle that the user just enabled.
	useWarmupStatusFeed();
	const warmupStatus = useWarmupStatusStore((s) => s.status);

	const snapshot = readLlmSnapshot(llm);
	const { endpoint, openrouterApiKey, dictation, transforms } = snapshot;

	const usesOllama = dictation.provider === "ollama" || transforms.provider === "ollama";
	const usesOpenRouter =
		dictation.provider === "openrouter" || transforms.provider === "openrouter";

	const {
		models: ollamaModels,
		isLoaded: ollamaLoaded,
		isScanning: ollamaScanning,
		error: ollamaError,
		scanModels: scanOllama,
		pulls: ollamaPullsRaw,
		pausedPulls: ollamaPausedPulls,
		pullModel: ollamaPullModel,
		cancelPull: ollamaCancelPull,
		resumePull: ollamaResumePull,
		discardPausedPull: ollamaDiscardPausedPull,
		deleteModel: ollamaDeleteModel,
	} = useLlmCatalogStore(
		useShallow((s) => ({
			models: s.models,
			isLoaded: s.isLoaded,
			isScanning: s.isScanning,
			error: s.error,
			scanModels: s.scanModels,
			pulls: s.pulls,
			pausedPulls: s.pausedPulls,
			pullModel: s.pullModel,
			cancelPull: s.cancelPull,
			resumePull: s.resumePull,
			discardPausedPull: s.discardPausedPull,
			deleteModel: s.deleteModel,
		}))
	);

	// Flatten the store's `{ progress, startedAt }` shape down to plain
	// `{ [name]: OllamaPullProgress }` for the selector's `pulls` prop.
	const ollamaPulls: Record<string, import("@/shared/api/models").OllamaPullProgress> = {};
	for (const [name, state] of Object.entries(ollamaPullsRaw)) {
		ollamaPulls[name] = state.progress;
	}

	const systemInfo = useModelStateStore((s) => s.systemInfo);
	const getOllamaFit = (sizeBytes: number) => {
		const a = assessOllamaFit(sizeBytes, systemInfo);
		return {
			availableBytes: a.availableBytes,
			fits: a.fits,
			requiredBytes: a.requiredBytes,
			shortfall: a.shortfall,
		};
	};

	const ollamaPullBundle: OllamaPullBundle = {
		cancelPull: (name: string) => {
			ollamaCancelPull(name).catch(() => undefined);
		},
		deleteModel: ollamaDeleteModel,
		discardPausedPull: ollamaDiscardPausedPull,
		getFit: getOllamaFit,
		pausedPulls: ollamaPausedPulls,
		pullModel: ollamaPullModel,
		pulls: ollamaPulls,
		resumePull: ollamaResumePull,
	};

	const libraryState = useOllamaLibraryStore(
		useShallow((s) => ({
			catalog: s.catalog,
			error: s.error,
			isLoaded: s.isLoaded,
			isLoading: s.isLoading,
			tagsByModel: s.tagsByModel,
			loadCatalog: s.loadCatalog,
			fetchTags: s.fetchTags,
		}))
	);
	const librarySearchProps: import("@picker").OllamaModelSelectorProps["librarySearch"] = {
		catalog: libraryState.catalog,
		error: libraryState.error,
		isLoaded: libraryState.isLoaded,
		isLoading: libraryState.isLoading,
		tagsByModel: libraryState.tagsByModel,
		loadCatalog: () => {
			libraryState.loadCatalog().catch(() => undefined);
		},
		fetchTags: (m) => {
			libraryState.fetchTags(m).catch(() => undefined);
		},
	};

	const {
		models: openrouterModels,
		isLoaded: openrouterLoaded,
		isScanning: openrouterScanning,
		error: openrouterError,
		scanModels: scanOpenRouter,
	} = useOpenRouterCatalogStore(
		useShallow((s) => ({
			models: s.models,
			isLoaded: s.isLoaded,
			isScanning: s.isScanning,
			error: s.error,
			scanModels: s.scanModels,
		}))
	);

	// Reachability hint shown inline when any feature is on + uses Ollama.
	// This is synchronization with an external system (the Ollama daemon's
	// HTTP endpoint) — the value only exists because we asked the daemon,
	// and the setState below lives in the async resolution callback (not the
	// effect body), which is the pattern react-hooks-js/set-state-in-effect
	// explicitly allows. The toggle handlers also call `checkOllamaReachable`
	// imperatively when the user enables a feature, so the state needs to be
	// a proper React state — not a ref — for the inline banners to react.
	const [ollamaReachable, setOllamaReachable] = useState<boolean | null>(null);

	const checkOllamaReachable = async () => {
		const result = await fetchOllamaModels();
		setOllamaReachable(result.reachable);
		return result.reachable;
	};

	const anyOllamaEnabled =
		(dictation.enabled && dictation.provider === "ollama") ||
		(transforms.enabled && transforms.provider === "ollama");
	useEffect(() => {
		if (!anyOllamaEnabled) {
			return;
		}
		let cancelled = false;
		fetchOllamaModels()
			.then((result) => {
				if (!cancelled) {
					setOllamaReachable(result.reachable);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [anyOllamaEnabled]);

	useEffect(() => {
		if (usesOllama && !ollamaLoaded) {
			scanOllama();
		}
	}, [usesOllama, ollamaLoaded, scanOllama]);

	useEffect(() => {
		if (shouldScanOpenRouter("openrouter", openrouterApiKey, openrouterLoaded) && usesOpenRouter) {
			scanOpenRouter();
		}
	}, [usesOpenRouter, openrouterApiKey, openrouterLoaded, scanOpenRouter]);

	// After a scan, ensure each feature's Ollama model still exists.
	useEffect(() => {
		const replacement = shouldSyncOllamaModel(dictation.provider, ollamaModels, dictation.model);
		if (replacement) {
			updateDictation({ model: replacement });
		}
	}, [dictation.provider, dictation.model, ollamaModels, updateDictation]);

	useEffect(() => {
		const replacement = shouldSyncOllamaModel(transforms.provider, ollamaModels, transforms.model);
		if (replacement) {
			updateTransforms({ model: replacement });
		}
	}, [transforms.provider, transforms.model, ollamaModels, updateTransforms]);

	// Per-feature toggle gating: each feature's "turn on" flow may open one of
	// these dialogs (Ollama install/run, or OpenRouter API key entry) when the
	// chosen provider isn't yet configured. The model-manager dialog is opened
	// only from inside the Ollama section of whichever feature triggered it.
	const [showOllamaDialog, setShowOllamaDialog] = useState(false);
	const [showApiKeyDialog, setShowApiKeyDialog] = useState(false);
	// Tracks which feature initiated the OllamaDialog / ApiKeyDialog so the
	// dialog completion handler knows which feature to enable.
	const [pendingFeature, setPendingFeature] = useState<"dictation" | "transforms" | null>(null);

	// Build the same "enable with a resolved model" patch the toggle uses,
	// so the post-dialog enable path can't slip past the no-model guard.
	const resolveOllamaEnablePatch = (currentModel: string): Partial<LlmFeatureDraft> => {
		const currentValid =
			currentModel.length > 0 && ollamaModels.some((m) => m.name === currentModel);
		if (currentValid) {
			return { enabled: true };
		}
		const smallest = pickSmallestInstalledOllama(ollamaModels);
		if (smallest) {
			return { model: smallest, enabled: true };
		}
		// No installed models yet — leave the feature disabled. The user just
		// closed the Ollama dialog; the install/manage UI will surface the
		// next step (pull a model) and they can re-toggle once it's there.
		return {};
	};

	const resolveOpenRouterEnablePatch = (
		currentOpenRouterModel: string
	): Partial<LlmFeatureDraft> =>
		currentOpenRouterModel.length > 0
			? { enabled: true }
			: { openrouterModel: DEFAULT_OPENROUTER_MODEL, enabled: true };

	const handleOllamaStarted = () => {
		setShowOllamaDialog(false);
		scanOllama();
		if (pendingFeature === "dictation") {
			const patch = resolveOllamaEnablePatch(dictation.model);
			if (patch.enabled) {
				updateDictation(patch);
				disableSmartEndpoint();
			}
		} else if (pendingFeature === "transforms") {
			const patch = resolveOllamaEnablePatch(transforms.model);
			if (patch.enabled) {
				updateTransforms(patch);
			}
		}
		setPendingFeature(null);
	};

	const handleApiKeySaved = (key: string) => {
		updateShared({ openrouterApiKey: key });
		setShowApiKeyDialog(false);
		scanOpenRouter();
		if (pendingFeature === "dictation") {
			updateDictation(resolveOpenRouterEnablePatch(dictation.openrouterModel));
			disableSmartEndpoint();
		} else if (pendingFeature === "transforms") {
			updateTransforms(resolveOpenRouterEnablePatch(transforms.openrouterModel));
		}
		setPendingFeature(null);
	};

	const setShowOllamaDialogFor = (feature: "dictation" | "transforms") => (v: boolean) => {
		setShowOllamaDialog(v);
		if (v) {
			setPendingFeature(feature);
		}
	};
	const setShowApiKeyDialogFor = (feature: "dictation" | "transforms") => (v: boolean) => {
		setShowApiKeyDialog(v);
		if (v) {
			setPendingFeature(feature);
		}
	};
	// Open the model-picker modal (rendered at the SettingsPage view level, since
	// the dialog is a widget and widgets can't import widgets). Toggling a feature
	// on with no installed model routes here; the picker's install callback then
	// commits `enabled: true` — the toggle never enables on its own.
	const setShowModelPickerFor = (feature: "dictation" | "transforms") => (v: boolean) => {
		if (v) {
			useLlmModelPickerStore.getState().openFor(feature, true);
		} else {
			useLlmModelPickerStore.getState().close();
		}
	};

	const toneOpts = buildToneOpts(t);
	const levelOpts = buildLevelOpts(t);
	const applePlatform = detectAppleIntelligencePlatform();
	const providerOpts = buildProviderOpts(t, {
		appleIntelligenceSupported: applePlatform === "apple-silicon",
		appleIntelligenceUnavailableOnIntel: applePlatform === "intel-mac",
		openrouterNeedsKey: openrouterApiKey.trim().length === 0,
	});

	const ollamaCatalogState: OllamaCatalogState = {
		error: ollamaError,
		isLoaded: ollamaLoaded,
		isScanning: ollamaScanning,
		models: ollamaModels as readonly OllamaModel[],
		scanModels: scanOllama,
	};
	const openrouterCatalogState: OpenRouterCatalogState = {
		error: openrouterError,
		isLoaded: openrouterLoaded,
		isScanning: openrouterScanning,
		models: openrouterModels,
		scanModels: scanOpenRouter,
	};

	return {
		t,
		tc,
		endpoint,
		openrouterApiKey,
		dictation,
		transforms,
		warmupStatus,
		librarySearchProps,
		ollamaPullBundle,
		ollamaReachable,
		ollamaCatalogState,
		openrouterCatalogState,
		providerOpts,
		toneOpts,
		levelOpts,
		checkOllamaReachable,
		disableSmartEndpoint,
		updateShared,
		updateDictation,
		updateTransforms,
		setShowOllamaDialogFor,
		setShowApiKeyDialogFor,
		setShowModelPickerFor,
		showOllamaDialog,
		showApiKeyDialog,
		handleOllamaStarted,
		handleApiKeySaved,
		setShowOllamaDialog,
		setShowApiKeyDialog,
		setPendingFeature,
	};
}

type LlmSettingsPanelModel = ReturnType<typeof useLlmSettingsPanel>;

/**
 * Tone / modifiers controls, generic over the feature whose presets+modifiers
 * are being edited. Dictation gets context-awareness + deny-list appended;
 * transforms doesn't (the input IS the selected text, so window-capture
 * context has no role to play).
 */
// Mutable variants of the carrier fields — the helpers below return mutable
// arrays and the underlying updateLlmDictation / updateLlmTransforms expect
// the same. Read-side `PresetCarrier` keeps `readonly` so consumers don't
// accidentally mutate store state in place.
type PresetUpdate = Partial<{
	customModifiers: CustomModifier[];
	presets: BuiltinPresetEntry[];
}>;

function FeaturePresetControls({
	feature,
	model,
	snapshot,
	update,
}: {
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
	const sttTranslateOn = useSettingsStore((s) => s.settings.model?.translateToEnglish ?? false);
	const activeSttModelId = useSettingsStore((s) => s.settings.model?.model ?? "");
	const activeSttModel = useCatalogStore((s) => s.getModel(activeSttModelId));
	const translateLocked =
		feature === "dictation" &&
		sttTranslateOn &&
		activeSttModel !== undefined &&
		supportsTranslateToEnglish(activeSttModel);
	return (
		<div className="flex flex-col divide-y divide-surface-1">
			<div className="col-span-2">
				<FormControl label={t("tone")} tooltip={t("toneTooltip")}>
					<ElevatedSurface>
						<Switcher
							onChange={(v) =>
								update({
									presets: setTone(snapshot.presets, v as (typeof TONE_GROUP)[number]),
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
									customModifiers: patchCustomModifier(snapshot.customModifiers, id, { level }),
								})
							}
							onModifierRemove={(id) =>
								update({
									customModifiers: removeCustomModifier(snapshot.customModifiers, id),
								})
							}
							onModifierSave={(modifier) =>
								update({
									customModifiers: upsertCustomModifier(snapshot.customModifiers, modifier),
								})
							}
							onModifierToggle={(id, enabled) =>
								update({
									customModifiers: patchCustomModifier(snapshot.customModifiers, id, {
										enabled,
									}),
								})
							}
							onTargetLangChange={(lang) =>
								update({
									presets: setIndependentTargetLang(snapshot.presets, lang),
								})
							}
							onToggle={(key, on, level, targetLang) =>
								update({
									presets: toggleIndependent(snapshot.presets, key, on, level, targetLang),
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

/**
 * Single global hotkey that triggers the transforms pipeline on the current
 * selection. Empty disables; presence registers a uiohook combo. Dictation
 * has no equivalent — it fires from the PTT/recording hotkey via the relay.
 */
function TransformHotkeyField({
	hotkey,
	onChange,
	t,
}: {
	hotkey: string;
	onChange: (hotkey: string) => void;
	t: TranslateFn;
}) {
	return (
		<div className="py-2">
			<FormControl
				label={t("transformHotkey")}
				labelTrailing={
					<SettingResetButton isDefault={hotkey === ""} onReset={() => onChange("")} />
				}
				tooltip={`${t("transformHotkeyTooltip")} ${t("transformHotkeyCaption")}`}
			>
				<HotkeyRecorder currentKey={hotkey} onKeyRecorded={onChange} />
			</FormControl>
		</div>
	);
}

// ── Playground modal ──────────────────────────────────────────────────
//
// A single, detached LLM playground (one modal in the Model tab, not a
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

function seedDraftFromFeature(f: LlmFeatureDraft & PresetCarrier): PlaygroundConfig {
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

function initialPlaygroundSelection(model: LlmSettingsPanelModel): string {
	return model.dictation.enabled || !model.transforms.enabled ? LIVE_DICTATION : LIVE_TRANSFORMS;
}

/** Resolve the editable draft for the chosen combobox value — a live config or
 *  a clone of a saved preset. */
function seedForSelection(
	selection: string,
	model: LlmSettingsPanelModel,
	presets: readonly PlaygroundPreset[]
): PlaygroundConfig {
	if (selection === LIVE_TRANSFORMS) {
		return seedDraftFromFeature(model.transforms);
	}
	const preset = presets.find((p) => p.id === selection);
	if (preset) {
		return clonePlaygroundConfig(preset.config);
	}
	return seedDraftFromFeature(model.dictation);
}

/** Initial editable draft when the playground opens: the live config for the
 *  feature the user is most likely tuning. Mirrors the lazy `useState` seed for
 *  `selection` so both derive from `model` the same single-call way. */
function initialPlaygroundDraft(model: LlmSettingsPanelModel): PlaygroundConfig {
	return seedForSelection(initialPlaygroundSelection(model), model, []);
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
	draft: PlaygroundConfig;
	model: LlmSettingsPanelModel;
	onChange: (patch: Partial<PlaygroundConfig>) => void;
}) {
	const { t, tc, providerOpts, ollamaCatalogState, openrouterCatalogState, openrouterApiKey } =
		model;

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
function playgroundHasModel(draft: PlaygroundConfig, openrouterApiKey: string): boolean {
	if (draft.provider === "apple-intelligence") {
		return true;
	}
	if (draft.provider === "openrouter") {
		return openrouterApiKey.trim().length > 0 && draft.openrouterModel.length > 0;
	}
	return draft.model.length > 0;
}

/** Combobox items for the playground config selector: the two live configs
 *  (non-deletable) followed by the saved config presets (deletable). */
function buildConfigItems(
	presets: readonly PlaygroundPreset[],
	t: TranslateFn
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
	const [presets, setPresets] = useState<PlaygroundPreset[]>(loadPlaygroundPresets);
	const [selection, setSelection] = useState<string>(() => initialPlaygroundSelection(model));
	const [draft, setDraft] = useState<PlaygroundConfig>(() => initialPlaygroundDraft(model));

	const update = (patch: Partial<PlaygroundConfig>) => setDraft((prev) => ({ ...prev, ...patch }));

	const handleSelect = (next: string) => {
		setSelection(next);
		setDraft(seedForSelection(next, model, presets));
	};

	const handleCreatePreset = (rawName: string) => {
		const name = rawName.trim();
		if (!name) {
			return;
		}
		const preset: PlaygroundPreset = {
			id: makePlaygroundPresetId(),
			name,
			config: clonePlaygroundConfig(draft),
		};
		const next = [...presets, preset];
		setPresets(next);
		savePlaygroundPresets(next);
		setSelection(preset.id);
	};

	const deletePreset = (id: string) => {
		const next = presets.filter((p) => p.id !== id);
		setPresets(next);
		savePlaygroundPresets(next);
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
			thinkingEffort: draft.thinkingEffort,
			presets: draft.presets,
			customModifiers: draft.customModifiers,
		};
		return runLlmPreview(
			sample,
			selection === LIVE_TRANSFORMS ? "transforms" : "dictation",
			config
		);
	};

	return (
		<div className="flex w-[44rem] max-w-[94vw] flex-col">
			<header className="flex shrink-0 items-center gap-2 px-6 pt-6 pb-3">
				<HugeiconsIcon className="text-accent" icon={PlayIcon} size={18} />
				<h2 className="font-semibold text-foreground text-lg">{t("playgroundModalTitle")}</h2>
				<IconButton
					aria-label={tc("cancel")}
					className="ml-auto"
					icon={<HugeiconsIcon icon={Cancel01Icon} size={16} />}
					onClick={onClose}
				/>
			</header>
			{/* The viewport carries the max-height + overflow so the body scrolls
			    even though the popup is content-sized (a `flex-1` child of a
			    `max-h` popup never gets a definite height to scroll within). */}
			<ScrollArea viewportClassName="max-h-[76vh] px-6 pb-6">
				<div className="flex flex-col gap-4">
					<FormControl label={t("playgroundConfigLabel")} tooltip={t("playgroundConfigHint")}>
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
					<PlaygroundModelPicker draft={draft} model={model} onChange={update} />
					{/* Re-key on `selection` so the preset list's internal level/lang
					    caches reseed from the freshly-seeded draft on switch. */}
					<FeaturePresetControls
						feature="transforms"
						key={selection}
						model={model}
						snapshot={{ presets: draft.presets, customModifiers: draft.customModifiers }}
						update={update}
					/>
					<Playground disabled={runDisabled} disabledReason={disabledReason} run={run} />
				</div>
			</ScrollArea>
		</div>
	);
}

/** Detached LLM playground modal. The body is mounted only while open so each
 *  open re-seeds a fresh ephemeral draft from the current saved settings. */
function PlaygroundModal({
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

/** The two provider-setup dialogs (Ollama install/run, OpenRouter API key).
 *  Extracted so the panel root doesn't carry their wiring inline. */
function LlmSettingsDialogs({
	model,
}: {
	model: Pick<
		LlmSettingsPanelModel,
		| "t"
		| "tc"
		| "openrouterApiKey"
		| "showOllamaDialog"
		| "showApiKeyDialog"
		| "handleOllamaStarted"
		| "handleApiKeySaved"
		| "setShowOllamaDialog"
		| "setShowApiKeyDialog"
		| "setPendingFeature"
	>;
}) {
	const {
		t,
		tc,
		openrouterApiKey,
		showOllamaDialog,
		showApiKeyDialog,
		handleOllamaStarted,
		handleApiKeySaved,
		setShowOllamaDialog,
		setShowApiKeyDialog,
		setPendingFeature,
	} = model;
	return (
		<>
			<OllamaDialog
				isOpen={showOllamaDialog}
				onClose={() => {
					setShowOllamaDialog(false);
					setPendingFeature(null);
				}}
				onStarted={handleOllamaStarted}
				t={t}
				tc={tc}
			/>

			<ApiKeyDialog
				initialKey={openrouterApiKey}
				isOpen={showApiKeyDialog}
				onClose={() => {
					setShowApiKeyDialog(false);
					setPendingFeature(null);
				}}
				onSave={handleApiKeySaved}
				t={t}
				tc={tc}
			/>
		</>
	);
}

export function LlmSettingsPanel() {
	const model = useLlmSettingsPanel();
	const [playgroundOpen, setPlaygroundOpen] = useState(false);
	const {
		t,
		tc,
		endpoint,
		openrouterApiKey,
		dictation,
		transforms,
		warmupStatus,
		librarySearchProps,
		ollamaPullBundle,
		ollamaReachable,
		ollamaCatalogState,
		openrouterCatalogState,
		providerOpts,
		checkOllamaReachable,
		disableSmartEndpoint,
		updateShared,
		updateDictation,
		updateTransforms,
		setShowOllamaDialogFor,
		setShowApiKeyDialogFor,
		setShowModelPickerFor,
	} = model;

	return (
		<>
			<SettingSection
				headerAction={
					<Button
						className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 font-medium text-foreground-secondary text-sm transition-colors hover:border-accent hover:text-accent"
						onClick={() => setPlaygroundOpen(true)}
					>
						<HugeiconsIcon icon={PlayIcon} size={14} />
						{t("playgroundTitle")}
					</Button>
				}
				icon={AiBrain02Icon}
				title={t("title")}
			>
				{/* Provider connection inputs (Ollama endpoint, OpenRouter API
				    key) live in the dedicated Integrations settings tab — both
				    feature subsections read the same shared values. The shared,
				    detached Playground (header action above) replaces the old
				    per-feature inline playground blocks. */}
				<FeatureBlock
					checkOllamaReachable={checkOllamaReachable}
					endpoint={endpoint}
					feature="dictation"
					featureSnapshot={dictation}
					librarySearch={librarySearchProps}
					ollamaCatalog={ollamaCatalogState}
					ollamaPullBundle={ollamaPullBundle}
					ollamaReachable={ollamaReachable}
					onEnabled={disableSmartEndpoint}
					openrouterApiKey={openrouterApiKey}
					openrouterCatalog={openrouterCatalogState}
					providerOpts={providerOpts}
					setShowApiKeyDialog={setShowApiKeyDialogFor("dictation")}
					setShowModelPicker={setShowModelPickerFor("dictation")}
					setShowOllamaDialog={setShowOllamaDialogFor("dictation")}
					t={t}
					tc={tc}
					update={updateDictation}
					updateShared={updateShared}
					warmupStatus={warmupStatus}
				>
					<FeaturePresetControls
						feature="dictation"
						model={model}
						snapshot={dictation}
						update={updateDictation}
					/>
				</FeatureBlock>

				<FeatureBlock
					checkOllamaReachable={checkOllamaReachable}
					endpoint={endpoint}
					feature="transforms"
					featureSnapshot={transforms}
					librarySearch={librarySearchProps}
					ollamaCatalog={ollamaCatalogState}
					ollamaPullBundle={ollamaPullBundle}
					ollamaReachable={ollamaReachable}
					openrouterApiKey={openrouterApiKey}
					openrouterCatalog={openrouterCatalogState}
					providerOpts={providerOpts}
					setShowApiKeyDialog={setShowApiKeyDialogFor("transforms")}
					setShowModelPicker={setShowModelPickerFor("transforms")}
					setShowOllamaDialog={setShowOllamaDialogFor("transforms")}
					t={t}
					tc={tc}
					update={updateTransforms}
					updateShared={updateShared}
					warmupStatus={warmupStatus}
				>
					<FeaturePresetControls
						feature="transforms"
						model={model}
						snapshot={transforms}
						update={updateTransforms}
					/>
					<TransformHotkeyField
						hotkey={transforms.hotkey}
						onChange={(hotkey) => updateTransforms({ hotkey })}
						t={t}
					/>
				</FeatureBlock>
			</SettingSection>

			<LlmSettingsDialogs model={model} />
			{/* Reset the surface baseline low so the modal gets a settings-like
			    elevation ramp (popup → cards → inputs) with real contrast,
			    instead of clamping flat at surface-8 when opened from a deeply
			    nested settings substrate. */}
			<SurfaceProvider value={1}>
				<PlaygroundModal
					model={model}
					onClose={() => setPlaygroundOpen(false)}
					open={playgroundOpen}
				/>
			</SurfaceProvider>
		</>
	);
}

/** Tracks an in-flight Ollama model switch for a single feature
 *  (dictation/transforms). There's no IPC-driven "swap started/completed"
 *  pair for Ollama the way there is for the STT server — we synthesize the
 *  lifecycle from two side-effects of the user's pick:
 *
 *    1. Setting changes immediately and the debounced warmup loop fires for
 *       the new model.
 *    2. A fresh `LlmWarmupStatus` broadcast arrives whose `timestamp` is
 *       newer than the moment we captured at pick time and whose `models[]`
 *       includes our target.
 *
 *  Until that fresh status lands (or 60 s elapse, whichever first), the
 *  picker's trigger renders the same `from → ◌ → to` view the STT picker
 *  uses. Skipping the lifecycle entirely when the feature is disabled keeps
 *  the trigger calm during configuration — no warmup runs then.
 */
interface PendingOllamaSwap {
	fromName: string | null;
	startedAtTimestamp: number;
	toName: string;
}

/**
 * Pure resolver: given a pending swap intent (or none) and the latest warmup
 * broadcast, decide whether the picker should currently render the
 * "switching" view. Returning `null` means the swap has resolved (or never
 * started). Provider switch / feature disable / terminal-warmup-outcome all
 * fold into this function so we don't need an effect that watches
 * `warmupStatus` and `setState`s.
 */
function resolvePendingSwap(
	pending: PendingOllamaSwap | null,
	provider: LlmProvider,
	enabled: boolean,
	warmupStatus: import("@/shared/api/ipc-client").LlmWarmupStatus | null
): { fromName: string | null; toName: string } | null {
	if (!pending) {
		return null;
	}
	// Provider switched away or feature disabled → swap is moot.
	if (provider !== "ollama" || !enabled) {
		return null;
	}
	if (warmupStatus && warmupStatus.timestamp > pending.startedAtTimestamp) {
		// A warmup broadcast covers the target model with a TERMINAL outcome
		// (ok / unreachable / model-not-found / load-failed / skipped).
		// "loading" means the warmup pass just started — keep the spinner up
		// so the user sees continuous progress instead of a premature
		// dismissal followed by a delayed final result.
		const entry = warmupStatus.models.find((m) => m.model === pending.toName);
		if (entry && entry.outcome !== "loading") {
			return null;
		}
	}
	return { fromName: pending.fromName, toName: pending.toName };
}

/** Tracks an in-flight Ollama model switch for a single feature
 *  (dictation/transforms). There's no IPC-driven "swap started/completed"
 *  pair for Ollama the way there is for the STT server — we synthesize the
 *  lifecycle from two side-effects of the user's pick:
 *
 *    1. Setting changes immediately and the debounced warmup loop fires for
 *       the new model.
 *    2. A fresh `LlmWarmupStatus` broadcast arrives whose `timestamp` is
 *       newer than the moment we captured at pick time and whose `models[]`
 *       includes our target.
 *
 *  `pendingSwap` is set ONLY from the event handler (`beginSwap`); the
 *  derived `swap` is computed at render time from `warmupStatus` so we
 *  don't need an effect that watches the IPC broadcast and chains state
 *  updates. The 180 s safety-timeout effect clears `pendingSwap` after the
 *  deadline; that setState is in the timer's callback (not the effect
 *  body), which is the pattern set-state-in-effect explicitly allows.
 */
function useOllamaSwapTracker(opts: {
	currentModel: string;
	enabled: boolean;
	provider: LlmProvider;
	warmupStatus: import("@/shared/api/ipc-client").LlmWarmupStatus | null;
}): {
	beginSwap: (toName: string) => void;
	swap: { fromName: string | null; toName: string } | null;
} {
	const { currentModel, enabled, provider, warmupStatus } = opts;
	const [pendingSwap, setPendingSwap] = useState<PendingOllamaSwap | null>(null);

	const beginSwap = (toName: string) => {
		if (!(enabled && provider === "ollama")) {
			return;
		}
		if (!toName || toName === currentModel) {
			return;
		}
		setPendingSwap({
			fromName: currentModel || null,
			toName,
			startedAtTimestamp: warmupStatus?.timestamp ?? 0,
		});
	};

	// Safety: bound the switching display to 180 s even if no terminal
	// warmup outcome arrives. Big reasoning-model swaps on a single GPU
	// (evict 14B → load 7B) can legitimately take 60–120 s; the previous
	// 60 s ceiling pre-empted those legitimate loads.
	useEffect(() => {
		if (!pendingSwap) {
			return;
		}
		const id = window.setTimeout(() => setPendingSwap(null), 180_000);
		return () => window.clearTimeout(id);
	}, [pendingSwap]);

	return {
		swap: resolvePendingSwap(pendingSwap, provider, enabled, warmupStatus),
		beginSwap,
	};
}

/**
 * Apple Intelligence has no per-feature config — it's a single on-device
 * model with no endpoint, no API key, no model picker. Render a stub
 * panel explaining that and rely on the WarmupStatusBanner below to
 * surface availability/load failures (which the IPC layer reports via
 * the same channel as the other providers).
 */
function AppleIntelligenceSection({ t }: { t: TranslateFn }) {
	return (
		<div className="col-span-2 px-3 py-2 text-foreground-muted text-sm">
			<p>{t("appleIntelligenceDescription")}</p>
		</div>
	);
}

interface ProviderSectionArgs {
	beginOllamaSwap: (toName: string) => void;
	fallbackExclusion: ReturnType<typeof computeModelExclusionConfig>;
	featureSnapshot: LlmFeatureDraft;
	librarySearch: import("@picker").OllamaModelSelectorProps["librarySearch"];
	ollamaCatalog: OllamaCatalogState;
	ollamaPullBundle: OllamaPullBundle;
	ollamaReachable: boolean | null;
	ollamaSwap: { fromName: string | null; toName: string } | null;
	openrouterApiKey: string;
	openrouterCatalog: OpenRouterCatalogState;
	t: TranslateFn;
	tc: TranslateFn;
	updateAny: (p: Partial<LlmFeatureDraft>) => void;
}

function ProviderSection(args: ProviderSectionArgs) {
	const { featureSnapshot, t } = args;
	if (featureSnapshot.provider === "apple-intelligence") {
		return <AppleIntelligenceSection t={t} />;
	}
	if (featureSnapshot.provider === "ollama") {
		return (
			<OllamaSection
				enabled={featureSnapshot.enabled}
				librarySearch={args.librarySearch}
				model={featureSnapshot.model}
				ollamaError={args.ollamaCatalog.error}
				ollamaModels={args.ollamaCatalog.models}
				ollamaReachable={args.ollamaReachable}
				ollamaScanning={args.ollamaCatalog.isScanning}
				pullBundle={args.ollamaPullBundle}
				scanOllama={args.ollamaCatalog.scanModels}
				setModel={(v) => {
					args.beginOllamaSwap(v);
					args.updateAny({ model: v });
				}}
				setThinkingEffort={(v) => args.updateAny({ thinkingEffort: v })}
				swap={args.ollamaSwap}
				t={t}
				tc={args.tc}
				thinkingEffort={featureSnapshot.thinkingEffort ?? "medium"}
			/>
		);
	}
	return (
		<OpenRouterSection
			apiKeyMissing={!args.openrouterApiKey}
			fallbackExclusion={args.fallbackExclusion}
			maxOutputTokens={featureSnapshot.maxOutputTokens}
			onMaxOutputTokensChange={(v) => args.updateAny({ maxOutputTokens: v })}
			onReasoningEffortChange={(v) => args.updateAny({ reasoningEffort: v })}
			onVerbosityChange={(v) => args.updateAny({ verbosity: v })}
			openrouterError={args.openrouterCatalog.error}
			openrouterFallbackModel={featureSnapshot.openrouterFallbackModel}
			openrouterModel={featureSnapshot.openrouterModel}
			openrouterModels={args.openrouterCatalog.models}
			openrouterScanning={args.openrouterCatalog.isScanning}
			reasoningEffort={featureSnapshot.reasoningEffort}
			scanOpenRouter={args.openrouterCatalog.scanModels}
			setFallbackModel={(v) => args.updateAny({ openrouterFallbackModel: v })}
			setModel={(v) => args.updateAny({ openrouterModel: v })}
			t={t}
			verbosity={featureSnapshot.verbosity}
		/>
	);
}

interface FeatureBlockComponentProps extends FeatureBlockProps {
	checkOllamaReachable: () => Promise<boolean>;
	children: ReactNode;
	// Accept the richer ProviderOption shape (label, value, optional disabled
	// + disabledTooltip) so Apple Intelligence can render greyed-out on Intel
	// Macs. The Switcher ignores unknown fields, so older callers passing the
	// `{label, value}` minimum still work.
	providerOpts: ReadonlyArray<{
		disabled?: boolean;
		disabledTooltip?: string;
		label: string;
		value: string;
	}>;
}

function FeatureBlock(props: FeatureBlockComponentProps) {
	const {
		endpoint,
		feature,
		featureSnapshot,
		librarySearch,
		ollamaCatalog,
		ollamaPullBundle,
		openrouterCatalog,
		openrouterApiKey,
		ollamaReachable,
		providerOpts,
		setShowOllamaDialog,
		setShowApiKeyDialog,
		setShowModelPicker,
		checkOllamaReachable,
		update,
		updateShared,
		warmupStatus,
		t,
		tc,
		children,
	} = props;
	const handleToggle = useFeatureToggleHandler(
		{
			endpoint,
			feature,
			featureSnapshot,
			librarySearch,
			ollamaCatalog,
			ollamaPullBundle,
			openrouterCatalog,
			openrouterApiKey,
			ollamaReachable,
			setShowOllamaDialog,
			setShowApiKeyDialog,
			setShowModelPicker,
			update,
			updateShared,
			warmupStatus,
			t,
			tc,
		},
		checkOllamaReachable
	);
	const fallbackExclusion = computeModelExclusionConfig(featureSnapshot.openrouterModel);
	const updateAny = update as (p: Partial<LlmFeatureDraft>) => void;
	const isDictation = feature === "dictation";
	const { swap: ollamaSwap, beginSwap: beginOllamaSwap } = useOllamaSwapTracker({
		currentModel: featureSnapshot.model,
		enabled: featureSnapshot.enabled,
		provider: featureSnapshot.provider,
		warmupStatus,
	});
	return (
		<SettingSubsection
			caption={isDictation ? t("subDictationCaption") : t("subTransformCaption")}
			icon={isDictation ? PencilIcon : MagicWand01Icon}
			onToggle={handleToggle}
			title={isDictation ? t("subDictationTitle") : t("subTransformTitle")}
			toggled={featureSnapshot.enabled}
		>
			<div className="flex flex-col divide-y divide-surface-1">
				<div className="col-span-2">
					<FormControl label={t("provider")} tooltip={t("providerTooltip")}>
						<ElevatedSurface>
							<Switcher
								onChange={(v) => updateAny({ provider: v as LlmProvider })}
								options={providerOpts}
								value={featureSnapshot.provider}
							/>
						</ElevatedSurface>
					</FormControl>
				</div>
				<ProviderSection
					beginOllamaSwap={beginOllamaSwap}
					fallbackExclusion={fallbackExclusion}
					featureSnapshot={featureSnapshot}
					librarySearch={librarySearch}
					ollamaCatalog={ollamaCatalog}
					ollamaPullBundle={ollamaPullBundle}
					ollamaReachable={ollamaReachable}
					ollamaSwap={ollamaSwap}
					openrouterApiKey={openrouterApiKey}
					openrouterCatalog={openrouterCatalog}
					t={t}
					tc={tc}
					updateAny={updateAny}
				/>
				{featureSnapshot.enabled ? (
					<WarmupStatusBanner
						feature={feature}
						model={featureSnapshot.model}
						onRetry={checkOllamaReachable}
						provider={featureSnapshot.provider}
						status={warmupStatus}
					/>
				) : null}
			</div>
			{children}
		</SettingSubsection>
	);
}

interface DialogProps {
	t: ReturnType<typeof useTranslations>;
	tc: ReturnType<typeof useTranslations>;
}

interface OllamaDialogProps extends DialogProps {
	isOpen: boolean;
	onClose: () => void;
	onStarted: () => void;
}

function OllamaStartErrorBanner({ message }: { message: string | null }) {
	if (!message) {
		return null;
	}
	return <div className="rounded bg-error/10 p-2 text-error text-xs">{message}</div>;
}

interface OllamaPrimaryButtonProps {
	onDownload: () => void;
	onStart: () => void;
	showRun: boolean;
	starting: boolean;
	t: TranslateFn;
}

function OllamaPrimaryButton(props: OllamaPrimaryButtonProps) {
	const { showRun, starting, t, onStart, onDownload } = props;
	if (showRun) {
		return (
			<Button
				className="flex-1 rounded-md border border-accent bg-accent px-4 py-2 font-medium text-white transition-colors duration-150 hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-60"
				disabled={starting}
				onClick={onStart}
			>
				{starting ? t("starting") : t("runOllama")}
			</Button>
		);
	}
	return (
		<Button
			className="flex-1 rounded-md border border-accent bg-accent px-4 py-2 font-medium text-white transition-colors duration-150 hover:bg-accent-dim"
			onClick={onDownload}
		>
			{t("downloadOllama")}
		</Button>
	);
}

interface OllamaDialogState {
	installed: boolean | null;
	startError: string | null;
	starting: boolean;
}

type OllamaDialogAction =
	| { type: "reset-status" }
	| { type: "set-installed"; value: boolean | null }
	| { type: "start-attempt" }
	| { type: "start-failed"; error: string }
	| { type: "start-succeeded" };

function ollamaDialogReducer(
	state: OllamaDialogState,
	action: OllamaDialogAction
): OllamaDialogState {
	switch (action.type) {
		case "reset-status":
			return { ...state, startError: null, starting: false };
		case "set-installed":
			return { ...state, installed: action.value };
		case "start-attempt":
			return { ...state, starting: true, startError: null };
		case "start-failed":
			return { ...state, starting: false, startError: action.error };
		case "start-succeeded":
			return { ...state, starting: false };
		default:
			return state;
	}
}

const INITIAL_OLLAMA_DIALOG_STATE: OllamaDialogState = {
	installed: null,
	starting: false,
	startError: null,
};

function OllamaDialog({ t, tc, isOpen, onClose, onStarted }: OllamaDialogProps) {
	const [state, dispatch] = useReducer(ollamaDialogReducer, INITIAL_OLLAMA_DIALOG_STATE);
	const { installed, starting, startError } = state;
	const cancelBg = surfaceBg(Math.min(useSurface() + 2, 8));

	useEffect(() => {
		if (!isOpen) {
			return;
		}
		dispatch({ type: "reset-status" });
		let cancelled = false;
		(async () => {
			const result = await detectOllama();
			if (!cancelled) {
				dispatch({ type: "set-installed", value: result.installed });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [isOpen]);

	const openDownload = () => {
		window.open("https://ollama.com", "_blank");
		onClose();
	};

	const handleStart = async () => {
		dispatch({ type: "start-attempt" });
		const result = await startOllama();
		if (!result.started) {
			dispatch({ type: "start-failed", error: result.error ?? t("ollamaStartFailed") });
			return;
		}
		setTimeout(() => {
			dispatch({ type: "start-succeeded" });
			onStarted();
		}, 1500);
	};

	const showRun = installed === true;
	const { title, description } = getOllamaDialogTexts(showRun, t);

	return (
		<Modal isOpen={isOpen} onClose={onClose}>
			<div className="flex flex-col gap-4 p-6">
				<h2 className="font-semibold text-foreground text-lg">{title}</h2>
				<p className="text-foreground-secondary text-sm">{description}</p>
				<OllamaStartErrorBanner message={startError} />
				<div className="flex gap-3">
					<OllamaPrimaryButton
						onDownload={openDownload}
						onStart={handleStart}
						showRun={showRun}
						starting={starting}
						t={t}
					/>
					<Button
						className={cn(
							"flex-1 rounded-md border border-border px-4 py-2 font-medium transition-colors duration-150 hover:bg-surface-hover",
							cancelBg
						)}
						disabled={starting}
						onClick={onClose}
					>
						{tc("cancel")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}

interface ApiKeyDialogProps extends DialogProps {
	initialKey: string;
	isOpen: boolean;
	onClose: () => void;
	onSave: (key: string) => void;
}

function ApiKeyDialog({ t, tc, isOpen, onClose, onSave, initialKey }: ApiKeyDialogProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [hasValue, setHasValue] = useState(initialKey.trim().length > 0);
	const buttonBg = surfaceBg(Math.min(useSurface() + 2, 8));

	useEffect(() => {
		if (!isOpen) {
			return;
		}
		const id = window.setTimeout(() => inputRef.current?.focus(), 0);
		return () => window.clearTimeout(id);
	}, [isOpen]);

	const openSignup = () => window.open("https://openrouter.ai/keys", "_blank");
	const submit = () => {
		const trimmed = (inputRef.current?.value ?? "").trim();
		if (!trimmed) {
			return;
		}
		onSave(trimmed);
	};

	return (
		<Modal isOpen={isOpen} onClose={onClose}>
			<div className="flex flex-col gap-4 p-6">
				<h2 className="font-semibold text-foreground text-lg">{t("apiKeyRequired")}</h2>
				<p className="text-foreground-secondary text-sm">{t("apiKeyRequiredDescription")}</p>
				<PasswordField
					defaultValue={initialKey}
					hideLabel={tc("hidePassword")}
					key={isOpen ? "open" : "closed"}
					onChange={(e) => setHasValue(e.target.value.trim().length > 0)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							submit();
						}
					}}
					placeholder={t("openrouterApiKeyPlaceholder")}
					ref={inputRef}
					revealLabel={tc("showPassword")}
				/>
				<div className="flex gap-3">
					<Button
						className="flex-1 rounded-md border border-accent bg-accent px-4 py-2 font-medium text-white transition-colors duration-150 hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-60"
						disabled={!hasValue}
						onClick={submit}
					>
						{t("saveAndEnable")}
					</Button>
					<Button
						className={cn(
							"rounded-md border border-border px-4 py-2 font-medium transition-colors duration-150 hover:bg-surface-hover",
							buttonBg
						)}
						onClick={openSignup}
					>
						{t("getApiKey")}
					</Button>
					<Button
						className={cn(
							"rounded-md border border-border px-4 py-2 font-medium transition-colors duration-150 hover:bg-surface-hover",
							buttonBg
						)}
						onClick={onClose}
					>
						{tc("cancel")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}
