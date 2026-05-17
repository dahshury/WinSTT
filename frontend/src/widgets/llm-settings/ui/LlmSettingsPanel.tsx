"use client";

import {
	AiBrain02Icon,
	ArrangeIcon,
	BookOpen01Icon,
	BrushIcon,
	HappyIcon,
	Layout01Icon,
	MagicWand01Icon,
	PencilIcon,
	StickyNote01Icon,
	Suit01Icon,
	WavingHand01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { computeModelExclusionConfig, OllamaModelSelector, OpenRouterModelSelector } from "@picker";
import { useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
	assessOllamaFit,
	INDEPENDENT_PRESETS,
	type PausedPullState,
	PRESET_LEVELS,
	PRESETS_WITH_LEVELS,
	type PresetEntry,
	type PresetKey,
	type PresetLevel,
	RECOMMENDED_OLLAMA_MODELS,
	TONE_GROUP,
	useLlmCatalogStore,
	useOllamaLibraryStore,
	useOpenRouterCatalogStore,
} from "@/entities/llm-catalog";
import { useModelStateStore } from "@/entities/model-catalog";
import { SettingSection, SettingSubsection, useSettingsStore } from "@/entities/setting";
import { useWarmupStatusFeed, useWarmupStatusStore } from "@/features/llm-warmup-status";
import { detectOllama, fetchOllamaModels, startOllama } from "@/shared/api/ipc-client";
import type { AppSettingsOutput } from "@/shared/config/settings-schema";
import { Button } from "@/shared/ui/button";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { Modal } from "@/shared/ui/modal";
import { Switcher } from "@/shared/ui/switcher";
import { PasswordField, TextField } from "@/shared/ui/text-field";
import { ContextAwarenessSection } from "./ContextAwarenessSection";
import { TransformsSection } from "./TransformsSection";
import { WarmupStatusBanner } from "./WarmupStatusBanner";

export type LlmSettingsPanelProps = Record<string, never>;

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

interface LlmFeatureDraft {
	enabled: boolean;
	maxOutputTokens: number | null;
	model: string;
	openrouterFallbackModel: string;
	openrouterModel: string;
	provider: LlmProvider;
	reasoningEffort: ReasoningEffort;
	verbosity: Verbosity;
}

interface LlmDraftSnapshot {
	dictation: LlmFeatureDraft & { presets: readonly PresetEntry[] };
	endpoint: string;
	openrouterApiKey: string;
	transforms: LlmFeatureDraft;
}

const DEFAULT_FEATURE: LlmFeatureDraft = {
	enabled: false,
	provider: "ollama",
	model: "",
	openrouterModel: "",
	openrouterFallbackModel: "",
	reasoningEffort: "medium",
	verbosity: "medium",
	maxOutputTokens: null,
};

const DEFAULT_LLM: LlmDraftSnapshot = {
	endpoint: "http://localhost:11434",
	openrouterApiKey: "",
	dictation: { ...DEFAULT_FEATURE, presets: [{ key: "neutral" }] },
	transforms: { ...DEFAULT_FEATURE },
};

type ToneKey = (typeof TONE_GROUP)[number];
type IndependentKey = (typeof INDEPENDENT_PRESETS)[number];

const TONE_ICONS: Readonly<Record<ToneKey, IconSvgElement>> = {
	neutral: PencilIcon,
	formal: Suit01Icon,
	friendly: WavingHand01Icon,
	technical: BookOpen01Icon,
	casual: HappyIcon,
};

const INDEPENDENT_PRESET_ICONS: Readonly<Record<IndependentKey, IconSvgElement>> = {
	summarize: StickyNote01Icon,
	concise: BrushIcon,
	reorder: ArrangeIcon,
	restructure: Layout01Icon,
	rewordForClarity: MagicWand01Icon,
};

const PRESET_LABEL_KEY = {
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
} as const satisfies Record<PresetKey, string>;

const LEVEL_LABEL_KEY = {
	light: "levelLight",
	medium: "levelMedium",
	high: "levelHigh",
} as const satisfies Record<PresetLevel, string>;

const DEFAULT_LEVEL: PresetLevel = "medium";

function readFeatureSnapshot(
	incoming: Partial<LlmFeatureDraft> | null | undefined
): LlmFeatureDraft {
	return { ...DEFAULT_FEATURE, ...(incoming ?? {}) };
}

function readLlmSnapshot(llm: Partial<LlmSettings> | null | undefined): LlmDraftSnapshot {
	const incoming = llm ?? {};
	const dictationIn = (incoming.dictation ?? {}) as Partial<LlmDictation>;
	const transformsIn = (incoming.transforms ?? {}) as Partial<LlmTransforms>;
	const presets =
		Array.isArray(dictationIn.presets) && dictationIn.presets.length > 0
			? (dictationIn.presets as readonly PresetEntry[])
			: DEFAULT_LLM.dictation.presets;
	return {
		endpoint: incoming.endpoint ?? DEFAULT_LLM.endpoint,
		openrouterApiKey: incoming.openrouterApiKey ?? DEFAULT_LLM.openrouterApiKey,
		dictation: { ...readFeatureSnapshot(dictationIn), presets },
		transforms: readFeatureSnapshot(transformsIn),
	};
}

function getToneKey(presets: readonly PresetEntry[]): (typeof TONE_GROUP)[number] {
	const tone = presets.find((p) => (TONE_GROUP as readonly string[]).includes(p.key));
	return (tone?.key as (typeof TONE_GROUP)[number]) ?? "neutral";
}

function isIndependentEnabled(
	presets: readonly PresetEntry[],
	key: (typeof INDEPENDENT_PRESETS)[number]
): boolean {
	return presets.some((p) => p.key === key);
}

function getLevel(
	presets: readonly PresetEntry[],
	key: (typeof INDEPENDENT_PRESETS)[number]
): PresetLevel {
	const entry = presets.find((p) => p.key === key);
	return entry?.level ?? DEFAULT_LEVEL;
}

function setTone(
	presets: readonly PresetEntry[],
	tone: (typeof TONE_GROUP)[number]
): PresetEntry[] {
	const withoutTone = presets.filter((p) => !(TONE_GROUP as readonly string[]).includes(p.key));
	return [{ key: tone }, ...withoutTone];
}

function toggleIndependent(
	presets: readonly PresetEntry[],
	key: (typeof INDEPENDENT_PRESETS)[number],
	enabled: boolean,
	levelOverride?: PresetLevel
): PresetEntry[] {
	if (!enabled) {
		return presets.filter((p) => p.key !== key);
	}
	if (presets.some((p) => p.key === key)) {
		return [...presets];
	}
	const entry: PresetEntry = (PRESETS_WITH_LEVELS as readonly string[]).includes(key)
		? { key, level: levelOverride ?? DEFAULT_LEVEL }
		: { key };
	return [...presets, entry];
}

function setIndependentLevel(
	presets: readonly PresetEntry[],
	key: (typeof INDEPENDENT_PRESETS)[number],
	level: PresetLevel
): PresetEntry[] {
	return presets.map((p) => (p.key === key ? { ...p, level } : p));
}

function buildToneOpts(t: TranslateFn) {
	return TONE_GROUP.map((key) => ({
		value: key,
		label: t(PRESET_LABEL_KEY[key]),
		icon: TONE_ICONS[key],
	}));
}

function buildLevelOpts(t: TranslateFn) {
	return PRESET_LEVELS.map((lvl) => ({
		value: lvl,
		label: t(LEVEL_LABEL_KEY[lvl]),
	}));
}

function buildProviderOpts(t: TranslateFn) {
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
	const stillInstalled = models.some((m) => m.name === current);
	if (stillInstalled) {
		return null;
	}
	return findFirstDifferentModel(models, current);
}

function shouldSyncOllamaModel(
	provider: string,
	models: readonly OllamaModel[],
	current: string
): string | null {
	if (provider !== "ollama") {
		return null;
	}
	return pickReplacementOllamaModel(models, current);
}

function shouldScanOpenRouter(provider: string, apiKey: string, loaded: boolean): boolean {
	const isOpenRouter = provider === "openrouter";
	const hasKey = apiKey.length > 0;
	return isOpenRouter && hasKey && !loaded;
}

type SetFeatureEnabled = (value: boolean) => void;

interface FeatureToggleDeps {
	checkOllamaReachable: () => Promise<boolean>;
	ollamaLoaded: boolean;
	openrouterApiKey: string;
	openrouterLoaded: boolean;
	provider: LlmProvider;
	scanOllama: () => void;
	scanOpenRouter: () => void;
	setEnabled: SetFeatureEnabled;
	setShowApiKeyDialog: (v: boolean) => void;
	setShowOllamaDialog: (v: boolean) => void;
}

async function tryEnableOllamaForFeature(deps: FeatureToggleDeps): Promise<void> {
	const reachable = await deps.checkOllamaReachable();
	if (!reachable) {
		deps.setShowOllamaDialog(true);
		return;
	}
	if (!deps.ollamaLoaded) {
		deps.scanOllama();
	}
	deps.setEnabled(true);
}

function tryEnableOpenRouterForFeature(deps: FeatureToggleDeps): void {
	if (!deps.openrouterApiKey) {
		deps.setShowApiKeyDialog(true);
		return;
	}
	if (!deps.openrouterLoaded) {
		deps.scanOpenRouter();
	}
	deps.setEnabled(true);
}

async function performFeatureToggle(next: boolean, deps: FeatureToggleDeps): Promise<void> {
	if (!next) {
		deps.setEnabled(false);
		return;
	}
	if (deps.provider === "ollama") {
		await tryEnableOllamaForFeature(deps);
		return;
	}
	tryEnableOpenRouterForFeature(deps);
}

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

interface OllamaSectionProps {
	enabled: boolean;
	endpoint: string;
	librarySearch: import("@picker").OllamaModelSelectorProps["librarySearch"];
	model: string;
	ollamaError: string | null;
	ollamaModels: readonly OllamaModel[];
	ollamaReachable: boolean | null;
	ollamaScanning: boolean;
	pullBundle: OllamaPullBundle;
	scanOllama: () => void;
	setEndpoint: (endpoint: string) => void;
	setModel: (model: string) => void;
	t: TranslateFn;
	tc: TranslateFn;
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
		endpoint,
		librarySearch,
		model,
		enabled,
		ollamaModels,
		ollamaScanning,
		ollamaError,
		ollamaReachable,
		scanOllama,
		setEndpoint,
		setModel,
		pullBundle,
	} = props;
	return (
		<>
			<div className="col-span-2">
				<FormControl
					caption={t("endpointCaption")}
					label={t("endpoint")}
					tooltip={t("endpointTooltip")}
				>
					<ElevatedSurface inline>
						<TextField
							onChange={(e) => setEndpoint(e.target.value)}
							placeholder="http://localhost:11434"
							value={endpoint}
						/>
					</ElevatedSurface>
				</FormControl>
			</div>
			<FormControl caption={t("modelCaption")} label={t("model")} tooltip={t("modelTooltip")}>
				<OllamaModelSelector
					disabled={ollamaScanning}
					isLoading={ollamaScanning}
					librarySearch={librarySearch}
					models={ollamaModels}
					onChange={setModel}
					onDelete={(name) => {
						void pullBundle.deleteModel(name);
					}}
					onDiscardPull={pullBundle.discardPausedPull}
					onOpen={scanOllama}
					onPull={(name) => {
						void pullBundle.pullModel(name);
					}}
					onResumePull={(name) => {
						void pullBundle.resumePull(name);
					}}
					onStopPull={pullBundle.cancelPull}
					pausedPulls={pullBundle.pausedPulls}
					placeholder={ollamaScanning ? tc("scanning") : t("selectModel")}
					pulls={pullBundle.pulls}
					recommendedModels={RECOMMENDED_OLLAMA_MODELS}
					systemFit={pullBundle.getFit}
					value={model}
				/>
			</FormControl>

			<ErrorBanner message={ollamaError} />
			<OllamaReachabilityWarning enabled={enabled} reachable={ollamaReachable} t={t} />
		</>
	);
}

