import {
	AiMagicIcon,
	AiSettingIcon,
	CpuIcon,
	FlashIcon,
	InfinityIcon,
	SpeechToTextIcon,
	Timer01Icon,
	UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { isRealtimeViable, SttModelSelector } from "@picker";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { providerOf } from "@/entities/cloud-stt-provider";
import { useConnectionStore } from "@/entities/connection";
import {
	recordLastLocalSttModel,
	resolveLocalDefault,
	supportsInitialPrompt,
	supportsTranslateToEnglish,
	useCatalogStore,
	useModelStateStore,
} from "@/entities/model-catalog";
import {
	DEFAULT_SETTINGS,
	SettingResetButton,
	SettingSection,
	useDiarizationToggleStore,
	useSettingsStore,
	useSettingsTabStore,
} from "@/entities/setting";
import { useSystemResourcesStore } from "@/entities/system-resources";
import { useFileTranscriptionStore } from "@/features/file-transcription";
import {
	DownloadConfirmationDialog,
	isQuantDownloading,
	useQuantActions,
} from "@/features/model-download";
import { CloudModelSelect, useSttSourceSwitch } from "@/features/select-cloud-stt-model";
import { type SwapController, useModelSwapController } from "@/features/swap-model";
import { IPC } from "@/shared/api/ipc-channels";
import { ipcSend } from "@/shared/api/ipc-client";
import { LANGUAGES, type OnnxQuantization } from "@/shared/config/defaults";
import { cn } from "@/shared/lib/cn";
import { isRealtimeEnabled } from "@/shared/lib/realtime-enabled";
import { surfaceClasses, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { InfoTooltip } from "@/shared/ui/info-tooltip";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { ResourceWarningDialog } from "@/shared/ui/resource-warning-dialog";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { Spinner } from "@/shared/ui/spinner";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import { Tooltip } from "@/shared/ui/tooltip";
import { useLockLlmTranslate } from "../model/use-lock-llm-translate";
import { useLockRealtimeToMain } from "../model/use-lock-realtime-to-main";
import { useStaleModelFallback } from "../model/use-stale-model-fallback";
import { useSwapProgress } from "../model/use-swap-progress";

type TFn = ReturnType<typeof useTranslations>;

type SettingsStoreState = ReturnType<typeof useSettingsStore.getState>;
type ModelSettings = SettingsStoreState["settings"]["model"];
type QualitySettings = SettingsStoreState["settings"]["quality"];
type UpdateModelFn = SettingsStoreState["updateModelSettings"];
type UpdateQualityFn = SettingsStoreState["updateQualitySettings"];

type DeviceValue = "auto" | "cpu";
type CatalogModels = ReturnType<typeof useCatalogStore.getState>["models"];
type StatesById = ReturnType<typeof useModelStateStore.getState>["statesById"];
type SystemInfo = ReturnType<typeof useModelStateStore.getState>["systemInfo"];

interface MainModelSectionProps {
	catalogLoaded: boolean;
	catalogModels: CatalogModels;
	currentQuantization: OnnxQuantization;
	/** Snapshot of the in-flight download (model id + percent). Drives the
	 *  picker's "Downloading X · 23%" trigger AND distinguishes "we're
	 *  fetching bytes" from "the server is loading weights" so the picker
	 *  doesn't lock down for the entire multi-GB download. */
	downloadProgress: { modelId: string; percent: number | null } | null;
	handleModelChange: (modelId: string, quantization?: OnnxQuantization) => void;
	/** True when the active model reads Whisper's free-text `initial_prompt`
	 *  slot (Whisper + Lite-Whisper). The prompt field hides for every other
	 *  engine — their slot is absent or untrained — so the UI doesn't lie. */
	initialPromptSupported: boolean;
	isSwapping: boolean;
	langOpts: SelectOption[];
	/** Per-quant delete handler (after the picker's AlertDialog confirms). */
	onDeleteQuant: (modelId: string, quantization: OnnxQuantization) => void;
	/** Per-quant download action — start / pause / resume / cancel. */
	onDownloadAction: (
		action: "start" | "pause" | "resume" | "cancel",
		modelId: string,
		quantization: OnnxQuantization
	) => void;
	/** Per-quant live download snapshot lookup. */
	onDownloadSnapshot: (
		modelId: string,
		quantization: OnnxQuantization
	) => import("@/features/model-download").QuantDownloadState | undefined;
	/** Which optional sub-sections to render. Each flag is `false` when the
	 *  active model makes that control meaningless (cloud delegates language /
	 *  unload to the provider; single-language models hide the language picker).
	 *  The compute-device control is NOT here — it moved out to its own
	 *  top-level {@link DeviceSection} because it's shared by local STT *and*
	 *  local TTS, so it can't belong to the STT section. */
	sections: {
		/** Language picker. False for single-language models (the only choice
		 *  would be a no-op "auto-detect") or cloud (the provider handles it). */
		language: boolean;
		/** Idle model-unload timeout. False for cloud (no local ONNX session
		 *  to unload). */
		unloadTimeout: boolean;
	};
	selectedModel: string;
	settings: ModelSettings | undefined;
	statesById: StatesById;
	systemInfo: SystemInfo;
	t: TFn;
	/** True when the active model supports a decoder-level translate
	 *  path (Whisper multilingual variants or NeMo Canary). The toggle
	 *  hides for engines that can't honor it — GigaAM, Moonshine,
	 *  Kaldi/Vosk, Cohere, ``.en`` Whispers — so the UI doesn't lie. */
	translateSupported: boolean;
	update: UpdateModelFn;
}

interface SourceAreaProps {
	catalogLoaded: boolean;
	catalogModels: CatalogModels;
	currentQuantization: OnnxQuantization;
	downloadProgress: { modelId: string; percent: number | null } | null;
	handleModelChange: (modelId: string, quantization?: OnnxQuantization) => void;
	hasAnyCloudKey: boolean;
	initialSourceIsCloud: boolean;
	isCloud: boolean;
	isSwapping: boolean;
	onDeleteQuant: (modelId: string, quantization: OnnxQuantization) => void;
	onDownloadAction: (
		action: "start" | "pause" | "resume" | "cancel",
		modelId: string,
		quantization: OnnxQuantization
	) => void;
	onDownloadSnapshot: (
		modelId: string,
		quantization: OnnxQuantization
	) => import("@/features/model-download").QuantDownloadState | undefined;
	selectedModel: string;
	statesById: StatesById;
	systemInfo: SystemInfo;
	t: TFn;
	tIntegrations: TFn;
}

/**
 * Owns the local "which picker is on screen" UI state. The parent re-mounts
 * this component (via `key={effectiveSourceIsCloud}`) whenever the persisted
 * model's source changes or API-key availability flips, so React naturally
 * resets `source` to the correct initial value WITHOUT a derived-state effect.
 *
 * Toggling the source does NOT touch persisted settings — the persisted
 * model only changes when the user picks a row from the visible picker.
 */
function SourceArea({
	catalogLoaded,
	catalogModels,
	currentQuantization,
	downloadProgress,
	handleModelChange,
	hasAnyCloudKey,
	initialSourceIsCloud,
	isCloud,
	isSwapping,
	onDeleteQuant,
	onDownloadAction,
	onDownloadSnapshot,
	selectedModel,
	statesById,
	systemInfo,
	t,
	tIntegrations,
}: SourceAreaProps): ReactNode {
	const goToIntegrations = useSettingsTabStore((s) => s.setActiveTab);
	const { source, sourceOpts, onSourceChange } = useSttSourceSwitch({
		hasAnyCloudKey,
		initialSourceIsCloud,
		onConfigureCloud: () => goToIntegrations("integrations"),
		onModelChange: handleModelChange,
		pickLocalDefault: () => resolveLocalDefault(catalogModels, statesById),
		selectedModel,
	});
	// Open the detached picker window (full work area, can extend beyond the
	// 700×560 settings window) instead of an in-window popup — mirrors the
	// main-window footer chip. It anchors above this trigger's rect.
	const openDetachedPicker = (rect: DOMRect) =>
		ipcSend(IPC.MODEL_PICKER_OPEN, {
			x: rect.x,
			y: rect.y,
			width: rect.width,
			height: rect.height,
		});
	return (
		<>
			<div className="col-span-2">
				<FormControl
					label={tIntegrations("sourceLabel")}
					layout="row"
					tooltip={tIntegrations("sourceTooltip")}
				>
					<ElevatedSurface className="w-52">
						<Switcher fullWidth onChange={onSourceChange} options={sourceOpts} value={source} />
					</ElevatedSurface>
				</FormControl>
			</div>
			<div className="col-span-2">
				<FormControl label={t("model")} tooltip={t("modelTooltip")}>
					{source === "cloud" ? (
						<CloudModelSelect
							onSelect={(id) => handleModelChange(id)}
							selectedId={isCloud ? selectedModel : ""}
						/>
					) : (
						<SttModelSelector
							currentQuantization={currentQuantization}
							downloadProgress={downloadProgress}
							isLoading={!catalogLoaded || isSwapping}
							kind="main"
							models={catalogModels}
							onChange={handleModelChange}
							onDeleteQuant={onDeleteQuant}
							onDownloadAction={onDownloadAction}
							onDownloadSnapshot={onDownloadSnapshot}
							onOpenDetached={openDetachedPicker}
							statesById={statesById}
							systemInfo={systemInfo}
							value={isCloud ? "" : selectedModel}
						/>
					)}
				</FormControl>
			</div>
		</>
	);
}

/**
 * Whisper's free-text `initial_prompt` slot, surfaced as a small textarea.
 *
 * The persisted value (`model.initialPrompt`) is the user's static prefix; the
 * Electron main process folds it together with the personal-dictionary glossary
 * and the per-utterance context tail before it reaches the decoder (see
 * `electron/lib/initial-prompt.ts`). Editing it re-syncs live via
 * `installInitialPromptSync` — no model reload, no restart.
 *
 * Local draft state commits on blur (not per keystroke) so we fire a single
 * settings write — and the single `set_parameter` round-trip it triggers — once
 * the user is done typing, instead of one per character. Seeded once on mount
 * from the persisted value; the user is the sole editor, so there's no
 * external-change race to reconcile.
 */
function InitialPromptField({
	onCommit,
	t,
	value,
}: {
	onCommit: (next: string) => void;
	t: TFn;
	value: string;
}): ReactNode {
	const [draft, setDraft] = useState(value);
	// Lift the field one level above its substrate, exactly like the TextField
	// primitive — keeps it consistent with the section's other inputs instead of
	// a flat hardcoded surface. (See `project_surface_elevation_convention`.)
	const inputLevel = Math.min(useSurface() + 1, 8);
	return (
		<FormControl
			label={t("initialPrompt")}
			labelTrailing={
				<SettingResetButton
					isDefault={draft === DEFAULT_SETTINGS.model.initialPrompt}
					onReset={() => {
						setDraft(DEFAULT_SETTINGS.model.initialPrompt);
						onCommit(DEFAULT_SETTINGS.model.initialPrompt);
					}}
				/>
			}
			tooltip={t("initialPromptTooltip")}
		>
			<textarea
				aria-label={t("initialPrompt")}
				className={cn(
					"min-h-[64px] w-full resize-y rounded-sm px-2.5 py-2 text-body text-foreground caret-accent outline-none placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
					surfaceClasses(inputLevel)
				)}
				maxLength={600}
				onBlur={() => {
					if (draft !== value) {
						onCommit(draft);
					}
				}}
				onChange={(e) => setDraft(e.target.value)}
				placeholder={t("initialPromptPlaceholder")}
				value={draft}
			/>
		</FormControl>
	);
}

function MainModelSection({
	t,
	settings,
	update,
	catalogModels,
	catalogLoaded,
	statesById,
	systemInfo,
	currentQuantization,
	downloadProgress,
	initialPromptSupported,
	isSwapping,
	langOpts,
	onDeleteQuant,
	onDownloadAction,
	onDownloadSnapshot,
	selectedModel,
	handleModelChange,
	sections,
	translateSupported,
}: MainModelSectionProps): ReactNode {
	const tIntegrations = useTranslations("integrations");
	const integrations = useSettingsStore((s) => s.settings.integrations);
	const hasAnyCloudKey =
		integrations.openai.apiKey.trim().length > 0 ||
		integrations.elevenlabs.apiKey.trim().length > 0;
	const isCloud = providerOf(selectedModel) !== null;
	// The Cloud tab is only reachable when at least one provider key is
	// configured. Persisted cloud selections without a key are flipped back
	// to the local picker — the cloud-key-removal banner already tells the
	// user what's broken.
	const effectiveSourceIsCloud = isCloud && hasAnyCloudKey;

	return (
		<SettingSection icon={SpeechToTextIcon} title={t("mainModel")}>
			<div className="flex flex-col divide-y divide-surface-1">
				{/* `key` resets the local `source` state inside SourceArea whenever
				 *  the persisted model's source changes or API-key availability
				 *  flips — no derived-state effect needed. */}
				<SourceArea
					catalogLoaded={catalogLoaded}
					catalogModels={catalogModels}
					currentQuantization={currentQuantization}
					downloadProgress={downloadProgress}
					handleModelChange={handleModelChange}
					hasAnyCloudKey={hasAnyCloudKey}
					initialSourceIsCloud={effectiveSourceIsCloud}
					isCloud={isCloud}
					isSwapping={isSwapping}
					key={effectiveSourceIsCloud ? "cloud" : "local"}
					onDeleteQuant={onDeleteQuant}
					onDownloadAction={onDownloadAction}
					onDownloadSnapshot={onDownloadSnapshot}
					selectedModel={selectedModel}
					statesById={statesById}
					systemInfo={systemInfo}
					t={t}
					tIntegrations={tIntegrations}
				/>
				{sections.language && (
					<FormControl
						label={t("language")}
						labelTrailing={
							<SettingResetButton
								isDefault={(settings?.language ?? "en") === DEFAULT_SETTINGS.model.language}
								onReset={() => update({ language: DEFAULT_SETTINGS.model.language })}
							/>
						}
						layout="row"
					>
						<ElevatedSurface className="w-52" inline>
							<SearchableSelect
								onChange={(v) => update({ language: v })}
								options={langOpts}
								value={settings?.language ?? "en"}
							/>
						</ElevatedSurface>
					</FormControl>
				)}
				{/* Translate-to-English. Two engine families support it
				    natively at decoder time — Whisper (multilingual
				    variants, via the ``<|translate|>`` token in the
				    decoder prompt) and NeMo Canary (via the
				    ``target_language`` kwarg on ``recognize``). The
				    OnnxAsrTranscriber dispatches between the two
				    paths; the server-side family check (``.en``
				    variants of Whisper, GigaAM, Moonshine, …) silently
				    falls through to plain transcription. We expose the
				    toggle whenever the user's selected catalog family
				    is one of the two supported. */}
				{translateSupported && (
					<FormControl
						label={t("translateToEnglish")}
						labelAddon={
							<Toggle
								checked={settings?.translateToEnglish ?? false}
								onCheckedChange={(v) => update({ translateToEnglish: v })}
							/>
						}
						labelTrailing={
							<SettingResetButton
								isDefault={
									(settings?.translateToEnglish ?? false) ===
									DEFAULT_SETTINGS.model.translateToEnglish
								}
								onReset={() =>
									update({ translateToEnglish: DEFAULT_SETTINGS.model.translateToEnglish })
								}
							/>
						}
						tooltip={t("translateToEnglishTooltip")}
					/>
				)}
				{initialPromptSupported && (
					<InitialPromptField
						onCommit={(v) => update({ initialPrompt: v })}
						t={t}
						value={settings?.initialPrompt ?? ""}
					/>
				)}
				{sections.unloadTimeout && (
					<FormControl
						label={t("modelUnloadTimeout")}
						labelTrailing={
							<SettingResetButton
								isDefault={
									(settings?.modelUnloadTimeout ?? "min5") ===
									DEFAULT_SETTINGS.model.modelUnloadTimeout
								}
								onReset={() =>
									update({ modelUnloadTimeout: DEFAULT_SETTINGS.model.modelUnloadTimeout })
								}
							/>
						}
						layout="row"
						tooltip={t("modelUnloadTimeoutTooltip")}
					>
						<ElevatedSurface className="w-52" inline>
							<SearchableSelect
								onChange={(v) =>
									update({
										modelUnloadTimeout: v as
											| "immediately"
											| "never"
											| "min2"
											| "min5"
											| "min10"
											| "min15"
											| "hour1",
									})
								}
								options={[
									{ id: "immediately", label: t("modelUnloadImmediately"), icon: FlashIcon },
									{ id: "never", label: t("modelUnloadNever"), icon: InfinityIcon },
									{ id: "min2", label: t("modelUnloadMin2"), icon: Timer01Icon },
									{ id: "min5", label: t("modelUnloadMin5"), icon: Timer01Icon },
									{ id: "min10", label: t("modelUnloadMin10"), icon: Timer01Icon },
									{ id: "min15", label: t("modelUnloadMin15"), icon: Timer01Icon },
									{ id: "hour1", label: t("modelUnloadHour1"), icon: Timer01Icon },
								]}
								value={settings?.modelUnloadTimeout ?? "min5"}
							/>
						</ElevatedSurface>
					</FormControl>
				)}
			</div>
		</SettingSection>
	);
}

/**
 * Standalone compute-device control. It lives OUTSIDE both the STT and TTS
 * sections because `model.device` is the single device shared by every local
 * model — the loaded ONNX STT session AND local Kokoro TTS (mirrored onto the
 * server's `--tts-device`). Nesting it under "Main Model" made it look like an
 * STT-only knob and left it stranded under a cloud STT selection even though
 * local TTS was still riding on it. The parent renders this only while at least
 * one local model is active; when STT and TTS are both cloud, nothing local
 * consumes a device and the whole section disappears.
 */
function DeviceSection({
	deviceOpts,
	deviceValue,
	gpuAvailable,
	t,
	update,
}: {
	deviceOpts: SwitcherOption<DeviceValue>[];
	deviceValue: DeviceValue;
	gpuAvailable: boolean;
	t: TFn;
	update: UpdateModelFn;
}): ReactNode {
	return (
		<SettingSection description={t("deviceSectionCaption")} icon={CpuIcon} title={t("device")}>
			<FormControl
				caption={gpuAvailable ? t("deviceCaptionGpu") : t("deviceCaptionNoGpu")}
				layout="row"
			>
				<ElevatedSurface className="w-52">
					<Switcher
						fullWidth
						onChange={(v) => update({ device: v })}
						options={deviceOpts}
						value={deviceValue}
					/>
				</ElevatedSurface>
			</FormControl>
		</SettingSection>
	);
}

interface RealtimeModelSectionProps {
	catalogLoaded: boolean;
	catalogModels: CatalogModels;
	currentQuantization: OnnxQuantization;
	/** Same shape as MainModelSection — drives the realtime trigger's
	 *  download-aware variant when a realtime swap is in flight. */
	downloadProgress: { modelId: string; percent: number | null } | null;
	handleRealtimeModelChange: (modelId: string, quantization?: OnnxQuantization) => void;
	isSwapping: boolean;
	/** True when the main model is itself small enough for live-preview
	 *  transcription. In that state the dedicated realtime slot is force-bound
	 *  to the main model (a separate small model would just duplicate work),
	 *  so the picker becomes informational. */
	lockedToMainModel: boolean;
	mainModelId: string;
	/** Forwarded to the picker — same handler the main picker uses. */
	onDeleteQuant: (modelId: string, quantization: OnnxQuantization) => void;
	/** Forwarded to the picker — per-quant download action. */
	onDownloadAction: (
		action: "start" | "pause" | "resume" | "cancel",
		modelId: string,
		quantization: OnnxQuantization
	) => void;
	/** Forwarded to the picker — per-quant download snapshot lookup. */
	onDownloadSnapshot: (
		modelId: string,
		quantization: OnnxQuantization
	) => import("@/features/model-download").QuantDownloadState | undefined;
	onUseMainModel: () => void;
	quality: QualitySettings | undefined;
	settings: ModelSettings | undefined;
	statesById: StatesById;
	systemInfo: SystemInfo;
	t: TFn;
	updateQuality: UpdateQualityFn;
}

// Always rendered when the parent decides realtime is on — there is no
// on/off toggle here anymore. The realtime engine's lifecycle is derived
// from `general.liveTranscriptionDisplay` (see `isRealtimeEnabled`); without
// a display surface the engine wouldn't have any observable output, so the
// section itself is gated by the parent instead.
function RealtimeModelSection({
	t,
	settings,
	quality,
	updateQuality,
	catalogModels,
	catalogLoaded,
	statesById,
	systemInfo,
	currentQuantization,
	downloadProgress,
	isSwapping,
	handleRealtimeModelChange,
	mainModelId,
	onDeleteQuant,
	onDownloadAction,
	onDownloadSnapshot,
	onUseMainModel,
	lockedToMainModel,
}: RealtimeModelSectionProps): ReactNode {
	// The dedicated realtime picker stays interactive at all times so the user
	// can always pick a different realtime model. The "Use Main Model" affordance
	// is the trailing button on the picker's header.
	//
	// Exception: when `lockedToMainModel` is set, the main model is itself
	// realtime-viable so we force the realtime slot to mirror it and disable
	// the picker — a separate small model would just duplicate work without
	// adding any quality. The label shows an info tooltip explaining why.
	const realtimeModelId = settings?.realtimeModel ?? "tiny";
	const modelsMatch = realtimeModelId === mainModelId;
	const trailing = lockedToMainModel ? (
		<InfoTooltip content={t("realtimeLockedToMainTooltip")} />
	) : (
		<Tooltip content={t("useMainModelTooltip")}>
			<Button
				className="rounded-md bg-transparent px-1.5 py-0.5 font-medium text-2xs text-foreground-muted leading-none ring-1 ring-divider-strong ring-inset transition-colors hover:not-disabled:bg-surface-2 hover:not-disabled:text-foreground"
				disabled={modelsMatch}
				onClick={onUseMainModel}
			>
				{t("useMainModel")}
			</Button>
		</Tooltip>
	);
	return (
		<SettingSection icon={AiMagicIcon} title={t("realtimeModelSection")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<div className="col-span-2">
					<FormControl
						caption={
							lockedToMainModel ? t("realtimeLockedToMainCaption") : t("realtimeModelCaption")
						}
						disabled={lockedToMainModel}
						label={t("realtimeModel")}
						labelTrailing={trailing}
						tooltip={t("realtimeModelTooltip")}
					>
						<SttModelSelector
							currentQuantization={currentQuantization}
							disabled={lockedToMainModel}
							downloadProgress={downloadProgress}
							isLoading={!catalogLoaded || isSwapping}
							kind="realtime"
							models={catalogModels}
							onChange={handleRealtimeModelChange}
							onDeleteQuant={onDeleteQuant}
							onDownloadAction={onDownloadAction}
							onDownloadSnapshot={onDownloadSnapshot}
							prefilter={isRealtimeViable}
							statesById={statesById}
							systemInfo={systemInfo}
							value={realtimeModelId}
						/>
					</FormControl>
				</div>
				<FormControl
					label={t("updateInterval")}
					labelTrailing={
						<SettingResetButton
							isDefault={
								(quality?.realtimeProcessingPause ??
									DEFAULT_SETTINGS.quality.realtimeProcessingPause) ===
								DEFAULT_SETTINGS.quality.realtimeProcessingPause
							}
							onReset={() =>
								updateQuality({
									realtimeProcessingPause: DEFAULT_SETTINGS.quality.realtimeProcessingPause,
								})
							}
						/>
					}
					layout="row"
					tooltip={t("updateIntervalTooltip")}
				>
					<ElevatedSurface className="w-fit" inline>
						<NumberStepper
							min={0.01}
							onChange={(v) => updateQuality({ realtimeProcessingPause: v })}
							step={0.01}
							value={
								quality?.realtimeProcessingPause ?? DEFAULT_SETTINGS.quality.realtimeProcessingPause
							}
						/>
					</ElevatedSurface>
				</FormControl>
			</div>
		</SettingSection>
	);
}

// Auto-detect has an empty code; everything else uses the ISO 639-1/2 code
// uppercased as a short visual badge (e.g. "en" → "EN", "yue" → "YUE").
function languageBadge(code: string): string {
	return code === "" ? "AUTO" : code.toUpperCase();
}
const ALL_LANG_OPTS: SelectOption[] = LANGUAGES.map((l) => ({
	id: l.code,
	label: l.name,
	badge: languageBadge(l.code),
}));
function buildDeviceOpts(t: TFn, gpuAvailable: boolean): SwitcherOption<DeviceValue>[] {
	const cpu: SwitcherOption<DeviceValue> = {
		value: "cpu",
		label: t("deviceCpuLabel"),
		icon: CpuIcon,
	};
	if (!gpuAvailable) {
		return [cpu];
	}
	return [{ value: "auto", label: t("deviceAutoLabel"), icon: AiSettingIcon }, cpu];
}

type TtsSettings = SettingsStoreState["settings"]["tts"];
type ElevenIntegration = SettingsStoreState["settings"]["integrations"]["elevenlabs"];

/** Whether local Kokoro TTS is the active synthesis source. It rides on the
 *  Model-tab compute device (`model.device` → `--tts-device`), so the Device
 *  control must survive a cloud STT selection while this is true. Mirrors
 *  TtsModelSection's effective-source gate (cloud needs a present + verified
 *  ElevenLabs key, else it falls back to local). */
function isLocalTtsActive(tts: TtsSettings | undefined, elevenlabs: ElevenIntegration): boolean {
	const cloudEffective =
		(tts?.source ?? "local") === "cloud" &&
		elevenlabs.apiKey.trim().length > 0 &&
		elevenlabs.verified === true;
	return (tts?.enabled ?? false) && !cloudEffective;
}

interface ModelControlVisibility {
	showDevice: boolean;
	showLanguage: boolean;
	showUnloadTimeout: boolean;
}

/** Which Model-tab controls stay visible for the active main model. A cloud
 *  main hides the STT-local knobs: language (the provider owns it) and
 *  idle-unload-timeout (no local session to unload). `showDevice` is different —
 *  it gates the STANDALONE {@link DeviceSection}, not an STT sub-control, and is
 *  true whenever ANY local model needs a device: a local STT main OR local
 *  Kokoro TTS (both share `model.device`). It only disappears when STT and TTS
 *  are both cloud. A single-language local model also hides language
 *  (auto-detect + one language is a no-op choice). */
function resolveModelControlVisibility(
	selectedIsCloud: boolean,
	supportedLanguages: readonly string[] | undefined,
	localTtsActive: boolean
): ModelControlVisibility {
	return {
		showLanguage: !selectedIsCloud && supportedLanguages?.length !== 1,
		showDevice: !selectedIsCloud || localTtsActive,
		showUnloadTimeout: !selectedIsCloud,
	};
}

interface SwapDialogsProps {
	controller: SwapController;
	getModel: ReturnType<typeof useCatalogStore.getState>["getModel"];
	statesById: StatesById;
	systemInfo: SystemInfo;
	t: TFn;
}

/** Thin composition of the two model-swap gates (download confirmation +
 *  resource warning). Rendered by every surface that drives a swap so the
 *  modals appear regardless of which picker the user touched. */
function SwapDialogs({
	controller,
	getModel,
	statesById,
	systemInfo,
	t,
}: SwapDialogsProps): ReactNode {
	const { pendingDownload, pendingFitWarning, setPendingFitWarning } = controller;
	return (
		<>
			<DownloadConfirmationDialog
				getModel={getModel}
				onCancel={controller.cancelPendingDownload}
				pending={pendingDownload}
				statesById={statesById}
				systemInfo={systemInfo}
			/>
			<ResourceWarningDialog
				assessment={pendingFitWarning?.assessment ?? null}
				cancelLabel={t("resourceWarning.cancel")}
				candidateName={pendingFitWarning?.candidateName ?? ""}
				confirmLabel={t("resourceWarning.proceedAnyway")}
				kind="dictation"
				onCancel={() => setPendingFitWarning(null)}
				onConfirm={() => {
					const next = pendingFitWarning?.next;
					setPendingFitWarning(null);
					if (next) {
						next();
					}
				}}
				onOpenChange={(open) => {
					if (!open) {
						setPendingFitWarning(null);
					}
				}}
				open={pendingFitWarning !== null}
				t={(key, vars) => t(`resourceWarning.${key}` as Parameters<typeof t>[0], vars)}
			/>
		</>
	);
}

/**
 * Speaker diarization, copied verbatim from the General-settings panel (it now
 * lives on the Model tab — the recognition engine — instead of General). The
 * parent gates it to render only in Listen mode (`general.recordingMode ===
 * 'listen'`), matching the original gate.
 *
 * Diarization is toggled at runtime (no server restart). The server pushes
 * started/completed/failed; `useDiarizationToggleStore` tracks the in-flight
 * window. Driven purely by broadcast IPC so it works in the settings window (its
 * own BrowserWindow, no connection store there). The optimistic-revert on
 * failure is performed in the toggle-store's IPC listener
 * (`diarization-toggle-store.ts`) so the failure handler owns the lifecycle
 * directly — no effect-in-render needed here.
 *
 * The persisted key (`general.speakerDiarization`) stays in the `general` slice
 * and is read/written via `updateGeneralSettings` — only the visual home moved.
 */
function SpeakerDiarizationSection(): ReactNode {
	const tGeneral = useTranslations("general");
	const enabled = useSettingsStore((s) => s.settings.general?.speakerDiarization ?? false);
	const update = useSettingsStore((s) => s.updateGeneralSettings);
	const pending = useDiarizationToggleStore((s) => s.pending);

	return (
		<SettingSection icon={UserMultiple02Icon} title={tGeneral("speakerDiarization")}>
			<FormControl
				label={tGeneral("speakerDiarization")}
				labelAddon={
					<div className="flex items-center gap-2">
						{pending ? (
							<Spinner
								aria-label={tGeneral("speakerDiarization")}
								className="size-3.5 text-foreground-muted"
							/>
						) : null}
						<Toggle
							aria-label={tGeneral("speakerDiarization")}
							checked={enabled}
							disabled={pending}
							onCheckedChange={(v) => update({ speakerDiarization: v })}
						/>
					</div>
				}
				labelTrailing={
					<SettingResetButton
						isDefault={enabled === DEFAULT_SETTINGS.general.speakerDiarization}
						onReset={() =>
							update({ speakerDiarization: DEFAULT_SETTINGS.general.speakerDiarization })
						}
					/>
				}
				tooltip={tGeneral("speakerDiarizationTooltip")}
			/>
		</SettingSection>
	);
}

export function ModelSettingsPanel() {
	const settings = useSettingsStore((s) => s.settings.model);
	const update = useSettingsStore((s) => s.updateModelSettings);
	const quality = useSettingsStore((s) => s.settings.quality);
	const updateQuality = useSettingsStore((s) => s.updateQualitySettings);
	// Whether the LLM dictation "Translate" modifier is currently enabled — a
	// boolean selector so the panel only re-renders when it flips (not on every
	// preset edit). Drives the STT-translate ↔ LLM-translate lock below.
	const llmTranslateEnabled = useSettingsStore((s) =>
		s.settings.llm.dictation.presets.some((p) => p.key === "translate")
	);
	// Local Kokoro TTS shares the Model-tab compute device (mirrored onto the
	// server's `--tts-device`), so the Device control must survive a cloud STT
	// selection while local TTS is still running. `tts` + the ElevenLabs key
	// status mirror TtsModelSection's effective-source gate.
	const tts = useSettingsStore((s) => s.settings.tts);
	const elevenlabs = useSettingsStore((s) => s.settings.integrations.elevenlabs);
	const recordingMode = useSettingsStore((s) => s.settings.general?.recordingMode ?? "ptt");
	const isListenMode = recordingMode === "listen";
	const showRecordingOverlay = useSettingsStore(
		(s) => s.settings.general?.showRecordingOverlay ?? true
	);
	const liveTranscriptionDisplay = useSettingsStore(
		(s) => s.settings.general?.liveTranscriptionDisplay ?? "both"
	);
	// Realtime is fully derived from the display picker — the engine has no
	// observable output without a display surface, so there is no separate
	// on/off toggle. The realtime section here is hidden when this is false.
	const realtimeEnabled = isRealtimeEnabled({
		showRecordingOverlay,
		liveTranscriptionDisplay,
	});
	const gpuInfo = useConnectionStore((s) => s.gpuInfo);
	const gpuAvailable = gpuInfo.length > 0;
	const t = useTranslations("model");
	const deviceOpts = buildDeviceOpts(t, gpuAvailable);
	const deviceValue: DeviceValue = gpuAvailable ? (settings?.device ?? "auto") : "cpu";

	const catalogModels = useCatalogStore((s) => s.models);
	const catalogLoaded = useCatalogStore((s) => s.isLoaded);
	const getModel = useCatalogStore((s) => s.getModel);

	// Model-state store — drives the inline cache badges and the ⚠ icon
	// in the dropdown labels. Refresh on mount so the server gets re-probed
	// each time the settings panel opens; live updates come through the
	// store's IPC subscriptions (model_cache_changed / swap_completed).
	const statesById = useModelStateStore((s) => s.statesById);
	const systemInfo = useModelStateStore((s) => s.systemInfo);
	const refreshModelState = useModelStateStore((s) => s.refresh);
	// Live download + swap snapshot lives in its own hook so the panel stays
	// at a reasonable cognitive-complexity score.
	const { downloadProgress, mainSwapping, realtimeSwapping } = useSwapProgress();

	// Live host resource snapshot (RAM available, free VRAM, CPU%) for the
	// resource-aware warning modal. Refreshed when the panel mounts.
	const refreshLive = useSystemResourcesStore((s) => s.refresh);

	useEffect(() => {
		refreshModelState();
		refreshLive();
	}, [refreshModelState, refreshLive]);

	// Stale-model fallback for both slots lives in its own hook.
	useStaleModelFallback(
		catalogLoaded,
		catalogModels,
		statesById,
		settings?.model,
		settings?.realtimeModel,
		update
	);

	// Fallback matches the bundled offline base seeded into the HF cache by
	// PyInstaller (see `seed_models.py` + `project_offline_base_and_tts_pack`
	// memory). The legacy "large-v2" fallback resolved to a catalog id the
	// picker no longer surfaces and produced a desync between the main
	// window header ("large-v2") and the picker selection (vosk-russian as
	// the first catalog row).
	const selectedModel = settings?.model ?? "tiny";
	const selectedIsCloud = providerOf(selectedModel) !== null;
	const selectedInfo = selectedIsCloud ? undefined : getModel(selectedModel);
	// Remember the active local model so flipping the source switch Cloud→Local
	// restores the user's last choice instead of resetting to the catalog
	// default. Only local ids are recorded — a cloud selection delegates to the
	// provider and must not overwrite the remembered local pick.
	useEffect(() => {
		if (!selectedIsCloud) {
			recordLastLocalSttModel(selectedModel);
		}
	}, [selectedIsCloud, selectedModel]);
	// Translate-to-English is honored on multilingual Whisper exports
	// (via the ``<|translate|>`` prompt token) AND on NeMo Canary (via
	// the ``target_language`` recognize kwarg). Anything else silently
	// no-ops server-side, so we hide the toggle there to avoid lying
	// to the user. ``.en`` Whisper variants are filtered by the
	// language-detection capability — they advertise English only and
	// have no need for translate-to-English. We likewise hide it when the
	// user pins the source language to English: an en→en translate pass is
	// a no-op, so the toggle would be just as misleading there.
	const translateSupported =
		!selectedIsCloud &&
		selectedInfo !== undefined &&
		supportsTranslateToEnglish(selectedInfo) &&
		(settings?.language ?? "en") !== "en";
	// The free-text initial_prompt field shows only for models that actually
	// read the slot (Whisper + Lite-Whisper); every other engine's prompt slot
	// is absent or untrained. Cloud STT delegates to the provider, so it's
	// hidden there too (same rule as the device / language / translate knobs).
	const initialPromptSupported =
		!selectedIsCloud && selectedInfo !== undefined && supportsInitialPrompt(selectedInfo);
	// When the STT decoder itself translates to English, force the LLM dictation
	// "Translate" modifier off so the transcript isn't translated twice. The LLM
	// panel additionally disables the row while this holds.
	useLockLlmTranslate(
		translateSupported && (settings?.translateToEnglish ?? false),
		llmTranslateEnabled
	);
	const currentQuantization = (settings?.onnxQuantization ?? "") as OnnxQuantization;

	const supportedLanguages = selectedInfo?.languages;
	const langOpts =
		!supportedLanguages || supportedLanguages.length === 0
			? ALL_LANG_OPTS
			: ALL_LANG_OPTS.filter((l) => l.id === "" || supportedLanguages.includes(l.id));
	// Which Model-tab controls stay visible. A cloud main hides the local-only
	// knobs (language, idle-unload-timeout, device) — except Device, which
	// local Kokoro TTS also rides on (`model.device` → `--tts-device`). The
	// derivation lives in pure helpers to keep this component under the
	// cognitive-complexity cap.
	const { showDevice, showLanguage, showUnloadTimeout } = resolveModelControlVisibility(
		selectedIsCloud,
		supportedLanguages,
		isLocalTtsActive(tts, elevenlabs)
	);

	// Block model switching while files are transcribing — the swap would reload
	// the shared transcriber mid-queue. The detached picker also disables its
	// selector; Electron main enforces the same block as a final safety net.
	const controller = useModelSwapController(
		settings,
		selectedModel,
		currentQuantization,
		deviceValue,
		getModel,
		statesById,
		update,
		isQuantDownloading,
		() => useFileTranscriptionStore.getState().queueActive
	);

	const useMainModelFlag = quality?.useMainModelForRealtime ?? false;
	const handleUseMainModel = () => {
		// Mirror the main model into the realtime slot. The controller no-ops when
		// the ids already match, so this is safe to call unconditionally. Also flip
		// the server flag so the realtime worker actually reuses the loaded main
		// transcriber instead of loading a duplicate.
		controller.handleRealtimeModelChange(selectedModel);
		if (!useMainModelFlag) {
			updateQuality({ useMainModelForRealtime: true });
		}
	};
	const handleRealtimePick = (v: string, quantization?: OnnxQuantization) => {
		controller.handleRealtimeModelChange(v, quantization);
		// Picking a model that is NOT the main model means the user wants a
		// separate realtime model — clear the server flag so it actually loads.
		if (v !== selectedModel && useMainModelFlag) {
			updateQuality({ useMainModelForRealtime: false });
		}
	};

	// Per-quant badge handlers (delete + byte-level pause/resume/cancel) live
	// in one shared feature-layer hook so the settings panel and the detached
	// footer picker wire the exact same controls into SttModelSelector.
	const { handleDeleteQuant, handleDownloadAction, handleDownloadSnapshot } = useQuantActions();

	// When the active main model is itself small enough to drive the live
	// preview, the dedicated realtime slot has no job — a second small model
	// would just duplicate work without improving quality.
	const mainIsRealtimeViable =
		!selectedIsCloud && selectedInfo !== undefined && isRealtimeViable(selectedInfo);
	const lockRealtimeToMain = realtimeEnabled && mainIsRealtimeViable;
	useLockRealtimeToMain(
		lockRealtimeToMain,
		selectedModel,
		settings?.realtimeModel,
		useMainModelFlag,
		controller.handleRealtimeModelChange,
		updateQuality
	);

	return (
		<div className="flex flex-col gap-2">
			{isListenMode ? null : (
				<MainModelSection
					catalogLoaded={catalogLoaded}
					catalogModels={catalogModels}
					currentQuantization={currentQuantization}
					downloadProgress={downloadProgress}
					handleModelChange={controller.handleModelChange}
					initialPromptSupported={initialPromptSupported}
					isSwapping={mainSwapping}
					langOpts={langOpts}
					onDeleteQuant={handleDeleteQuant}
					onDownloadAction={handleDownloadAction}
					onDownloadSnapshot={handleDownloadSnapshot}
					sections={{
						language: showLanguage,
						unloadTimeout: showUnloadTimeout,
					}}
					selectedModel={selectedModel}
					settings={settings}
					statesById={statesById}
					systemInfo={systemInfo}
					t={t}
					translateSupported={translateSupported}
					update={update}
				/>
			)}
			{realtimeEnabled && !selectedIsCloud && (
				<RealtimeModelSection
					catalogLoaded={catalogLoaded}
					catalogModels={catalogModels}
					currentQuantization={currentQuantization}
					downloadProgress={downloadProgress}
					handleRealtimeModelChange={handleRealtimePick}
					isSwapping={realtimeSwapping}
					lockedToMainModel={lockRealtimeToMain}
					mainModelId={selectedModel}
					onDeleteQuant={handleDeleteQuant}
					onDownloadAction={handleDownloadAction}
					onDownloadSnapshot={handleDownloadSnapshot}
					onUseMainModel={handleUseMainModel}
					quality={quality}
					settings={settings}
					statesById={statesById}
					systemInfo={systemInfo}
					t={t}
					updateQuality={updateQuality}
				/>
			)}
			{/* Compute device — standalone, shared by local STT + local TTS.
			    Shown whenever any local model needs a device (`showDevice`);
			    hidden only when STT and TTS are both cloud. Rendered outside the
			    STT/TTS sections so it doesn't read as belonging to either. */}
			{showDevice && (
				<DeviceSection
					deviceOpts={deviceOpts}
					deviceValue={deviceValue}
					gpuAvailable={gpuAvailable}
					t={t}
					update={update}
				/>
			)}
			{/* Speaker diarization — gated to Listen mode (plain cross-tab read of
			    `general.recordingMode`), matching the original General-tab gate.
			    Persists to `general.speakerDiarization`; the runtime toggle wiring
			    lives in the diarization toggle store. */}
			{isListenMode ? <SpeakerDiarizationSection /> : null}
			<SwapDialogs
				controller={controller}
				getModel={getModel}
				statesById={statesById}
				systemInfo={systemInfo}
				t={t}
			/>
		</div>
	);
}
