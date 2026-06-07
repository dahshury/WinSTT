import {
	BrainCircuitIcon,
	MagicWand01Icon,
	PencilIcon,
	PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { computeModelExclusionConfig } from "@picker";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";
import {
	assessOllamaFit,
	useLlmCatalogStore,
	useOllamaLibraryStore,
	useOpenRouterCatalogStore,
} from "@/entities/llm-catalog";
import { useModelStateStore } from "@/entities/model-catalog";
import {
	SettingSection,
	SettingSubsection,
	useSettingsStore,
} from "@/entities/setting";
import { useLlmModelPickerStore } from "@/features/llm-model-picker";
import { fetchOllamaModels } from "@/shared/api/ipc-client";
import { detectAppleIntelligencePlatform } from "@/shared/lib/apple-intelligence-platform";
import { Button } from "@/shared/ui/button";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { Switcher } from "@/shared/ui/switcher";
import { useWarmupStatusFeed } from "../api/use-warmup-status-feed";
import {
	buildLevelOpts,
	buildProviderOpts,
	buildToneOpts,
	DEFAULT_OPENROUTER_MODEL,
	type LlmFeatureDraft,
	performFeatureToggle,
	pickSmallestInstalledOllama,
	readLlmSnapshot,
	resolveOllamaModelReconcilePatch,
	shouldScanOpenRouter,
} from "../lib/llm-settings-panel-test-helpers";
import { useWarmupStatusStore } from "../model/warmup-status-store";
import {
	ConfigurationsCombobox,
	FeaturePresetControls,
} from "./modifier-presets";
import { PlaygroundModal } from "./playground-modal";
import { ApiKeyDialog, OllamaDialog } from "./provider-dialogs";
import { DictionaryAutoAddControl, ProviderSection } from "./provider-sections";
import type {
	FeatureBlockProps,
	LlmProvider,
	OllamaCatalogState,
	OllamaModel,
	OllamaPullBundle,
	OpenRouterCatalogState,
} from "./types";
import { WarmupStatusBanner } from "./WarmupStatusBanner";

// Toggle handler shared by both feature subsections — pulls together the
// per-feature preflight (Ollama reachability / OpenRouter API key) without
// touching the master switch (there is none anymore).
function useFeatureToggleHandler(
	props: FeatureBlockProps,
	checkOllamaReachable: () => Promise<boolean>,
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

	// Mutual-exclusion with Smart Endpoint's competing finalization heuristic.
	// Defined once so every dictation-enable path goes through it.
	const disableDictationConflicts = () => {
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

	const usesOllama =
		dictation.provider === "ollama" || transforms.provider === "ollama";
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
		})),
	);

	// Flatten the store's `{ progress, startedAt }` shape down to plain
	// `{ [name]: OllamaPullProgress }` for the selector's `pulls` prop.
	const ollamaPulls: Record<
		string,
		import("@/shared/api/models").OllamaPullProgress
	> = {};
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
		})),
	);
	const librarySearchProps: import("@picker").OllamaModelSelectorProps["librarySearch"] =
		{
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
		})),
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
		if (
			shouldScanOpenRouter("openrouter", openrouterApiKey, openrouterLoaded) &&
			usesOpenRouter
		) {
			scanOpenRouter();
		}
	}, [usesOpenRouter, openrouterApiKey, openrouterLoaded, scanOpenRouter]);

	// After a scan, ensure each feature's Ollama model still exists. When the
	// user deletes the last installed model, disable the enabled Ollama feature
	// instead of leaving the toggle on with no runnable model.
	useEffect(() => {
		if (!ollamaLoaded) {
			return;
		}
		const patch = resolveOllamaModelReconcilePatch(
			dictation.provider,
			ollamaModels,
			dictation.model,
			dictation.enabled,
		);
		if (patch) {
			updateDictation(patch);
		}
	}, [
		dictation.enabled,
		dictation.provider,
		dictation.model,
		ollamaLoaded,
		ollamaModels,
		updateDictation,
	]);

	useEffect(() => {
		if (!ollamaLoaded) {
			return;
		}
		const patch = resolveOllamaModelReconcilePatch(
			transforms.provider,
			ollamaModels,
			transforms.model,
			transforms.enabled,
		);
		if (patch) {
			updateTransforms(patch);
		}
	}, [
		transforms.enabled,
		transforms.provider,
		transforms.model,
		ollamaLoaded,
		ollamaModels,
		updateTransforms,
	]);

	// Per-feature toggle gating: each feature's "turn on" flow may open one of
	// these dialogs (Ollama install/run, or OpenRouter API key entry) when the
	// chosen provider isn't yet configured. The model-manager dialog is opened
	// only from inside the Ollama section of whichever feature triggered it.
	const [showOllamaDialog, setShowOllamaDialog] = useState(false);
	const [showApiKeyDialog, setShowApiKeyDialog] = useState(false);
	// Tracks which feature initiated the OllamaDialog / ApiKeyDialog so the
	// dialog completion handler knows which feature to enable.
	const [pendingFeature, setPendingFeature] = useState<
		"dictation" | "transforms" | null
	>(null);

	// Build the same "enable with a resolved model" patch the toggle uses,
	// so the post-dialog enable path can't slip past the no-model guard.
	const resolveOllamaEnablePatch = (
		currentModel: string,
	): Partial<LlmFeatureDraft> => {
		const currentValid =
			currentModel.length > 0 &&
			ollamaModels.some((m) => m.name === currentModel);
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
		currentOpenRouterModel: string,
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
				disableDictationConflicts();
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
		// Force past the loaded-cache guard: the prior scan failed (no key) and
		// marked the catalog loaded, so a plain scan would skip the retry.
		scanOpenRouter(true);
		if (pendingFeature === "dictation") {
			updateDictation(resolveOpenRouterEnablePatch(dictation.openrouterModel));
			disableDictationConflicts();
		} else if (pendingFeature === "transforms") {
			updateTransforms(
				resolveOpenRouterEnablePatch(transforms.openrouterModel),
			);
		}
		setPendingFeature(null);
	};

	const setShowOllamaDialogFor =
		(feature: "dictation" | "transforms") => (v: boolean) => {
			setShowOllamaDialog(v);
			if (v) {
				setPendingFeature(feature);
			}
		};
	const setShowApiKeyDialogFor =
		(feature: "dictation" | "transforms") => (v: boolean) => {
			setShowApiKeyDialog(v);
			if (v) {
				setPendingFeature(feature);
			}
		};
	// Open the model-picker modal (rendered at the SettingsPage view level, since
	// the dialog is a widget and widgets can't import widgets). Toggling a feature
	// on with no installed model routes here; the picker's install callback then
	// commits `enabled: true` — the toggle never enables on its own.
	const setShowModelPickerFor =
		(feature: "dictation" | "transforms") => (v: boolean) => {
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
		disableDictationConflicts,
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

export type LlmSettingsPanelModel = ReturnType<typeof useLlmSettingsPanel>;

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
		disableDictationConflicts,
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
				icon={BrainCircuitIcon}
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
					onEnabled={disableDictationConflicts}
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
						configControl={
							<ConfigurationsCombobox
								snapshot={dictation}
								t={t}
								update={updateDictation}
							/>
						}
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
						configControl={
							<ConfigurationsCombobox
								snapshot={transforms}
								t={t}
								update={updateTransforms}
							/>
						}
						feature="transforms"
						model={model}
						snapshot={transforms}
						update={updateTransforms}
					/>
				</FeatureBlock>
			</SettingSection>

			<LlmSettingsDialogs model={model} />
			{/* Modal pins the surface baseline internally, so the playground gets a
			    settings-like elevation ramp (popup → cards → inputs) regardless of
			    how deeply this panel is nested — no wrapper needed here. */}
			<PlaygroundModal
				model={model}
				onClose={() => setPlaygroundOpen(false)}
				open={playgroundOpen}
			/>
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
	warmupStatus: import("@/shared/api/ipc-client").LlmWarmupStatus | null,
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
	const [pendingSwap, setPendingSwap] = useState<PendingOllamaSwap | null>(
		null,
	);

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
		checkOllamaReachable,
	);
	const fallbackExclusion = computeModelExclusionConfig(
		featureSnapshot.openrouterModel,
	);
	const updateAny = update as (p: Partial<LlmFeatureDraft>) => void;
	const isDictation = feature === "dictation";
	const { swap: ollamaSwap, beginSwap: beginOllamaSwap } = useOllamaSwapTracker(
		{
			currentModel: featureSnapshot.model,
			enabled: featureSnapshot.enabled,
			provider: featureSnapshot.provider,
			warmupStatus,
		},
	);
	return (
		<SettingSubsection
			caption={
				isDictation ? t("subDictationCaption") : t("subTransformCaption")
			}
			icon={isDictation ? PencilIcon : MagicWand01Icon}
			onToggle={handleToggle}
			title={isDictation ? t("subDictationTitle") : t("subTransformTitle")}
			toggled={featureSnapshot.enabled}
		>
			<div className="flex flex-col divide-y divide-surface-1">
				<FormControl
					label={t("provider")}
					layout="row"
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
				<ProviderSection
					beginOllamaSwap={beginOllamaSwap}
					dense
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
				{isDictation && featureSnapshot.provider === "ollama" ? (
					<DictionaryAutoAddControl
						featureSnapshot={featureSnapshot}
						ollamaModels={ollamaCatalog.models}
						t={t}
						updateAny={updateAny}
					/>
				) : null}
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