interface OpenRouterSectionProps {
	fallbackExclusion: ReturnType<typeof computeModelExclusionConfig>;
	maxOutputTokens: number | null;
	onApiKeyChange: (key: string) => void;
	onMaxOutputTokensChange: (value: number | null) => void;
	onReasoningEffortChange: (value: ReasoningEffort) => void;
	onVerbosityChange: (value: Verbosity) => void;
	openrouterApiKey: string;
	openrouterError: string | null;
	openrouterFallbackModel: string;
	openrouterModel: string;
	openrouterModels: readonly unknown[] | undefined;
	openrouterScanning: boolean;
	reasoningEffort: ReasoningEffort;
	scanOpenRouter: () => void;
	setFallbackModel: (model: string) => void;
	setModel: (model: string) => void;
	/**
	 * Whether this OpenRouterSection should render the shared API key input.
	 * The setting itself is shared between features; only the first feature
	 * using OpenRouter shows the field to avoid duplicating it.
	 */
	showApiKeyField: boolean;
	t: TranslateFn;
	tc: TranslateFn;
	verbosity: Verbosity;
}

function OpenRouterSection(props: OpenRouterSectionProps) {
	const {
		t,
		tc,
		maxOutputTokens,
		onApiKeyChange,
		onMaxOutputTokensChange,
		onReasoningEffortChange,
		onVerbosityChange,
		openrouterApiKey,
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
		showApiKeyField,
		verbosity,
	} = props;
	const apiKeyMissing = !openrouterApiKey;
	return (
		<>
			{showApiKeyField ? (
				<div className="col-span-2">
					<FormControl
						caption={t("openrouterApiKeyCaption")}
						label={t("openrouterApiKey")}
						tooltip={t("openrouterApiKeyTooltip")}
					>
						<ElevatedSurface inline>
							<PasswordField
								hideLabel={tc("hidePassword")}
								onChange={(e) => onApiKeyChange(e.target.value)}
								placeholder={t("openrouterApiKeyPlaceholder")}
								revealLabel={tc("showPassword")}
								value={openrouterApiKey}
							/>
						</ElevatedSurface>
					</FormControl>
				</div>
			) : null}

			<div className="col-span-2">
				<FormControl
					caption={t("openrouterModelCaption")}
					label={t("openrouterModel")}
					tooltip={t("openrouterModelTooltip")}
				>
					<OpenRouterModelSelector
						disabled={apiKeyMissing}
						isLoading={openrouterScanning}
						maxOutputTokens={maxOutputTokens}
						models={openrouterModels as never}
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
					caption={t("openrouterFallbackModelCaption")}
					label={t("openrouterFallbackModel")}
					tooltip={t("openrouterFallbackModelTooltip")}
				>
					<OpenRouterModelSelector
						disabled={apiKeyMissing}
						exclusionConfig={fallbackExclusion}
						fallback={true}
						isLoading={openrouterScanning}
						models={openrouterModels as never}
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
	levelOpts: ReadonlyArray<{ value: PresetLevel; label: string }>;
	onLevelChange: (key: (typeof INDEPENDENT_PRESETS)[number], level: PresetLevel) => void;
	onToggle: (key: (typeof INDEPENDENT_PRESETS)[number], on: boolean, level?: PresetLevel) => void;
	presets: readonly PresetEntry[];
	t: TranslateFn;
}

type IndependentKeyT = (typeof INDEPENDENT_PRESETS)[number];

/** Seed the local "last-known level" cache from whatever's persisted. */
function seedLevelCache(presets: readonly PresetEntry[]): Record<IndependentKeyT, PresetLevel> {
	const cache: Record<string, PresetLevel> = {};
	for (const key of INDEPENDENT_PRESETS) {
		const stored = presets.find((p) => p.key === key)?.level;
		cache[key] = stored ?? DEFAULT_LEVEL;
	}
	return cache as Record<IndependentKeyT, PresetLevel>;
}

function IndependentPresetList({
	levelOpts,
	onLevelChange,
	onToggle,
	presets,
	t,
}: IndependentPresetListProps) {
	// Remember each preset's last-known level locally so toggling off then on
	// restores the user's previous choice instead of snapping back to medium.
	// Initialized from whatever's persisted; updated whenever the user touches
	// the switcher OR the persisted level changes from underneath us.
	const [levelCache, setLevelCache] = useState<Record<IndependentKeyT, PresetLevel>>(() =>
		seedLevelCache(presets)
	);

	useEffect(() => {
		setLevelCache((prev) => {
			let changed = false;
			const next = { ...prev };
			for (const key of INDEPENDENT_PRESETS) {
				const stored = presets.find((p) => p.key === key)?.level;
				if (stored !== undefined && stored !== prev[key]) {
					next[key] = stored;
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [presets]);

	const checkedIndices = new Set<number>();
	INDEPENDENT_PRESETS.forEach((key, i) => {
		if (isIndependentEnabled(presets, key)) {
			checkedIndices.add(i);
		}
	});

	const disabledLevelOpts = levelOpts.map((opt) => ({ ...opt, disabled: true }));

	return (
		<CheckboxGroup checkedIndices={checkedIndices} className="w-full">
			{INDEPENDENT_PRESETS.map((key, i) => {
				const checked = isIndependentEnabled(presets, key);
				const hasLevel = (PRESETS_WITH_LEVELS as readonly string[]).includes(key);
				const displayedLevel = checked ? getLevel(presets, key) : levelCache[key];
				const handleLevel = (lvl: PresetLevel) => {
					setLevelCache((prev) => (prev[key] === lvl ? prev : { ...prev, [key]: lvl }));
					if (checked) {
						onLevelChange(key, lvl);
					}
				};
				return (
					<CheckboxItem
						checked={checked}
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
						onToggle={() => onToggle(key, !checked, levelCache[key])}
						trailing={
							hasLevel ? (
								<ElevatedSurface inline>
									<Switcher
										onChange={(v) => handleLevel(v as PresetLevel)}
										options={checked ? levelOpts : disabledLevelOpts}
										value={displayedLevel}
									/>
								</ElevatedSurface>
							) : null
						}
					/>
				);
			})}
		</CheckboxGroup>
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
	models: readonly unknown[];
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
	openrouterApiKey: string;
	openrouterCatalog: OpenRouterCatalogState;
	setShowApiKeyDialog: (v: boolean) => void;
	setShowOllamaDialog: (v: boolean) => void;
	/**
	 * True for the first feature whose provider is `openrouter`. That feature
	 * renders the shared `openrouterApiKey` input inline; the second one (if
	 * also using OpenRouter) does not, so we don't duplicate the field.
	 */
	showApiKeyField: boolean;
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
	return useCallback(
		async (next: boolean) => {
			await performFeatureToggle(next, {
				provider: props.featureSnapshot.provider,
				openrouterApiKey: props.openrouterApiKey,
				ollamaLoaded: props.ollamaCatalog.isLoaded,
				openrouterLoaded: props.openrouterCatalog.isLoaded,
				checkOllamaReachable,
				scanOllama: props.ollamaCatalog.scanModels,
				scanOpenRouter: props.openrouterCatalog.scanModels,
				setEnabled: (value) =>
					(props.update as (p: { enabled: boolean }) => void)({ enabled: value }),
				setShowOllamaDialog: props.setShowOllamaDialog,
				setShowApiKeyDialog: props.setShowApiKeyDialog,
			});
		},
		[props, checkOllamaReachable]
	);
}

export function LlmSettingsPanel() {
	const llm = useSettingsStore((s) => s.settings.llm);
	const updateShared = useSettingsStore((s) => s.updateLlmSettings);
	const updateDictation = useSettingsStore((s) => s.updateLlmDictation);
	const updateTransforms = useSettingsStore((s) => s.updateLlmTransforms);
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
			void ollamaCancelPull(name);
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
			void libraryState.loadCatalog();
		},
		fetchTags: (m) => {
			void libraryState.fetchTags(m);
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
	const [ollamaReachable, setOllamaReachable] = useState<boolean | null>(null);

	const checkOllamaReachable = useCallback(async () => {
		const result = await fetchOllamaModels();
		setOllamaReachable(result.reachable);
		return result.reachable;
	}, []);

	useEffect(() => {
		const anyOllamaEnabled =
			(dictation.enabled && dictation.provider === "ollama") ||
			(transforms.enabled && transforms.provider === "ollama");
		if (anyOllamaEnabled) {
			checkOllamaReachable().catch(() => undefined);
		}
	}, [
		dictation.enabled,
		dictation.provider,
		transforms.enabled,
		transforms.provider,
		checkOllamaReachable,
	]);

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

	const handleOllamaStarted = useCallback(() => {
		setShowOllamaDialog(false);
		scanOllama();
		if (pendingFeature === "dictation") {
			updateDictation({ enabled: true });
		} else if (pendingFeature === "transforms") {
			updateTransforms({ enabled: true });
		}
		setPendingFeature(null);
	}, [scanOllama, pendingFeature, updateDictation, updateTransforms]);

	const handleApiKeySaved = useCallback(
		(key: string) => {
			updateShared({ openrouterApiKey: key });
			setShowApiKeyDialog(false);
			scanOpenRouter();
			if (pendingFeature === "dictation") {
				updateDictation({ enabled: true });
			} else if (pendingFeature === "transforms") {
				updateTransforms({ enabled: true });
			}
			setPendingFeature(null);
		},
		[updateShared, scanOpenRouter, pendingFeature, updateDictation, updateTransforms]
	);

	const setShowOllamaDialogFor = useCallback(
		(feature: "dictation" | "transforms") => (v: boolean) => {
			setShowOllamaDialog(v);
			if (v) {
				setPendingFeature(feature);
			}
		},
		[]
	);
	const setShowApiKeyDialogFor = useCallback(
		(feature: "dictation" | "transforms") => (v: boolean) => {
			setShowApiKeyDialog(v);
			if (v) {
				setPendingFeature(feature);
			}
		},
		[]
	);

	const toneOpts = buildToneOpts(t);
	const levelOpts = buildLevelOpts(t);
	const providerOpts = buildProviderOpts(t);
	const activeTone = getToneKey(dictation.presets);

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
		models: openrouterModels as readonly unknown[],
		scanModels: scanOpenRouter,
	};

	// Pick the single feature that renders the shared API key input. We can't
	// render it twice (it's one setting) and we don't want to surface it at all
	// when neither feature uses OpenRouter — that's the whole point of gating.
	const apiKeyOwner: "dictation" | "transforms" | null =
		dictation.provider === "openrouter"
			? "dictation"
			: transforms.provider === "openrouter"
				? "transforms"
				: null;

	return (
		<>
			<SettingSection icon={AiBrain02Icon} title={t("title")}>
				{/* The OpenRouter API key lives inside the OpenRouter section
				    of whichever feature uses it; the Ollama endpoint URL now
				    lives inside each feature's OllamaSection (rendered under
				    the provider Switcher) so it appears in-context. */}
				<FeatureBlock
					checkOllamaReachable={checkOllamaReachable}
					endpoint={endpoint}
					feature="dictation"
					featureSnapshot={dictation}
					librarySearch={librarySearchProps}
					ollamaCatalog={ollamaCatalogState}
					ollamaPullBundle={ollamaPullBundle}
					ollamaReachable={ollamaReachable}
					openrouterApiKey={openrouterApiKey}
					openrouterCatalog={openrouterCatalogState}
					providerOpts={providerOpts}
					setShowApiKeyDialog={setShowApiKeyDialogFor("dictation")}
					setShowOllamaDialog={setShowOllamaDialogFor("dictation")}
					showApiKeyField={apiKeyOwner === "dictation"}
					t={t}
					tc={tc}
					update={updateDictation}
					updateShared={updateShared}
					warmupStatus={warmupStatus}
				>
					<div className="flex flex-col divide-y divide-surface-1">
						<div className="col-span-2">
							<FormControl caption={t("toneCaption")} label={t("tone")} tooltip={t("toneTooltip")}>
								<ElevatedSurface>
									<Switcher
										onChange={(v) =>
											updateDictation({
												presets: setTone(dictation.presets, v as (typeof TONE_GROUP)[number]),
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
								caption={t("modifiersCaption")}
								label={t("modifiers")}
								tooltip={t("modifiersTooltip")}
							>
								<ElevatedSurface>
									<IndependentPresetList
										levelOpts={levelOpts}
										onLevelChange={(key, lvl) =>
											updateDictation({
												presets: setIndependentLevel(dictation.presets, key, lvl),
											})
										}
										onToggle={(key, on, level) =>
											updateDictation({
												presets: toggleIndependent(dictation.presets, key, on, level),
											})
										}
										presets={dictation.presets}
										t={t}
									/>
								</ElevatedSurface>
							</FormControl>
						</div>
						<div className="col-span-2">
							<ContextAwarenessSection />
						</div>
					</div>
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
					setShowOllamaDialog={setShowOllamaDialogFor("transforms")}
					showApiKeyField={apiKeyOwner === "transforms"}
					t={t}
					tc={tc}
					update={updateTransforms}
					updateShared={updateShared}
					warmupStatus={warmupStatus}
				>
					<TransformsSection />
				</FeatureBlock>
			</SettingSection>

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

interface FeatureBlockComponentProps extends FeatureBlockProps {
	checkOllamaReachable: () => Promise<boolean>;
	children: ReactNode;
	providerOpts: ReadonlyArray<{ label: string; value: string }>;
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
		showApiKeyField,
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
			showApiKeyField,
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
	return (
		<SettingSubsection
			caption={isDictation ? t("subDictationCaption") : t("transformsCaption")}
			icon={isDictation ? PencilIcon : MagicWand01Icon}
			onToggle={handleToggle}
			title={isDictation ? t("subDictationTitle") : t("subTransformTitle")}
			toggled={featureSnapshot.enabled}
		>
			<div className="flex flex-col divide-y divide-surface-1">
				<div className="col-span-2">
					<FormControl
						caption={t("providerCaption")}
						label={t("provider")}
						tooltip={t("providerTooltip")}
					>
						<ElevatedSurface>
							<Switcher
								onChange={(v) => updateAny({ provider: v as LlmProvider })}
								options={providerOpts}
								value={featureSnapshot.provider}
							/>
						</ElevatedSurface>
					</FormControl>
				</div>
				{featureSnapshot.provider === "ollama" ? (
					<OllamaSection
						enabled={featureSnapshot.enabled}
						endpoint={endpoint}
						librarySearch={librarySearch}
						model={featureSnapshot.model}
						ollamaError={ollamaCatalog.error}
						ollamaModels={ollamaCatalog.models}
						ollamaReachable={ollamaReachable}
						ollamaScanning={ollamaCatalog.isScanning}
						pullBundle={ollamaPullBundle}
						scanOllama={ollamaCatalog.scanModels}
						setEndpoint={(v) => updateShared({ endpoint: v })}
						setModel={(v) => updateAny({ model: v })}
						t={t}
						tc={tc}
					/>
				) : (
					<OpenRouterSection
						fallbackExclusion={fallbackExclusion}
						maxOutputTokens={featureSnapshot.maxOutputTokens}
						onApiKeyChange={(key) => updateShared({ openrouterApiKey: key })}
						onMaxOutputTokensChange={(v) => updateAny({ maxOutputTokens: v })}
						onReasoningEffortChange={(v) => updateAny({ reasoningEffort: v })}
						onVerbosityChange={(v) => updateAny({ verbosity: v })}
						openrouterApiKey={openrouterApiKey}
						openrouterError={openrouterCatalog.error}
						openrouterFallbackModel={featureSnapshot.openrouterFallbackModel}
						openrouterModel={featureSnapshot.openrouterModel}
						openrouterModels={openrouterCatalog.models}
						openrouterScanning={openrouterCatalog.isScanning}
						reasoningEffort={featureSnapshot.reasoningEffort}
						scanOpenRouter={openrouterCatalog.scanModels}
						setFallbackModel={(v) => updateAny({ openrouterFallbackModel: v })}
						setModel={(v) => updateAny({ openrouterModel: v })}
						showApiKeyField={showApiKeyField}
						t={t}
						tc={tc}
						verbosity={featureSnapshot.verbosity}
					/>
				)}
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

interface OllamaDialogTexts {
	description: string;
	title: string;
}

function getOllamaDialogTexts(showRun: boolean, t: TranslateFn): OllamaDialogTexts {
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
						className="flex-1 rounded-md border border-border bg-surface-secondary px-4 py-2 font-medium transition-colors duration-150 hover:bg-surface-hover"
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
						className="rounded-md border border-border bg-surface-secondary px-4 py-2 font-medium transition-colors duration-150 hover:bg-surface-hover"
						onClick={openSignup}
					>
						{t("getApiKey")}
					</Button>
					<Button
						className="rounded-md border border-border bg-surface-secondary px-4 py-2 font-medium transition-colors duration-150 hover:bg-surface-hover"
						onClick={onClose}
					>
						{tc("cancel")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}

// Test-only exports — pure helpers extracted from the panel logic.
export const __llm_settings_panel_test_helpers__ = {
	readLlmSnapshot,
	readFeatureSnapshot,
	buildToneOpts,
	buildLevelOpts,
	buildProviderOpts,
	pickReplacementOllamaModel,
	shouldSyncOllamaModel,
	shouldScanOpenRouter,
	tryEnableOllamaForFeature,
	tryEnableOpenRouterForFeature,
	performFeatureToggle,
	getOllamaDialogTexts,
	DEFAULT_LLM,
	DEFAULT_FEATURE,
	getToneKey,
	isIndependentEnabled,
	getLevel,
	setTone,
	toggleIndependent,
	setIndependentLevel,
};
