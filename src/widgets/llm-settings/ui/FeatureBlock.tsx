import { MagicWand01Icon, PencilIcon } from "@hugeicons/core-free-icons";
import { computeModelExclusionConfig } from "@picker";
import { type ReactNode, useEffect, useState } from "react";
import { SettingSubsection } from "@/entities/setting";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { Switcher } from "@/shared/ui/switcher";
import {
	type LlmFeatureDraft,
	performFeatureToggle,
} from "../lib/llm-settings-panel-test-helpers";
import { DictionaryAutoAddControl, ProviderSection } from "./provider-sections";
import type { FeatureBlockProps, LlmProvider } from "./types";
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
	forceDisabled?: boolean;
	forceDisabledTooltip?: string | undefined;
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
	retryOllamaWarmup: () => Promise<void>;
}

export function FeatureBlock(props: FeatureBlockComponentProps) {
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
		retryOllamaWarmup,
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
		forceDisabled = false,
		forceDisabledTooltip,
	} = props;
	const handleToggleBase = useFeatureToggleHandler(
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
	const handleToggle = async (next: boolean): Promise<void> => {
		if (forceDisabled) {
			return;
		}
		await handleToggleBase(next);
	};
	const fallbackExclusion = computeModelExclusionConfig(
		featureSnapshot.openrouterModel,
	);
	const updateAny = update as (p: Partial<LlmFeatureDraft>) => void;
	const isDictation = feature === "dictation";
	const effectiveEnabled = forceDisabled ? false : featureSnapshot.enabled;
	const { swap: ollamaSwap, beginSwap: beginOllamaSwap } = useOllamaSwapTracker(
		{
			currentModel: featureSnapshot.model,
			enabled: effectiveEnabled,
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
			toggled={effectiveEnabled}
			toggleDisabled={forceDisabled}
			toggleDisabledTooltip={forceDisabledTooltip}
		>
			<div className="flex flex-col divide-y divide-surface-1">
				<FormControl
					disabled={forceDisabled}
					label={t("provider")}
					layout="row"
					tooltip={t("providerTooltip")}
					controlTooltip={forceDisabledTooltip}
				>
					<ElevatedSurface>
						<Switcher
							onChange={(v) => {
								if (!forceDisabled) {
									updateAny({ provider: v as LlmProvider });
								}
							}}
							options={providerOpts}
							value={featureSnapshot.provider}
						/>
					</ElevatedSurface>
				</FormControl>
				<ProviderSection
					beginOllamaSwap={beginOllamaSwap}
					dense
					fallbackExclusion={fallbackExclusion}
					feature={feature}
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
				{effectiveEnabled ? (
					<WarmupStatusBanner
						feature={feature}
						model={featureSnapshot.model}
						onRetry={retryOllamaWarmup}
						provider={featureSnapshot.provider}
						status={warmupStatus}
					/>
				) : null}
			</div>
			{children}
		</SettingSubsection>
	);
}
