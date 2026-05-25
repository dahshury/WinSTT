import {
	BookOpen01Icon,
	HappyIcon,
	PencilIcon,
	Suit01Icon,
	WavingHand01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { useTranslations } from "next-intl";
import {
	type BuiltinPresetEntry,
	type CustomModifier,
	type INDEPENDENT_PRESETS,
	PRESET_LEVELS,
	PRESETS_WITH_LEVELS,
	type PresetLevel,
	TONE_GROUP,
} from "@/entities/llm-catalog";
import type { OllamaModel } from "@/shared/api/models";
import type { AppSettingsOutput } from "@/shared/config/settings-schema";
import { DEFAULT_TARGET_LANG } from "@/shared/lib/languages";

type ToneKey = (typeof TONE_GROUP)[number];

const TONE_ICONS: Readonly<Record<ToneKey, IconSvgElement>> = {
	neutral: PencilIcon,
	formal: Suit01Icon,
	friendly: WavingHand01Icon,
	technical: BookOpen01Icon,
	casual: HappyIcon,
};

type TranslateFn = ReturnType<typeof useTranslations>;

type LlmSettings = AppSettingsOutput["llm"];
type LlmDictation = LlmSettings["dictation"];
type LlmTransforms = LlmSettings["transforms"];
type LlmProvider = LlmDictation["provider"];

type ReasoningEffort = "low" | "medium" | "high";
type Verbosity = "low" | "medium" | "high";
type OllamaThinkingEffort = "off" | "low" | "medium" | "high";

export interface LlmFeatureDraft {
	enabled: boolean;
	maxOutputTokens: number | null;
	model: string;
	openrouterFallbackModel: string;
	openrouterModel: string;
	provider: LlmProvider;
	reasoningEffort: ReasoningEffort;
	thinkingEffort: OllamaThinkingEffort;
	verbosity: Verbosity;
}

export interface PresetCarrier {
	customModifiers: readonly CustomModifier[];
	presets: readonly BuiltinPresetEntry[];
}

export interface LlmDraftSnapshot {
	dictation: LlmFeatureDraft & PresetCarrier;
	endpoint: string;
	openrouterApiKey: string;
	transforms: LlmFeatureDraft & PresetCarrier & { hotkey: string };
}

const DEFAULT_FEATURE: LlmFeatureDraft = {
	enabled: false,
	provider: "ollama",
	model: "",
	openrouterModel: "",
	openrouterFallbackModel: "",
	reasoningEffort: "medium",
	thinkingEffort: "medium",
	verbosity: "medium",
	maxOutputTokens: null,
};

const DEFAULT_PRESET_CARRIER: PresetCarrier = {
	presets: [{ key: "neutral" }],
	customModifiers: [],
};

const DEFAULT_LLM: LlmDraftSnapshot = {
	endpoint: "http://localhost:11434",
	openrouterApiKey: "",
	dictation: { ...DEFAULT_FEATURE, ...DEFAULT_PRESET_CARRIER },
	transforms: { ...DEFAULT_FEATURE, ...DEFAULT_PRESET_CARRIER, hotkey: "" },
};

export const PRESET_LABEL_KEY = {
	neutral: "presetNeutral",
	formal: "presetFormal",
	friendly: "presetFriendly",
	technical: "presetTechnical",
	casual: "presetCasual",
	concise: "presetConcise",
	summarize: "presetSummarize",
	reorder: "presetReorder",
	restructure: "presetRestructure",
	rewordForClarity: "presetRewordForClarity",
	translate: "presetTranslate",
} as const;

const LEVEL_LABEL_KEY = {
	light: "levelLight",
	medium: "levelMedium",
	high: "levelHigh",
} as const satisfies Record<PresetLevel, string>;

export const DEFAULT_LEVEL: PresetLevel = "medium";

function readFeatureSnapshot(
	incoming: Partial<LlmFeatureDraft> | null | undefined
): LlmFeatureDraft {
	return { ...DEFAULT_FEATURE, ...(incoming ?? {}) };
}

function isNonEmptyPresetList(value: unknown): value is readonly BuiltinPresetEntry[] {
	return Array.isArray(value) && value.length > 0;
}

function resolvePresets(src: Partial<PresetCarrier>): readonly BuiltinPresetEntry[] {
	return isNonEmptyPresetList(src.presets) ? src.presets : DEFAULT_PRESET_CARRIER.presets;
}

function resolveCustomModifiers(src: Partial<PresetCarrier>): readonly CustomModifier[] {
	return Array.isArray(src.customModifiers)
		? (src.customModifiers as readonly CustomModifier[])
		: DEFAULT_PRESET_CARRIER.customModifiers;
}

function readPresetCarrier(incoming: Partial<PresetCarrier> | null | undefined): PresetCarrier {
	const src = incoming ?? {};
	return {
		presets: resolvePresets(src),
		customModifiers: resolveCustomModifiers(src),
	};
}

function readHotkey(transformsIn: Partial<LlmTransforms>): string {
	return typeof transformsIn.hotkey === "string" ? transformsIn.hotkey : "";
}

function readDictationDraft(dictationIn: Partial<LlmDictation>): LlmFeatureDraft & PresetCarrier {
	return { ...readFeatureSnapshot(dictationIn), ...readPresetCarrier(dictationIn) };
}

function readTransformsDraft(
	transformsIn: Partial<LlmTransforms>
): LlmFeatureDraft & PresetCarrier & { hotkey: string } {
	return {
		...readFeatureSnapshot(transformsIn),
		...readPresetCarrier(transformsIn),
		hotkey: readHotkey(transformsIn),
	};
}

function readEndpoint(incoming: Partial<LlmSettings>): string {
	return incoming.endpoint ?? DEFAULT_LLM.endpoint;
}

function readOpenrouterApiKey(incoming: Partial<LlmSettings>): string {
	return incoming.openrouterApiKey ?? DEFAULT_LLM.openrouterApiKey;
}

function unwrapLlm(llm: Partial<LlmSettings> | null | undefined): Partial<LlmSettings> {
	return llm ?? {};
}

function unwrapDictation(incoming: Partial<LlmSettings>): Partial<LlmDictation> {
	return (incoming.dictation ?? {}) as Partial<LlmDictation>;
}

function unwrapTransforms(incoming: Partial<LlmSettings>): Partial<LlmTransforms> {
	return (incoming.transforms ?? {}) as Partial<LlmTransforms>;
}

export function readLlmSnapshot(llm: Partial<LlmSettings> | null | undefined): LlmDraftSnapshot {
	const incoming = unwrapLlm(llm);
	return {
		endpoint: readEndpoint(incoming),
		openrouterApiKey: readOpenrouterApiKey(incoming),
		dictation: readDictationDraft(unwrapDictation(incoming)),
		transforms: readTransformsDraft(unwrapTransforms(incoming)),
	};
}

export function getToneKey(presets: readonly BuiltinPresetEntry[]): (typeof TONE_GROUP)[number] {
	const tone = presets.find((p) => (TONE_GROUP as readonly string[]).includes(p.key));
	return (tone?.key as (typeof TONE_GROUP)[number]) ?? "neutral";
}

export function isIndependentEnabled(
	presets: readonly BuiltinPresetEntry[],
	key: (typeof INDEPENDENT_PRESETS)[number]
): boolean {
	return presets.some((p) => p.key === key);
}

function readEntryLevel(entry: BuiltinPresetEntry | undefined): PresetLevel {
	return entry?.level ?? DEFAULT_LEVEL;
}

export function getLevel(
	presets: readonly BuiltinPresetEntry[],
	key: (typeof INDEPENDENT_PRESETS)[number]
): PresetLevel {
	return readEntryLevel(presets.find((p) => p.key === key));
}

export function setTone(
	presets: readonly BuiltinPresetEntry[],
	tone: (typeof TONE_GROUP)[number]
): BuiltinPresetEntry[] {
	const withoutTone = presets.filter((p) => !(TONE_GROUP as readonly string[]).includes(p.key));
	return [{ key: tone }, ...withoutTone];
}

type IndependentKey = (typeof INDEPENDENT_PRESETS)[number];

type EntryShape = "translate" | "leveled" | "plain";

interface EntryOverrides {
	readonly level: PresetLevel | undefined;
	readonly targetLang: string | undefined;
}

type EntryBuilder = (key: IndependentKey, overrides: EntryOverrides) => BuiltinPresetEntry;

function buildTranslateEntry(key: IndependentKey, overrides: EntryOverrides): BuiltinPresetEntry {
	return { key, targetLang: overrides.targetLang ?? DEFAULT_TARGET_LANG };
}

function buildLeveledEntry(key: IndependentKey, overrides: EntryOverrides): BuiltinPresetEntry {
	return { key, level: overrides.level ?? DEFAULT_LEVEL };
}

function buildPlainEntry(key: IndependentKey): BuiltinPresetEntry {
	return { key };
}

const ENTRY_BUILDERS: Readonly<Record<EntryShape, EntryBuilder>> = {
	translate: buildTranslateEntry,
	leveled: buildLeveledEntry,
	plain: buildPlainEntry,
};

function isLeveledPreset(key: IndependentKey): boolean {
	return (PRESETS_WITH_LEVELS as readonly string[]).includes(key);
}

function leveledOrPlain(key: IndependentKey): EntryShape {
	return isLeveledPreset(key) ? "leveled" : "plain";
}

function entryShapeOf(key: IndependentKey): EntryShape {
	return key === "translate" ? "translate" : leveledOrPlain(key);
}

function makeIndependentEntry(
	key: IndependentKey,
	levelOverride?: PresetLevel,
	targetLangOverride?: string
): BuiltinPresetEntry {
	return ENTRY_BUILDERS[entryShapeOf(key)](key, {
		level: levelOverride,
		targetLang: targetLangOverride,
	});
}

export function toggleIndependent(
	presets: readonly BuiltinPresetEntry[],
	key: (typeof INDEPENDENT_PRESETS)[number],
	enabled: boolean,
	levelOverride?: PresetLevel,
	targetLangOverride?: string
): BuiltinPresetEntry[] {
	if (!enabled) {
		return presets.filter((p) => p.key !== key);
	}
	if (presets.some((p) => p.key === key)) {
		return [...presets];
	}
	return [...presets, makeIndependentEntry(key, levelOverride, targetLangOverride)];
}

export function setIndependentLevel(
	presets: readonly BuiltinPresetEntry[],
	key: (typeof INDEPENDENT_PRESETS)[number],
	level: PresetLevel
): BuiltinPresetEntry[] {
	return presets.map((p) => (p.key === key ? { ...p, level } : p));
}

export function getTargetLang(presets: readonly BuiltinPresetEntry[]): string {
	const entry = presets.find((p) => p.key === "translate");
	return entry?.targetLang ?? DEFAULT_TARGET_LANG;
}

export function setIndependentTargetLang(
	presets: readonly BuiltinPresetEntry[],
	targetLang: string
): BuiltinPresetEntry[] {
	return presets.map((p) => (p.key === "translate" ? { ...p, targetLang } : p));
}

export function buildToneOpts(t: TranslateFn) {
	return TONE_GROUP.map((key) => ({
		value: key,
		label: t(PRESET_LABEL_KEY[key]),
		icon: TONE_ICONS[key],
	}));
}

export function buildLevelOpts(t: TranslateFn) {
	return PRESET_LEVELS.map((lvl) => ({
		value: lvl,
		label: t(LEVEL_LABEL_KEY[lvl]),
	}));
}

export function buildProviderOpts(t: TranslateFn) {
	return [
		{ value: "ollama", label: t("providerOllama") },
		{ value: "openrouter", label: t("providerOpenRouter") },
	] as const;
}

function findFirstDifferentModel(models: readonly OllamaModel[], current: string): string | null {
	const first = models[0]?.name;
	if (!first) {
		return null;
	}
	return first === current ? null : first;
}

function pickReplacementOllamaModel(
	models: readonly OllamaModel[],
	current: string
): string | null {
	if (!current) {
		return null;
	}
	const stillInstalled = models.some((m) => m.name === current);
	if (stillInstalled) {
		return null;
	}
	return findFirstDifferentModel(models, current);
}

export function shouldSyncOllamaModel(
	provider: string,
	models: readonly OllamaModel[],
	current: string
): string | null {
	if (provider !== "ollama") {
		return null;
	}
	return pickReplacementOllamaModel(models, current);
}

export function shouldScanOpenRouter(provider: string, apiKey: string, loaded: boolean): boolean {
	const isOpenRouter = provider === "openrouter";
	const hasKey = apiKey.length > 0;
	return isOpenRouter && hasKey && !loaded;
}

type ApplyFeaturePatch = (patch: Partial<LlmFeatureDraft>) => void;

export const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash-lite";

function modelSize(model: OllamaModel): number {
	return model.size ?? 0;
}

function smallerOf(a: OllamaModel, b: OllamaModel): OllamaModel {
	return modelSize(b) < modelSize(a) ? b : a;
}

function reduceToSmallest(models: readonly OllamaModel[]): OllamaModel | undefined {
	return models.reduce<OllamaModel | undefined>(
		(acc, current) => (acc === undefined ? current : smallerOf(acc, current)),
		undefined
	);
}

export function pickSmallestInstalledOllama(models: readonly OllamaModel[]): string | null {
	return reduceToSmallest(models)?.name ?? null;
}

export interface FeatureToggleDeps {
	apply: ApplyFeaturePatch;
	checkOllamaReachable: () => Promise<boolean>;
	currentOllamaModel: string;
	currentOpenRouterModel: string;
	ollamaLoaded: boolean;
	ollamaModels: readonly OllamaModel[];
	openrouterApiKey: string;
	openrouterLoaded: boolean;
	provider: LlmProvider;
	scanOllama: () => void;
	scanOpenRouter: () => void;
	setShowApiKeyDialog: (v: boolean) => void;
	setShowOllamaDialog: (v: boolean) => void;
}

function isCurrentOllamaModelInstalled(deps: FeatureToggleDeps): boolean {
	const installed = deps.ollamaModels.some((m) => m.name === deps.currentOllamaModel);
	return installed && deps.currentOllamaModel.length > 0;
}

function maybeScanOllama(deps: FeatureToggleDeps): void {
	if (!deps.ollamaLoaded) {
		deps.scanOllama();
	}
}

function applyOllamaModel(deps: FeatureToggleDeps, model: string): void {
	deps.apply({ model, enabled: true });
}

function applyReplacementOrShowDialog(deps: FeatureToggleDeps): void {
	const smallest = pickSmallestInstalledOllama(deps.ollamaModels);
	if (smallest === null) {
		deps.setShowOllamaDialog(true);
		return;
	}
	applyOllamaModel(deps, smallest);
}

function enableOllamaForExistingModel(deps: FeatureToggleDeps): void {
	deps.apply({ enabled: true });
}

function continueOllamaEnable(deps: FeatureToggleDeps): void {
	const paths: Readonly<Record<"keep" | "replace", (d: FeatureToggleDeps) => void>> = {
		keep: enableOllamaForExistingModel,
		replace: applyReplacementOrShowDialog,
	};
	paths[isCurrentOllamaModelInstalled(deps) ? "keep" : "replace"](deps);
}

function runReachableOllamaFlow(deps: FeatureToggleDeps): void {
	maybeScanOllama(deps);
	continueOllamaEnable(deps);
}

function showOllamaNotReachable(deps: FeatureToggleDeps): void {
	deps.setShowOllamaDialog(true);
}

async function tryEnableOllamaForFeature(deps: FeatureToggleDeps): Promise<void> {
	const reachable = await deps.checkOllamaReachable();
	const flows: Readonly<Record<"reachable" | "unreachable", (d: FeatureToggleDeps) => void>> = {
		reachable: runReachableOllamaFlow,
		unreachable: showOllamaNotReachable,
	};
	flows[reachable ? "reachable" : "unreachable"](deps);
}

function maybeScanOpenRouter(deps: FeatureToggleDeps): void {
	if (!deps.openrouterLoaded) {
		deps.scanOpenRouter();
	}
}

function enableOpenRouterWithExistingModel(deps: FeatureToggleDeps): void {
	deps.apply({ enabled: true });
}

function enableOpenRouterWithDefaultModel(deps: FeatureToggleDeps): void {
	deps.apply({ openrouterModel: DEFAULT_OPENROUTER_MODEL, enabled: true });
}

function hasOpenRouterModel(deps: FeatureToggleDeps): boolean {
	return deps.currentOpenRouterModel.length > 0;
}

function continueOpenRouterEnable(deps: FeatureToggleDeps): void {
	maybeScanOpenRouter(deps);
	const paths: Readonly<Record<"existing" | "default", (d: FeatureToggleDeps) => void>> = {
		existing: enableOpenRouterWithExistingModel,
		default: enableOpenRouterWithDefaultModel,
	};
	paths[hasOpenRouterModel(deps) ? "existing" : "default"](deps);
}

function showOpenRouterApiKeyDialog(deps: FeatureToggleDeps): void {
	deps.setShowApiKeyDialog(true);
}

function hasOpenRouterApiKey(deps: FeatureToggleDeps): boolean {
	return Boolean(deps.openrouterApiKey);
}

function tryEnableOpenRouterForFeature(deps: FeatureToggleDeps): void {
	const flows: Readonly<Record<"hasKey" | "noKey", (d: FeatureToggleDeps) => void>> = {
		hasKey: continueOpenRouterEnable,
		noKey: showOpenRouterApiKeyDialog,
	};
	flows[hasOpenRouterApiKey(deps) ? "hasKey" : "noKey"](deps);
}

export async function performFeatureToggle(next: boolean, deps: FeatureToggleDeps): Promise<void> {
	if (!next) {
		deps.apply({ enabled: false });
		return;
	}
	if (deps.provider === "ollama") {
		await tryEnableOllamaForFeature(deps);
		return;
	}
	tryEnableOpenRouterForFeature(deps);
}

export interface OllamaDialogTexts {
	description: string;
	title: string;
}

export function getOllamaDialogTexts(showRun: boolean, t: TranslateFn): OllamaDialogTexts {
	if (showRun) {
		return {
			title: t("ollamaNotRunning"),
			description: t("ollamaNotRunningDescription"),
		};
	}
	return {
		title: t("ollamaRequired"),
		description: t("ollamaRequiredDescription"),
	};
}

// Test-only exports — pure helpers extracted from the panel logic.
export const __llm_settings_panel_test_helpers__ = {
	readLlmSnapshot,
	readFeatureSnapshot,
	buildToneOpts,
	buildLevelOpts,
	buildProviderOpts,
	pickReplacementOllamaModel,
	pickSmallestInstalledOllama,
	shouldSyncOllamaModel,
	shouldScanOpenRouter,
	tryEnableOllamaForFeature,
	tryEnableOpenRouterForFeature,
	performFeatureToggle,
	getOllamaDialogTexts,
	DEFAULT_LLM,
	DEFAULT_FEATURE,
	DEFAULT_OPENROUTER_MODEL,
	getToneKey,
	isIndependentEnabled,
	getLevel,
	setTone,
	toggleIndependent,
	setIndependentLevel,
	getTargetLang,
	setIndependentTargetLang,
};
