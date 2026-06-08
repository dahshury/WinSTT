import {
	computeModelExclusionConfig,
	OllamaModelSelector,
	OpenRouterModelSelector,
	ReasoningEffortDropdown,
} from "@picker";
import type { OpenRouterModel } from "@/shared/api/models";
import { IPC } from "@/shared/api/ipc-channels";
import { ipcSend } from "@/shared/api/ipc-client";
import { FormControl } from "@/shared/ui/form-control";
import { Toggle } from "@/shared/ui/toggle";
import { RECOMMENDED_OLLAMA_MODELS } from "@/entities/llm-catalog";
import type { LlmFeatureDraft } from "../lib/llm-settings-panel-test-helpers";
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

type LlmFeature = "dictation" | "transforms";

function openDetachedLlmPicker(
	rect: DOMRect,
	payload:
		| { feature: LlmFeature; pickerKind: "llm-ollama" }
		| {
				feature: LlmFeature;
				pickerKind: "llm-openrouter";
				pickerTarget: "fallback" | "primary";
		  },
): void {
	ipcSend(IPC.MODEL_PICKER_OPEN, {
		x: rect.x,
		y: rect.y,
		width: rect.width,
		height: rect.height,
		pickerKind: payload.pickerKind,
		pickerFeature: payload.feature,
		...("pickerTarget" in payload
			? { pickerTarget: payload.pickerTarget }
			: {}),
	});
}

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
	const caption = hasSelectedModel
		? t("dictionaryAutoAddCaption")
		: t("dictionaryAutoAddSelectModel");
	return (
		<div className="col-span-2">
			<FormControl
				caption={caption}
				disabled={!hasSelectedModel}
				label={t("dictionaryAutoAddLabel")}
				labelAddon={
					<Toggle
						aria-label={t("dictionaryAutoAddLabel")}
						checked={
							hasSelectedModel &&
							featureSnapshot.dictionaryAutoAddEnabled === true
						}
						disabled={!hasSelectedModel}
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
	feature?: LlmFeature | undefined;
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
	const supportsThinking =
		selectedModel?.capabilities?.includes("thinking") ?? false;
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
					onOpenDetached={
						feature
							? (rect) =>
									openDetachedLlmPicker(rect, {
										feature,
										pickerKind: "llm-ollama",
									})
							: undefined
					}
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
					layout={dense ? "row" : "stacked"}
					tooltip="Reasoning models can spend more or less time thinking before answering. Higher effort improves accuracy on hard inputs but adds latency. Off disables thinking entirely."
				>
					<ReasoningEffortDropdown
						ariaLabel="Thinking effort"
						fullWidth={!dense}
						onChange={setThinkingEffort}
						value={thinkingEffort}
					/>
				</FormControl>
			) : null}

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
	feature?: LlmFeature | undefined;
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
										openDetachedLlmPicker(rect, {
											feature,
											pickerKind: "llm-openrouter",
											pickerTarget: "primary",
										})
								: undefined
						}
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
						isLoading={openrouterScanning}
						models={openrouterModels ? [...openrouterModels] : []}
						onChange={setFallbackModel}
						onOpen={scanOpenRouter}
						onOpenDetached={
							feature
								? (rect) =>
										openDetachedLlmPicker(rect, {
											feature,
											pickerKind: "llm-openrouter",
											pickerTarget: "fallback",
										})
								: undefined
						}
						placeholder={t("openrouterFallbackModelPlaceholder")}
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
	/** Forwarded to the Ollama sub-section for the settings-panel compaction. */
	dense?: boolean | undefined;
	fallbackExclusion: ReturnType<typeof computeModelExclusionConfig>;
	featureSnapshot: LlmFeatureDraft;
	feature?: LlmFeature | undefined;
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
