import { OllamaModelSelector } from "@/features/llm-model-picker";
import { OpenRouterModelSelector } from "@/features/select-cloud-stt-model";
import type { computeModelExclusionConfig } from "@/shared/ui/model-picker/lib/model-exclusion";
import type { OpenRouterModel } from "@/shared/api/models";
import {
	type LlmModelPickerFeature,
	openLlmModelPickerAtRect,
} from "@/shared/api/model-picker-window";
import { fireAndForget } from "@/shared/lib/fire-and-forget";
import {
	ollamaLlmSelectorUiStorageKey,
	openRouterLlmSelectorUiStorageKey,
} from "@/shared/lib/model-picker-ui-storage-keys";
import { FormControl } from "@/shared/ui/form-control";
import { Toggle } from "@/shared/ui/toggle";
import {
	isLiteOllamaModel,
	ollamaThinkingMode,
	RECOMMENDED_OLLAMA_MODELS,
} from "@/entities/llm-catalog";
import { useOllamaSuggestions } from "@/features/suggested-models";
import type { LlmFeatureDraft } from "../lib/llm-settings-panel-test-helpers";
import { OllamaThinkingControl } from "./OllamaThinkingControl";
import type {
	OllamaCatalogState,
	OllamaModel,
	OllamaPullBundle,
	OllamaThinkingEffort,
	OpenRouterCatalogState,
	ReasoningEffort,
	TranslateFn,
	Verbosity,
} from "./types";

/** Shared error banner used by both Ollama and OpenRouter sections.
 *  Null-renders on empty message so callers can pass their error state
 *  through directly without an outer guard. */
