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

export const DEFAULT_FEATURE: LlmFeatureDraft = {
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

export const DEFAULT_PRESET_CARRIER: PresetCarrier = {
	presets: [{ key: "neutral" }],
	customModifiers: [],
};

export const DEFAULT_LLM: LlmDraftSnapshot = {
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

export const LEVEL_LABEL_KEY = {
	light: "levelLight",
	medium: "levelMedium",
	high: "levelHigh",
} as const satisfies Record<PresetLevel, string>;

export const DEFAULT_LEVEL: PresetLevel = "medium";

export function readFeatureSnapshot(
	incoming: Partial<LlmFeatureDraft> | null | undefined
): LlmFeatureDraft {
	return { ...DEFAULT_FEATURE, ...(incoming ?? {}) };
}

export function readPresetCarrier(
	incoming: Partial<PresetCarrier> | null | undefined
): PresetCarrier {
	const src = incoming ?? {};
	const presets =
		Array.isArray(src.presets) && src.presets.length > 0
			? (src.presets as readonly BuiltinPresetEntry[])
			: DEFAULT_PRESET_CARRIER.presets;
	const customModifiers = Array.isArray(src.customModifiers)
		? (src.customModifiers as readonly CustomModifier[])
		: DEFAULT_PRESET_CARRIER.customModifiers;
	return { presets, customModifiers };
}

export function readLlmSnapshot(llm: Partial<LlmSettings> | null | undefined): LlmDraftSnapshot {
	const incoming = llm ?? {};
	const dictationIn = (incoming.dictation ?? {}) as Partial<LlmDictation>;
	const transformsIn = (incoming.transforms ?? {}) as Partial<LlmTransforms>;
	const hotkey = typeof transformsIn.hotkey === "string" ? transformsIn.hotkey : "";
	return {
		endpoint: incoming.endpoint ?? DEFAULT_LLM.endpoint,
		openrouterApiKey: incoming.openrouterApiKey ?? DEFAULT_LLM.openrouterApiKey,
		dictation: { ...readFeatureSnapshot(dictationIn), ...readPresetCarrier(dictationIn) },
		transforms: {
			...readFeatureSnapshot(transformsIn),
			...readPresetCarrier(transformsIn),
			hotkey,
		},
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

export function getLevel(
	presets: readonly BuiltinPresetEntry[],
	key: (typeof INDEPENDENT_PRESETS)[number]
): PresetLevel {
	const entry = presets.find((p) => p.key === key);
	return entry?.level ?? DEFAULT_LEVEL;
}

export function setTone(
	presets: readonly BuiltinPresetEntry[],
	tone: (typeof TONE_GROUP)[number]
): BuiltinPresetEntry[] {
	const withoutTone = presets.filter((p) => !(TONE_GROUP as readonly string[]).includes(p.key));
	return [{ key: tone }, ...withoutTone];
}

export function makeIndependentEntry(
	key: (typeof INDEPENDENT_PRESETS)[number],
	levelOverride?: PresetLevel,
	targetLangOverride?: string
): BuiltinPresetEntry {
	if (key === "translate") {
		return { key, targetLang: targetLangOverride ?? DEFAULT_TARGET_LANG };
	}
	if ((PRESETS_WITH_LEVELS as readonly string[]).includes(key)) {
		return { key, level: levelOverride ?? DEFAULT_LEVEL };
	}
	return { key };
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

export function pickReplacementOllamaModel(
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

export function pickSmallestInstalledOllama(models: readonly OllamaModel[]): string | null {
	if (models.length === 0) {
		return null;
	}
	let smallest = models[0];
	if (!smallest) {
		return null;
	}
	for (const m of models) {
		if ((m.size ?? 0) < (smallest.size ?? 0)) {
			smallest = m;
		}
	}
	return smallest.name;
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

export async function tryEnableOllamaForFeature(deps: FeatureToggleDeps): Promise<void> {
	const reachable = await deps.checkOllamaReachable();
	if (!reachable) {
		deps.setShowOllamaDialog(true);
		return;
	}
	if (!deps.ollamaLoaded) {
		deps.scanOllama();
	}
	const currentValid =
		deps.currentOllamaModel.length > 0 &&
		deps.ollamaModels.some((m) => m.name === deps.currentOllamaModel);
	if (currentValid) {
		deps.apply({ enabled: true });
		return;
	}
	const smallest = pickSmallestInstalledOllama(deps.ollamaModels);
	if (smallest) {
		deps.apply({ model: smallest, enabled: true });
		return;
	}
	deps.setShowOllamaDialog(true);
}

export function tryEnableOpenRouterForFeature(deps: FeatureToggleDeps): void {
	if (!deps.openrouterApiKey) {
		deps.setShowApiKeyDialog(true);
		return;
	}
	if (!deps.openrouterLoaded) {
		deps.scanOpenRouter();
	}
	if (deps.currentOpenRouterModel.length > 0) {
		deps.apply({ enabled: true });
		return;
	}
	deps.apply({ openrouterModel: DEFAULT_OPENROUTER_MODEL, enabled: true });
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
