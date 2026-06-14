import type { useTranslations } from "use-intl";
import type { PausedPullState } from "@/entities/llm-catalog";
import type { AppSettingsOutput } from "@/shared/config/settings-schema";
import type { LlmFeatureDraft } from "../lib/llm-settings-panel-test-helpers";

export type TranslateFn = ReturnType<typeof useTranslations>;

// Re-uses the spec-generated shape so `details.parameterSize` /
// `details.quantizationLevel` flow through to the picker.
export type OllamaModel = import("@/shared/api/models").OllamaModel;

type LlmSettings = AppSettingsOutput["llm"];
type LlmDictation = LlmSettings["dictation"];
export type LlmProvider = LlmDictation["provider"];

// Derived from the settings schema so they can't drift from the persisted
// shape. `reasoningEffort` and `thinkingEffort` share the same off/low/medium/
// high scale and drive the same shared `ReasoningEffortDropdown`.
export type ReasoningEffort = LlmDictation["reasoningEffort"];
export type Verbosity = LlmDictation["verbosity"];

export type OllamaThinkingEffort = LlmDictation["thinkingEffort"];

export interface OllamaPullBundle {
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
	pulls: Readonly<
		Record<string, import("@/shared/api/models").OllamaPullProgress>
	>;
	resumePull: (name: string) => Promise<unknown>;
}

export interface OllamaCatalogState {
	error: string | null;
	isLoaded: boolean;
	isScanning: boolean;
	models: readonly OllamaModel[];
	scanModels: () => void;
}

export interface OpenRouterCatalogState {
	error: string | null;
	isLoaded: boolean;
	isScanning: boolean;
	models: readonly import("@/shared/api/models").OpenRouterModel[];
	scanModels: () => void;
}

export interface FeatureBlockProps {
	dictationLayout?: boolean;
	endpoint: string;
	feature: "dictation" | "transforms";
	featureSnapshot: LlmFeatureDraft;
	librarySearch: import("@/widgets/model-picker").OllamaModelSelectorProps["librarySearch"];
	ollamaCatalog: OllamaCatalogState;
	ollamaPullBundle: OllamaPullBundle;
	ollamaReachable: boolean | null;
	/**
	 * Side effect fired when this feature gets enabled, after `update({enabled: true})`.
	 * Used to enforce dictation conflicts such as Smart Endpoint and word-by-word
	 * paste. Passed in by the parent rather than read from the store here so that
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

type LlmTransforms = LlmSettings["transforms"];
type LlmSharedPatch = Partial<
	Pick<LlmSettings, "endpoint" | "openrouterApiKey">
>;
type LlmDictationPatch = Partial<LlmDictation>;
type LlmTransformsPatch = Partial<LlmTransforms>;
type UpdateSharedFn = (patch: LlmSharedPatch) => void;
type UpdateDictationFn = (patch: LlmDictationPatch) => void;
type UpdateTransformsFn = (patch: LlmTransformsPatch) => void;