function ErrorBanner({ message }: { message: string | null }) {
	if (!message) {
		return null;
	}
	return (
		<div className="col-span-2 rounded bg-error/10 p-3 text-error text-sm">
			{message}
		</div>
	);
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

export function DictionaryAutoAddControl({
	featureSnapshot,
	ollamaModels,
	t,
	updateAny,
}: {
	featureSnapshot: LlmFeatureDraft;
	ollamaModels: readonly OllamaModel[];
	t: TranslateFn;
	updateAny: (p: Partial<LlmFeatureDraft>) => void;
}) {
	const selectedModel = ollamaModels.find(
		(m) => m.name === featureSnapshot.model,
	);
	const hasSelectedModel = selectedModel != null;
	// Lite-tier models run the `{text}`-only response schema, which has no
	// learning fields — the backend skips extraction entirely, so the toggle
	// is disabled with an explanation rather than silently doing nothing. The
	// persisted setting is left untouched: switching back to a 4B+ model
	// restores the user's previous choice.
	const liteModel = isLiteOllamaModel(featureSnapshot.model);
	const disabled = !hasSelectedModel || liteModel;
	const caption = liteModel
		? t("dictionaryAutoAddLiteModel")
		: hasSelectedModel
			? t("dictionaryAutoAddCaption")
			: t("dictionaryAutoAddSelectModel");
	return (
		<div className="col-span-2">
			<FormControl
				caption={caption}
				disabled={disabled}
				label={t("dictionaryAutoAddLabel")}
				labelAddon={
					<Toggle
						aria-label={t("dictionaryAutoAddLabel")}
						checked={
							!disabled && featureSnapshot.dictionaryAutoAddEnabled === true
						}
						disabled={disabled}
						onCheckedChange={(checked) =>
							updateAny({ dictionaryAutoAddEnabled: checked })
						}
					/>
				}
				tooltip={t("dictionaryAutoAddTooltip")}
			/>
		</div>
	);
}

interface OllamaSectionProps {
	/** Settings-panel compaction: render the thinking-effort selector as a
	 *  tight label-left/control-right row instead of a stacked full-width
	 *  block. Off in the Playground (which has room to breathe). */
	dense?: boolean | undefined;
	enabled: boolean;
	feature?: LlmModelPickerFeature | undefined;
	librarySearch: import("@/features/llm-model-picker").OllamaModelSelectorProps["librarySearch"];
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

function OllamaSection(props: OllamaSectionProps) {
	const {
		dense,
		feature,
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
	// Suggested (spec-based recommender) verdict for the inline picker (the
	// detached window wires its own in PickerBody). `undefined` until system
	// info arrives — the picker treats that as "no verdict" (chip hidden).
	const suggestions = useOllamaSuggestions();
	// One control per behaviour: GPT-OSS gets Low/Medium/High (it can't stop
	// reasoning, so there is no Off), hybrid models get a plain On/Off toggle
	// (levels are no-ops on the wire), and dedicated reasoning models get a
	// read-only "Always on". Support comes from the catalog first (Ollama's API
	// doesn't expose it), then live capabilities. See ollama-thinking.ts.
	const thinkingMode = ollamaThinkingMode(model, selectedModel?.capabilities);
	// NOTE: deliberately NO write-normalization of the stored effort here. An
	// earlier version rewrote a stored "off" to "low" while a levels model
	// (gpt-oss) was selected — but the effort setting is SHARED per feature, so
	// that write leaked across model switches: pick gpt-oss once and a hybrid
	// model selected later inherited thinking ON that the user never chose.
	// Instead the stored value is left alone; the levels control DISPLAYS a
	// stored "off" as Low, and the backend clamps it to the wire-supported
	// "low" for levels models (`thinking_flag_for` in ollama_request.rs).
	return (
		<>
			<FormControl label={t("model")} tooltip={t("modelTooltip")}>
				<OllamaModelSelector
					isLoading={ollamaScanning}
					librarySearch={librarySearch}
					models={ollamaModels}
					onChange={setModel}
					onDelete={(name) => {
						fireAndForget(
							pullBundle.deleteModel(name),
							"provider-sections.deleteModel",
						);
					}}
					onDiscardPull={pullBundle.discardPausedPull}
					onOpen={scanOllama}
					onOpenDetached={
						feature
							? (rect) =>
									openLlmModelPickerAtRect(rect, {
										feature,
										pickerKind: "llm-ollama",
									})
							: undefined
					}
					onPull={(name) => {
						fireAndForget(
							pullBundle.pullModel(name),
							"provider-sections.pullModel",
						);
					}}
					onResumePull={(name) => {
						fireAndForget(
							pullBundle.resumePull(name),
							"provider-sections.resumePull",
						);
					}}
					onStopPull={pullBundle.cancelPull}
					pausedPulls={pullBundle.pausedPulls}
					placeholder={ollamaScanning ? tc("scanning") : t("selectModel")}
					pulls={pullBundle.pulls}
					recommendedModels={RECOMMENDED_OLLAMA_MODELS}
					suggestions={suggestions}
					swap={swap}
					systemFit={pullBundle.getFit}
					uiStorageKey={
						feature ? ollamaLlmSelectorUiStorageKey(feature) : undefined
					}
					value={model}
				/>
			</FormControl>

			{thinkingMode === "none" ? null : (
				<FormControl
					label={thinkingMode === "always-on" ? "Thinking" : "Thinking effort"}
					layout={dense ? "row" : "stacked"}
					tooltip={
						thinkingMode === "always-on"
							? "This model always reasons before answering and can't be turned off. Pick a non-reasoning model if you want faster, direct output."
							: thinkingMode === "toggle"
								? "Turn the model's reasoning on or off. On thinks before answering — more accurate on hard inputs, but slower."
								: "This model always reasons before answering; the level tunes how long it thinks. Low keeps the trace minimal and fastest, High is most thorough but slowest."
					}
				>
					<OllamaThinkingControl
						dense={dense ?? false}
						mode={thinkingMode}
						onChange={setThinkingEffort}
						value={thinkingEffort}
					/>
				</FormControl>
			)}

			<ErrorBanner message={ollamaError} />
			<OllamaReachabilityWarning
				enabled={enabled}
				reachable={ollamaReachable}
				t={t}
			/>
		</>
	);
}

interface OpenRouterSectionProps {
	apiKeyMissing: boolean;
	fallbackExclusion: ReturnType<typeof computeModelExclusionConfig>;
	feature?: LlmModelPickerFeature | undefined;
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
		feature,
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
				<FormControl
					label={t("openrouterModel")}
					tooltip={t("openrouterModelTooltip")}
				>
					<OpenRouterModelSelector
						disabled={apiKeyMissing}
						isLoading={openrouterScanning}
						maxOutputTokens={maxOutputTokens}
						models={openrouterModels ? [...openrouterModels] : []}
						onChange={setModel}
						onMaxOutputTokensChange={onMaxOutputTokensChange}
						onOpen={scanOpenRouter}
						onOpenDetached={
							feature
								? (rect) =>
										openLlmModelPickerAtRect(rect, {
											feature,
											pickerKind: "llm-openrouter",
											pickerTarget: "primary",
										})
								: undefined
						}
						onReasoningEffortChange={onReasoningEffortChange}
						onVerbosityChange={onVerbosityChange}
						reasoningEffort={reasoningEffort}
						uiStorageKey={
							feature
								? openRouterLlmSelectorUiStorageKey(feature, "primary")
								: undefined
						}
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
						isLoading={openrouterScanning}
						models={openrouterModels ? [...openrouterModels] : []}
						onChange={setFallbackModel}
						onOpen={scanOpenRouter}
						onOpenDetached={
							feature
								? (rect) =>
										openLlmModelPickerAtRect(rect, {
											feature,
											pickerKind: "llm-openrouter",
											pickerTarget: "fallback",
										})
								: undefined
						}
						placeholder={t("openrouterFallbackModelPlaceholder")}
						uiStorageKey={
							feature
								? openRouterLlmSelectorUiStorageKey(feature, "fallback")
								: undefined
						}
						value={openrouterFallbackModel}
					/>
				</FormControl>
			</div>

			<ErrorBanner message={openrouterError} />
		</>
	);
}

/**
 * Apple Intelligence has no per-feature config — it's a single on-device
 * model with no endpoint, no API key, no model picker. Render a static
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
	/** Forwarded to the Ollama sub-section for the settings-panel compaction. */
	dense?: boolean | undefined;
	fallbackExclusion: ReturnType<typeof computeModelExclusionConfig>;
	featureSnapshot: LlmFeatureDraft;
	feature?: LlmModelPickerFeature | undefined;
	librarySearch: import("@/features/llm-model-picker").OllamaModelSelectorProps["librarySearch"];
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

export function ProviderSection(args: ProviderSectionArgs) {
	const { featureSnapshot, t } = args;
	if (featureSnapshot.provider === "apple-intelligence") {
		return <AppleIntelligenceSection t={t} />;
	}
	if (featureSnapshot.provider === "ollama") {
		return (
			<OllamaSection
				dense={args.dense}
				enabled={featureSnapshot.enabled}
				feature={args.feature}
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
				thinkingEffort={featureSnapshot.thinkingEffort ?? "off"}
			/>
		);
	}
	return (
		<OpenRouterSection
			apiKeyMissing={!args.openrouterApiKey}
			fallbackExclusion={args.fallbackExclusion}
			feature={args.feature}
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
