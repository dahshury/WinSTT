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
import { useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
	INDEPENDENT_PRESETS,
	PRESET_LEVELS,
	PRESETS_WITH_LEVELS,
	type PresetEntry,
	type PresetKey,
	type PresetLevel,
	TONE_GROUP,
	useLlmCatalogStore,
	useOpenRouterCatalogStore,
} from "@/entities/llm-catalog";
import { SettingSection, SettingSubsection, useSettingsStore } from "@/entities/setting";
import { detectOllama, fetchOllamaModels, startOllama } from "@/shared/api/ipc-client";
import type { AppSettingsOutput } from "@/shared/config/settings-schema";
import { Button } from "@/shared/ui/button";
import { FormControl } from "@/shared/ui/form-control";
import { Modal } from "@/shared/ui/modal";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import { Switcher } from "@/shared/ui/switcher";
import { TextField } from "@/shared/ui/text-field";
import { Toggle } from "@/shared/ui/toggle";
import {
	computeModelExclusionConfig,
	OpenRouterModelSelector,
} from "@/widgets/openrouter-model-selector";
import { ContextAwarenessSection } from "./ContextAwarenessSection";
import { TransformsSection } from "./TransformsSection";

export interface LlmOllamaManagerSlotProps {
	currentModel: string;
	isOpen: boolean;
	onClose: () => void;
	onModelInstalled: (model: string) => void;
}

export interface LlmSettingsPanelProps {
	renderOllamaManager?: (props: LlmOllamaManagerSlotProps) => ReactNode;
}

type TranslateFn = ReturnType<typeof useTranslations>;

interface OllamaModel {
	name: string;
	size?: number;
}

type LlmSettings = AppSettingsOutput["llm"];
type LlmPatch = Partial<LlmSettings>;
type UpdateLlmFn = (patch: LlmPatch) => void;
type LlmProvider = LlmSettings["provider"];

interface LlmDraftSnapshot {
	dictationEnabled: boolean;
	enabled: boolean;
	endpoint: string;
	model: string;
	openrouterApiKey: string;
	openrouterFallbackModel: string;
	openrouterModel: string;
	presets: readonly PresetEntry[];
	provider: LlmProvider;
	transformsEnabled: boolean;
}

