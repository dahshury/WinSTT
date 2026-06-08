import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";
import {
	assessOllamaFit,
	useLlmCatalogStore,
	useOllamaLibraryStore,
	useOpenRouterCatalogStore,
} from "@/entities/llm-catalog";
import { useModelStateStore } from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { useLlmModelPickerStore } from "@/features/llm-model-picker";
import { fetchOllamaModels } from "@/shared/api/ipc-client";
import { detectAppleIntelligencePlatform } from "@/shared/lib/apple-intelligence-platform";
import { useWarmupStatusFeed } from "../api/use-warmup-status-feed";
import {
	buildLevelOpts,
	buildProviderOpts,
	buildToneOpts,
	DEFAULT_OPENROUTER_MODEL,
	type LlmFeatureDraft,
	pickSmallestInstalledOllama,
	readLlmSnapshot,
	resolveOllamaModelReconcilePatch,
	shouldScanOpenRouter,
} from "../lib/llm-settings-panel-test-helpers";
import { useWarmupStatusStore } from "./warmup-status-store";
import type {
	OllamaCatalogState,
	OllamaModel,
	OllamaPullBundle,
	OpenRouterCatalogState,
} from "../ui/types";

/**
 * Owns every store subscription, derived snapshot, effect and handler the
 * panel needs. Extracted out of `LlmSettingsPanel` so the component stays a
 * thin composition root. Behavior is a verbatim move — React Compiler handles
 * memoization, so nothing is wrapped in `useMemo`/`useCallback`.
 */
export function useLlmSettingsPanel() {
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
		warmModels: warmOpenRouter,
	} = useOpenRouterCatalogStore(
		useShallow((s) => ({
			models: s.models,
			isLoaded: s.isLoaded,
			isScanning: s.isScanning,
			error: s.error,
			scanModels: s.scanModels,
			warmModels: s.warmModels,
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
			warmOpenRouter();
		}
	}, [usesOpenRouter, openrouterApiKey, openrouterLoaded, warmOpenRouter]);

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
		scanModels: warmOpenRouter,
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