const DEFAULT_LLM: LlmDraftSnapshot = {
	enabled: false,
	dictationEnabled: true,
	transformsEnabled: false,
	provider: "ollama",
	endpoint: "http://localhost:11434",
	model: "",
	presets: [{ key: "neutral" }],
	openrouterApiKey: "",
	openrouterModel: "",
	openrouterFallbackModel: "",
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

function readLlmSnapshot(llm: Partial<LlmSettings> | null | undefined): LlmDraftSnapshot {
	const incoming = llm ?? {};
	const presets =
		Array.isArray(incoming.presets) && incoming.presets.length > 0
			? (incoming.presets as readonly PresetEntry[])
			: DEFAULT_LLM.presets;
	return { ...DEFAULT_LLM, ...incoming, presets };
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
	enabled: boolean
): PresetEntry[] {
	if (!enabled) {
		return presets.filter((p) => p.key !== key);
	}
	if (presets.some((p) => p.key === key)) {
		return [...presets];
	}
	const entry: PresetEntry = (PRESETS_WITH_LEVELS as readonly string[]).includes(key)
		? { key, level: DEFAULT_LEVEL }
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

function buildOllamaModelOpts(
	models: readonly OllamaModel[]
): ReadonlyArray<{ id: string; label: string }> {
	return models.map((m) => ({
		id: m.name,
		label: `${m.name} (${((m.size ?? 0) / 1e9).toFixed(1)} GB)`,
	}));
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

interface ToggleDeps {
	checkOllamaReachable: () => Promise<boolean>;
	ollamaLoaded: boolean;
	openrouterApiKey: string;
	openrouterLoaded: boolean;
	provider: string;
	scanOllama: () => void;
	scanOpenRouter: () => void;
	setShowApiKeyDialog: (v: boolean) => void;
	setShowOllamaDialog: (v: boolean) => void;
	update: UpdateLlmFn;
}

async function tryEnableOllama(deps: ToggleDeps): Promise<void> {
	const reachable = await deps.checkOllamaReachable();
	if (!reachable) {
		deps.setShowOllamaDialog(true);
		return;
	}
	if (!deps.ollamaLoaded) {
		deps.scanOllama();
	}
	deps.update({ enabled: true });
}

function tryEnableOpenRouter(deps: ToggleDeps): void {
	if (!deps.openrouterApiKey) {
		deps.setShowApiKeyDialog(true);
		return;
	}
	if (!deps.openrouterLoaded) {
		deps.scanOpenRouter();
	}
	deps.update({ enabled: true });
}

async function performToggle(next: boolean, deps: ToggleDeps): Promise<void> {
	if (!next) {
		deps.update({ enabled: false });
		return;
	}
	if (deps.provider === "ollama") {
		await tryEnableOllama(deps);
		return;
	}
	tryEnableOpenRouter(deps);
}

interface OllamaSectionProps {
	enabled: boolean;
	endpoint: string;
	model: string;
	ollamaError: string | null;
	ollamaModelOpts: ReadonlyArray<{ id: string; label: string }>;
	ollamaReachable: boolean | null;
	ollamaScanning: boolean;
	openManager: () => void;
	scanOllama: () => void;
	t: TranslateFn;
	tc: TranslateFn;
	update: UpdateLlmFn;
}

function OllamaErrorBanner({ message }: { message: string | null }) {
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
		model,
		enabled,
		ollamaModelOpts,
		ollamaScanning,
		ollamaError,
		ollamaReachable,
		scanOllama,
		openManager,
		update,
	} = props;
	return (
		<>
			<FormControl
				caption={t("endpointCaption")}
				label={t("endpoint")}
				tooltip={t("endpointTooltip")}
			>
				<TextField
					onChange={(e) => update({ endpoint: e.target.value })}
					placeholder="http://localhost:11434"
					value={endpoint}
				/>
			</FormControl>

			<FormControl caption={t("modelCaption")} label={t("model")} tooltip={t("modelTooltip")}>
				<div className="flex gap-2">
					<div className="flex-1">
						<SearchableSelect
							disabled={ollamaScanning}
							onChange={(v) => update({ model: v })}
							options={ollamaModelOpts}
							placeholder={ollamaScanning ? tc("scanning") : t("selectModel")}
							value={model}
						/>
					</div>
					<Button
						className="h-8 rounded-md border border-border bg-surface-secondary px-3 font-medium text-body transition-colors duration-150 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
						disabled={ollamaScanning}
						onClick={scanOllama}
					>
						{ollamaScanning ? tc("scanning") : tc("refresh")}
					</Button>
					<Button
						className="h-8 rounded-md border border-accent bg-accent px-3 font-medium text-body text-white transition-colors duration-150 hover:bg-accent-dim"
						onClick={openManager}
					>
						{t("manageModels")}
					</Button>
				</div>
			</FormControl>

			<OllamaErrorBanner message={ollamaError} />
			<OllamaReachabilityWarning enabled={enabled} reachable={ollamaReachable} t={t} />
		</>
	);
}

interface OpenRouterSectionProps {
	fallbackExclusion: ReturnType<typeof computeModelExclusionConfig>;
	openrouterApiKey: string;
	openrouterError: string | null;
	openrouterFallbackModel: string;
	openrouterModel: string;
	openrouterModels: readonly unknown[] | undefined;
	openrouterScanning: boolean;
	scanOpenRouter: () => void;
	t: TranslateFn;
	tc: TranslateFn;
	update: UpdateLlmFn;
}

function OpenRouterErrorBanner({ message }: { message: string | null }) {
	if (!message) {
		return null;
	}
	return <div className="col-span-2 rounded bg-error/10 p-3 text-error text-sm">{message}</div>;
}

function OpenRouterSection(props: OpenRouterSectionProps) {
	const {
		t,
		tc,
		openrouterApiKey,
		openrouterModel,
		openrouterFallbackModel,
		openrouterModels,
		openrouterScanning,
		openrouterError,
		fallbackExclusion,
		scanOpenRouter,
		update,
	} = props;
	const apiKeyMissing = !openrouterApiKey;
	const refreshDisabled = openrouterScanning || apiKeyMissing;
	return (
		<>
			<div className="col-span-2">
				<FormControl
					caption={t("openrouterApiKeyCaption")}
					label={t("openrouterApiKey")}
					tooltip={t("openrouterApiKeyTooltip")}
				>
					<TextField
						onChange={(e) => update({ openrouterApiKey: e.target.value })}
						placeholder={t("openrouterApiKeyPlaceholder")}
						type="password"
						value={openrouterApiKey}
					/>
				</FormControl>
			</div>

			<div className="col-span-2">
				<FormControl
					caption={t("openrouterModelCaption")}
					label={t("openrouterModel")}
					tooltip={t("openrouterModelTooltip")}
				>
					<div className="flex gap-2">
						<div className="flex-1">
							<OpenRouterModelSelector
								disabled={apiKeyMissing}
								isLoading={openrouterScanning}
								models={openrouterModels as never}
								onChange={(v) => update({ openrouterModel: v })}
								value={openrouterModel}
							/>
						</div>
						<Button
							className="h-8 rounded-md border border-border bg-surface-secondary px-3 font-medium text-body transition-colors duration-150 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
							disabled={refreshDisabled}
							onClick={scanOpenRouter}
						>
							{openrouterScanning ? tc("scanning") : tc("refresh")}
						</Button>
					</div>
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
						onChange={(v) => update({ openrouterFallbackModel: v })}
						placeholder={t("openrouterFallbackModelPlaceholder")}
						value={openrouterFallbackModel}
					/>
				</FormControl>
			</div>

			<OpenRouterErrorBanner message={openrouterError} />
		</>
	);
}

interface IndependentPresetListProps {
	levelOpts: ReadonlyArray<{ value: PresetLevel; label: string }>;
	onLevelChange: (key: (typeof INDEPENDENT_PRESETS)[number], level: PresetLevel) => void;
	onToggle: (key: (typeof INDEPENDENT_PRESETS)[number], on: boolean) => void;
	presets: readonly PresetEntry[];
	t: TranslateFn;
}

function IndependentPresetList({
	levelOpts,
	onLevelChange,
	onToggle,
	presets,
	t,
}: IndependentPresetListProps) {
	return (
		<div className="flex flex-col gap-2">
			{INDEPENDENT_PRESETS.map((key) => {
				const checked = isIndependentEnabled(presets, key);
				const hasLevel = (PRESETS_WITH_LEVELS as readonly string[]).includes(key);
				const labelId = `llm-preset-${key}`;
				return (
					<div
						className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-surface-tertiary/40 px-3 py-2"
						key={key}
					>
						<div className="flex items-center gap-2">
							<HugeiconsIcon
								aria-hidden="true"
								className="shrink-0 text-foreground-dim"
								icon={INDEPENDENT_PRESET_ICONS[key]}
								size={16}
							/>
							<span className="font-medium text-body-sm" id={labelId}>
								{t(PRESET_LABEL_KEY[key])}
							</span>
						</div>
						<div className="flex items-center gap-3">
							{checked && hasLevel ? (
								<Switcher
									onChange={(v) => onLevelChange(key, v as PresetLevel)}
									options={levelOpts}
									value={getLevel(presets, key)}
								/>
							) : null}
							<Toggle
								aria-label={t(PRESET_LABEL_KEY[key])}
								checked={checked}
								onCheckedChange={(on) => onToggle(key, on)}
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
}

export function LlmSettingsPanel({ renderOllamaManager }: LlmSettingsPanelProps = {}) {
	const llm = useSettingsStore((s) => s.settings.llm);
	const update = useSettingsStore((s) => s.updateLlmSettings);
	const t = useTranslations("llm");
	const tc = useTranslations("common");

	const snapshot = readLlmSnapshot(llm);
	const {
		enabled,
		dictationEnabled,
		transformsEnabled,
		provider,
		endpoint,
		model,
		presets,
		openrouterApiKey,
		openrouterModel,
		openrouterFallbackModel,
	} = snapshot;

	const fallbackExclusion = computeModelExclusionConfig(openrouterModel);

	const {
		models: ollamaModels,
		isLoaded: ollamaLoaded,
		isScanning: ollamaScanning,
		error: ollamaError,
		scanModels: scanOllama,
	} = useLlmCatalogStore(
		useShallow((s) => ({
			models: s.models,
			isLoaded: s.isLoaded,
			isScanning: s.isScanning,
			error: s.error,
			scanModels: s.scanModels,
		}))
	);

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

	// Reachability hint shown inline when LLM is on but Ollama isn't responding.
	const [ollamaReachable, setOllamaReachable] = useState<boolean | null>(null);

	const checkOllamaReachable = useCallback(async () => {
		const result = await fetchOllamaModels();
		setOllamaReachable(result.reachable);
		return result.reachable;
	}, []);

	useEffect(() => {
		const isOllamaEnabled = enabled && provider === "ollama";
		if (isOllamaEnabled) {
			checkOllamaReachable().catch(() => undefined);
		}
	}, [enabled, provider, checkOllamaReachable]);

	useEffect(() => {
		const needsScan = provider === "ollama" && !ollamaLoaded;
		if (needsScan) {
			scanOllama();
		}
	}, [provider, ollamaLoaded, scanOllama]);

	useEffect(() => {
		if (shouldScanOpenRouter(provider, openrouterApiKey, openrouterLoaded)) {
			scanOpenRouter();
		}
	}, [provider, openrouterApiKey, openrouterLoaded, scanOpenRouter]);

	// After a scan, ensure llm.model points at an available Ollama model.
	useEffect(() => {
		const replacement = shouldSyncOllamaModel(provider, ollamaModels, model);
		if (replacement) {
			update({ model: replacement });
		}
	}, [provider, ollamaModels, model, update]);

	// Toggle gating
	const [showOllamaDialog, setShowOllamaDialog] = useState(false);
	const [showApiKeyDialog, setShowApiKeyDialog] = useState(false);
	const [showModelManager, setShowModelManager] = useState(false);

	const openModelManager = useCallback(() => setShowModelManager(true), []);
	const closeModelManager = useCallback(() => setShowModelManager(false), []);
	const handleModelInstalled = useCallback((name: string) => update({ model: name }), [update]);

	const handleToggle = useCallback(
		async (next: boolean) => {
			await performToggle(next, {
				provider,
				openrouterApiKey,
				ollamaLoaded,
				openrouterLoaded,
				checkOllamaReachable,
				scanOllama,
				scanOpenRouter,
				update,
				setShowOllamaDialog,
				setShowApiKeyDialog,
			});
		},
		[
			provider,
			openrouterApiKey,
			ollamaLoaded,
			openrouterLoaded,
			checkOllamaReachable,
			scanOllama,
			scanOpenRouter,
			update,
		]
	);

	const handleOllamaStarted = useCallback(() => {
		setShowOllamaDialog(false);
		scanOllama();
		update({ enabled: true });
	}, [scanOllama, update]);

	const handleApiKeySaved = useCallback(
		(key: string) => {
			update({ openrouterApiKey: key, enabled: true });
			setShowApiKeyDialog(false);
			scanOpenRouter();
		},
		[update, scanOpenRouter]
	);

	const ollamaModelOpts = buildOllamaModelOpts(ollamaModels as readonly OllamaModel[]);
	const toneOpts = buildToneOpts(t);
	const levelOpts = buildLevelOpts(t);
	const providerOpts = buildProviderOpts(t);
	const isOllamaProvider = provider === "ollama";
	const activeTone = getToneKey(presets);

	return (
		<>
			<SettingSection
				icon={AiBrain02Icon}
				onToggle={handleToggle}
				title={t("title")}
				toggled={enabled}
			>
				<div className="grid grid-cols-2 gap-x-5 gap-y-5 py-2">
					<div className="col-span-2">
						<FormControl
							caption={t("providerCaption")}
							label={t("provider")}
							tooltip={t("providerTooltip")}
						>
							<Switcher
								onChange={(v) => update({ provider: v })}
								options={providerOpts}
								value={provider}
							/>
						</FormControl>
					</div>

					{isOllamaProvider ? (
						<OllamaSection
							enabled={enabled}
							endpoint={endpoint}
							model={model}
							ollamaError={ollamaError}
							ollamaModelOpts={ollamaModelOpts}
							ollamaReachable={ollamaReachable}
							ollamaScanning={ollamaScanning}
							openManager={openModelManager}
							scanOllama={scanOllama}
							t={t}
							tc={tc}
							update={update}
						/>
					) : (
						<OpenRouterSection
							fallbackExclusion={fallbackExclusion}
							openrouterApiKey={openrouterApiKey}
							openrouterError={openrouterError}
							openrouterFallbackModel={openrouterFallbackModel}
							openrouterModel={openrouterModel}
							openrouterModels={openrouterModels as readonly unknown[]}
							openrouterScanning={openrouterScanning}
							scanOpenRouter={scanOpenRouter}
							t={t}
							tc={tc}
							update={update}
						/>
					)}
				</div>

				<SettingSubsection
					caption={t("subDictationCaption")}
					icon={PencilIcon}
					onToggle={(v) => update({ dictationEnabled: v })}
					title={t("subDictationTitle")}
					toggled={dictationEnabled}
				>
					<div className="grid grid-cols-2 gap-x-5 gap-y-5 py-2">
						<div className="col-span-2">
							<FormControl caption={t("toneCaption")} label={t("tone")} tooltip={t("toneTooltip")}>
								<Switcher
									onChange={(v) =>
										update({ presets: setTone(presets, v as (typeof TONE_GROUP)[number]) })
									}
									options={toneOpts}
									value={activeTone}
								/>
							</FormControl>
						</div>

						<div className="col-span-2">
							<FormControl
								caption={t("modifiersCaption")}
								label={t("modifiers")}
								tooltip={t("modifiersTooltip")}
							>
								<IndependentPresetList
									levelOpts={levelOpts}
									onLevelChange={(key, lvl) =>
										update({ presets: setIndependentLevel(presets, key, lvl) })
									}
									onToggle={(key, on) => update({ presets: toggleIndependent(presets, key, on) })}
									presets={presets}
									t={t}
								/>
							</FormControl>
						</div>

						<div className="col-span-2">
							<ContextAwarenessSection />
						</div>
					</div>
				</SettingSubsection>

				<SettingSubsection
					caption={t("transformsCaption")}
					icon={MagicWand01Icon}
					onToggle={(v) => update({ transformsEnabled: v })}
					title={t("subTransformTitle")}
					toggled={transformsEnabled}
				>
					<TransformsSection />
				</SettingSubsection>
			</SettingSection>

			<OllamaDialog
				isOpen={showOllamaDialog}
				onClose={() => setShowOllamaDialog(false)}
				onStarted={handleOllamaStarted}
				t={t}
				tc={tc}
			/>

			<ApiKeyDialog
				initialKey={openrouterApiKey}
				isOpen={showApiKeyDialog}
				onClose={() => setShowApiKeyDialog(false)}
				onSave={handleApiKeySaved}
				t={t}
				tc={tc}
			/>

			{renderOllamaManager?.({
				currentModel: model,
				isOpen: showModelManager,
				onClose: closeModelManager,
				onModelInstalled: handleModelInstalled,
			})}
		</>
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
				<TextField
					defaultValue={initialKey}
					key={isOpen ? "open" : "closed"}
					onChange={(e) => setHasValue(e.target.value.trim().length > 0)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							submit();
						}
					}}
					placeholder={t("openrouterApiKeyPlaceholder")}
					ref={inputRef}
					type="password"
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
	buildOllamaModelOpts,
	buildToneOpts,
	buildLevelOpts,
	buildProviderOpts,
	pickReplacementOllamaModel,
	shouldSyncOllamaModel,
	shouldScanOpenRouter,
	tryEnableOllama,
	tryEnableOpenRouter,
	performToggle,
	getOllamaDialogTexts,
	DEFAULT_LLM,
	getToneKey,
	isIndependentEnabled,
	getLevel,
	setTone,
	toggleIndependent,
	setIndependentLevel,
};
