import {
	EyeIcon,
	SparklesIcon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import { useState } from "react";
import { useTranslations } from "use-intl";
import {
	getModelAssistance,
	getModelNativeFormatting,
	type ModelNativeFormatting,
	type ModelNativeFormattingKey,
	type ModelAssistance,
	useCatalogStore,
} from "@/entities/model-catalog";
import {
	DEFAULT_SETTINGS,
	type GeneralSettings,
	type GeneralT,
	type QualitySettings,
	SettingField,
	SettingSection,
	type UpdateQualityFn,
	useSettingsStore,
} from "@/entities/setting";
import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import { OptInDialog } from "@/shared/ui/opt-in-dialog";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import { ContextAllowedAppsSection } from "./ContextAllowedAppsSection";
import { ContextDenyListSection } from "./ContextDenyListSection";

type LlmT = ReturnType<typeof useTranslations<"llm">>;
type ContextAppMode = NonNullable<GeneralSettings["contextAppMode"]>;
type FormattingOptionKey =
	| "formatBasicPunctuationCasing"
	| "formatSpokenPunctuationCommands"
	| "formatSpokenSymbolCommands"
	| "formatQuoteCommands"
	| "formatFillerRepeatCleanup";

interface FormattingOption {
	key: FormattingOptionKey;
	label: string;
	linkedKeys?: readonly FormattingOptionKey[];
	tooltip: string;
}

const FORMATTING_OPTIONS = [
	{
		key: "formatBasicPunctuationCasing",
		label: "Basic punctuation and casing",
		tooltip:
			"Only for raw STT output that lacks written-text punctuation/capitalization.",
	},
	{
		key: "formatSpokenPunctuationCommands",
		linkedKeys: ["formatSpokenSymbolCommands"],
		label: "Spoken punctuation and code commands",
		tooltip:
			'Turns spoken punctuation, layout, and code commands such as "comma", "new line", "dash dash save", and "example dot com" into symbols.',
	},
	{
		key: "formatQuoteCommands",
		label: "Quote commands",
		tooltip:
			'Turns paired commands such as "quote Save changes unquote" into quoted text.',
	},
	{
		key: "formatFillerRepeatCleanup",
		label: "Fillers and repeated words",
		tooltip:
			'Removes exact fillers such as "um" and collapses adjacent duplicate words such as "the the".',
	},
] as const satisfies readonly FormattingOption[];
const LISTEN_MODE_PROCESSING_DISABLED_TOOLTIP =
	"Listen mode does not run post-processing; it only transcribes speaker audio inside the main app window.";

const NATIVE_FORMATTING_KEY_BY_SETTING = {
	formatBasicPunctuationCasing: "basicPunctuationCasing",
	formatFillerRepeatCleanup: "fillerRepeatCleanup",
	formatQuoteCommands: "quoteCommands",
	formatSpokenPunctuationCommands: "spokenPunctuationCommands",
	formatSpokenSymbolCommands: "spokenSymbolCommands",
} as const satisfies Record<FormattingOptionKey, ModelNativeFormattingKey>;

const NATIVE_FORMATTING_LABEL = {
	basicPunctuationCasing: "punctuation and casing",
	fillerRepeatCleanup: "filler/repeat cleanup",
	quoteCommands: "quote commands",
	spokenPunctuationCommands: "spoken punctuation commands",
	spokenSymbolCommands: "code and symbol commands",
} as const satisfies Record<ModelNativeFormattingKey, string>;

function formattingOptionKeys(
	option: FormattingOption,
): readonly FormattingOptionKey[] {
	return option.linkedKeys ? [option.key, ...option.linkedKeys] : [option.key];
}

function nativeFormattingKey(
	key: FormattingOptionKey,
): ModelNativeFormattingKey {
	return NATIVE_FORMATTING_KEY_BY_SETTING[key];
}

function needsDeterministicFormatting(
	key: FormattingOptionKey,
	nativeFormatting: ModelNativeFormatting,
): boolean {
	return !nativeFormatting[nativeFormattingKey(key)];
}

function formattingOptionNeedsDeterministicPass(
	option: FormattingOption,
	nativeFormatting: ModelNativeFormatting,
): boolean {
	return formattingOptionKeys(option).some((key) =>
		needsDeterministicFormatting(key, nativeFormatting),
	);
}

function deterministicFormattingKeys(
	option: FormattingOption,
	nativeFormatting: ModelNativeFormatting,
): readonly FormattingOptionKey[] {
	return formattingOptionKeys(option).filter((key) =>
		needsDeterministicFormatting(key, nativeFormatting),
	);
}

function formatList(labels: readonly string[]): string {
	if (labels.length <= 1) {
		return labels[0] ?? "";
	}
	if (labels.length === 2) {
		return `${labels[0]} and ${labels[1]}`;
	}
	return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

function nativeFormattingLabels(
	nativeFormatting: ModelNativeFormatting,
): string[] {
	return Object.entries(nativeFormatting).flatMap(([key, enabled]) =>
		enabled ? [NATIVE_FORMATTING_LABEL[key as ModelNativeFormattingKey]] : [],
	);
}

function optionNativeFormattingLabels(
	option: FormattingOption,
	nativeFormatting: ModelNativeFormatting,
): string[] {
	return formattingOptionKeys(option).flatMap((key) => {
		const nativeKey = nativeFormattingKey(key);
		return nativeFormatting[nativeKey]
			? [NATIVE_FORMATTING_LABEL[nativeKey]]
			: [];
	});
}

function formattingDefaultsPatch(): Partial<QualitySettings> {
	return {
		formatBasicPunctuationCasing:
			DEFAULT_SETTINGS.quality.formatBasicPunctuationCasing,
		formatSpokenPunctuationCommands:
			DEFAULT_SETTINGS.quality.formatSpokenPunctuationCommands,
		formatSpokenSymbolCommands:
			DEFAULT_SETTINGS.quality.formatSpokenSymbolCommands,
		formatQuoteCommands: DEFAULT_SETTINGS.quality.formatQuoteCommands,
		formatFillerRepeatCleanup:
			DEFAULT_SETTINGS.quality.formatFillerRepeatCleanup,
	};
}

function formattingAtDefault(
	quality: QualitySettings,
	nativeFormatting: ModelNativeFormatting,
): boolean {
	return FORMATTING_OPTIONS.every((option) =>
		formattingOptionKeys(option).every(
			(key) =>
				!needsDeterministicFormatting(key, nativeFormatting) ||
				quality[key] === DEFAULT_SETTINGS.quality[key],
		),
	);
}

const CONTEXT_APP_MODE_OPTIONS: readonly SwitcherOption<ContextAppMode>[] = [
	{
		value: "all-except-denied",
		label: "Black list",
	},
	{
		value: "selected-only",
		label: "Allow list",
	},
];

interface ContextAwarenessSectionProps {
	disabled?: boolean;
	disabledTooltip?: string | undefined;
	enabled: boolean;
	onCancel: () => void;
	onConfirm: () => void;
	tg: GeneralT;
}

export function ContextAwarenessSection({
	disabled = false,
	disabledTooltip,
	enabled,
	onCancel,
	onConfirm,
	tg,
}: ContextAwarenessSectionProps) {
	const general = useSettingsStore((s) => s.settings.general);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const [dialogOpen, setDialogOpen] = useState(false);
	// Bumped to ask the allowed-apps combobox to pop open (on switching into
	// selected-only mode, or when the user tries to turn the toggle on while
	// that mode still has no apps).
	const [appsOpenNonce, setAppsOpenNonce] = useState(0);
	const requestAppsOpen = (): void => setAppsOpenNonce((n) => n + 1);
	const contextAppMode =
		general?.contextAppMode ?? DEFAULT_SETTINGS.general.contextAppMode;
	const hasAllowedApps = (general?.contextAllowList?.length ?? 0) > 0;
	const screenOcr =
		general?.contextScreenOcr ?? DEFAULT_SETTINGS.general.contextScreenOcr;
	// "Allow list" (selected-only) mode captures nothing until the user picks an
	// app, so in that mode context awareness is genuinely on ONLY when the list
	// is non-empty. Rather than just faking the toggle's look (which left the
	// stored flag — and the backend — still "on", capturing window titles), we
	// keep the persisted `contextAwareness` honest: every mutation below sets it
	// to its true effective value. `selectedOnlyWithoutApps` is the dead state.
	const selectedOnlyWithoutApps =
		contextAppMode === "selected-only" && !hasAllowedApps;
	const effectiveEnabled = !disabled && enabled && !selectedOnlyWithoutApps;
	// The scope + app-list config stays reachable whenever the feature is on OR
	// we're in Allow-list mode (so the user can always get to the allow-list to
	// add an app and switch it back on). It greys out only when the feature is
	// fully off in Black-list mode.
	const configInteractive =
		!disabled && (enabled || contextAppMode === "selected-only");
	// Toggle ON ⇒ consent the first time, then the dialog's confirm path enables.
	// In the Allow-list dead state, "on" can't take effect with no apps, so we
	// surface the picker instead and let the first app flip the stored flag.
	// Toggle OFF ⇒ disable immediately.
	const handleToggle = (next: boolean): void => {
		if (disabled) {
			return;
		}
		if (!next) {
			onCancel();
			return;
		}
		if (!enabled) {
			setDialogOpen(true);
		} else if (selectedOnlyWithoutApps) {
			requestAppsOpen();
		}
	};
	// After consent: enable when the scope can actually capture (Black-list, or
	// Allow-list that already has apps). In the Allow-list dead state we hold off
	// enabling and open the picker — adding an app is what turns it on.
	const handleConfirm = (): void => {
		if (disabled) {
			return;
		}
		if (selectedOnlyWithoutApps) {
			requestAppsOpen();
			return;
		}
		onConfirm();
	};
	const handleScopeChange = (next: ContextAppMode): void => {
		if (disabled) {
			return;
		}
		if (next === "selected-only") {
			// Allow-list mode is enabled iff ≥1 app is already selected; otherwise
			// it stays off until the user picks one in the picker we open here.
			updateGeneral({ contextAppMode: next, contextAwareness: hasAllowedApps });
			requestAppsOpen();
			return;
		}
		// Black-list mode always functions, so engaging it (re)enables the feature.
		updateGeneral({ contextAppMode: next, contextAwareness: true });
	};
	return (
		<SettingSection
			boxed
			headerAction={
				<Toggle
					checked={effectiveEnabled}
					disabled={disabled}
					onCheckedChange={handleToggle}
				/>
			}
			icon={EyeIcon}
			title={tg("contextAwarenessSection")}
			tooltip={tg("contextAwarenessTooltip")}
		>
			{/* The enable toggle is on the section header (above); the body is the
			    scope + deny/allow-list config. It keeps its OWN dim state rather
			    than the section's — the allow-list must stay reachable so the user
			    can add an app even while the feature reads as off. */}
			<div
				className={cn(
					"flex flex-col divide-y divide-divider transition-opacity duration-200 ease-out",
					!configInteractive && "settings-dim pointer-events-none",
				)}
			>
				<SettingField
					disabled={disabled}
					disabledTooltip={disabledTooltip}
					hideReset={disabled}
					isDefault={contextAppMode === DEFAULT_SETTINGS.general.contextAppMode}
					label="Context scope"
					layout="row"
					onReset={() =>
						updateGeneral({
							contextAppMode: DEFAULT_SETTINGS.general.contextAppMode,
						})
					}
					tooltip="Choose whether context awareness can read every app except blocked entries, or only apps you select."
				>
					<Switcher
						className="w-52"
						fullWidth
						onChange={handleScopeChange}
						options={CONTEXT_APP_MODE_OPTIONS}
						value={contextAppMode}
					/>
				</SettingField>
				{/* Tier-2 OCR fallback (report R3). Opt-in, default off: when context
				    capture finds no text via accessibility (canvas apps, remote
				    desktops, games), WinSTT screenshots the window and reads it with
				    on-device OCR. The recognized text never leaves the machine. */}
				<SettingField
					caption={tg("contextScreenOcrCaption")}
					disabled={disabled}
					disabledTooltip={disabledTooltip}
					hideReset={disabled}
					isDefault={screenOcr === DEFAULT_SETTINGS.general.contextScreenOcr}
					label={tg("contextScreenOcr")}
					labelAddon={
						<Toggle
							checked={screenOcr}
							disabled={disabled}
							onCheckedChange={(v) => updateGeneral({ contextScreenOcr: v })}
						/>
					}
					onReset={() =>
						updateGeneral({
							contextScreenOcr: DEFAULT_SETTINGS.general.contextScreenOcr,
						})
					}
					tooltip={tg("contextScreenOcrTooltip")}
				/>
				{contextAppMode === "selected-only" ? (
					<ContextAllowedAppsSection
						initialOpen={appsOpenNonce > 0}
						key={appsOpenNonce}
					/>
				) : (
					<ContextDenyListSection />
				)}
			</div>
			<OptInDialog
				body={tg("contextAwarenessDialogBody")}
				cancelLabel={tg("contextAwarenessDialogCancel")}
				confirmLabel={tg("contextAwarenessDialogConfirm")}
				onCancel={onCancel}
				onConfirm={handleConfirm}
				onOpenChange={setDialogOpen}
				open={dialogOpen}
				title={tg("contextAwarenessDialogTitle")}
			/>
		</SettingSection>
	);
}

function modelAssistanceCaption(
	t: LlmT,
	item: ModelAssistance,
	modelName: string,
): string {
	const values = { model: modelName };
	switch (item.reason) {
		case "ctc":
			return t("modelAssistanceCleanupCtc", values);
		case "raw":
			return t("modelAssistanceCleanupRaw", values);
		case "streaming":
			return t("modelAssistanceCleanupStreaming", values);
		case "transducer":
			return t("modelAssistanceCleanupTransducer", values);
		case "verbatim":
			return t("modelAssistanceCleanupVerbatim", values);
	}
}

function ModelAssistanceSection({
	assistance,
	cleanupEnabled,
	disabled = false,
	disabledTooltip,
	modelName,
	t,
}: {
	assistance: readonly ModelAssistance[];
	cleanupEnabled: boolean;
	disabled?: boolean;
	disabledTooltip?: string | undefined;
	modelName: string;
	t: LlmT;
}) {
	const cleanupItem = assistance.find(
		(item) => item.kind === "dictationCleanup",
	);
	if (!cleanupItem) {
		return null;
	}
	const effectiveCleanupEnabled = disabled ? false : cleanupEnabled;
	const setupSuffix = effectiveCleanupEnabled
		? ""
		: ` ${t("modelAssistanceCleanupNeedsModel")}`;
	return (
		<SettingSection
			boxed
			divided
			icon={SparklesIcon}
			title={t("modelAssistanceTitle")}
			tooltip={t("modelAssistanceTooltip")}
		>
			<SettingField
				caption={`${modelAssistanceCaption(t, cleanupItem, modelName)}${setupSuffix}`}
				disabled={disabled}
				disabledTooltip={disabledTooltip}
				label={t("modelAssistanceCleanup")}
				labelAddon={
					<Badge variant={effectiveCleanupEnabled ? "secondary" : "outline"}>
						{effectiveCleanupEnabled
							? t("modelAssistanceAutoBadge")
							: t("modelAssistanceSetupBadge")}
					</Badge>
				}
				tooltip={t("modelAssistanceCleanupTooltip")}
			/>
		</SettingSection>
	);
}

function DeterministicFormattingSection({
	activeModelName,
	disabled = false,
	disabledTooltip,
	nativeFormatting,
	quality,
	updateQuality,
}: {
	activeModelName: string;
	disabled?: boolean;
	disabledTooltip?: string | undefined;
	nativeFormatting: ModelNativeFormatting;
	quality: QualitySettings;
	updateQuality: UpdateQualityFn;
}) {
	const allFormattingNative = FORMATTING_OPTIONS.every(
		(option) =>
			!formattingOptionNeedsDeterministicPass(option, nativeFormatting),
	);
	const fieldDisabled = disabled || allFormattingNative;
	const fullNativeReason = `${activeModelName} already handles every formatting rule here.`;
	const nativeLabels = nativeFormattingLabels(nativeFormatting);
	const caption = disabled
		? LISTEN_MODE_PROCESSING_DISABLED_TOOLTIP
		: allFormattingNative
			? fullNativeReason
			: nativeLabels.length > 0
				? `${activeModelName} already handles ${formatList(nativeLabels)}. Choose any remaining deterministic rules WinSTT should run.`
				: "Choose which deterministic formatting rules run after speech recognition.";
	const checkedIndices = new Set<number>();
	FORMATTING_OPTIONS.forEach((option, index) => {
		const deterministicKeys = deterministicFormattingKeys(
			option,
			nativeFormatting,
		);
		const checked =
			!fieldDisabled &&
			deterministicKeys.length > 0 &&
			deterministicKeys.every((key) => quality[key]);
		if (checked) {
			checkedIndices.add(index);
		}
	});

	const setOption = (option: FormattingOption, next: boolean): void => {
		if (fieldDisabled) {
			return;
		}
		const patch: Partial<QualitySettings> = {};
		for (const key of deterministicFormattingKeys(option, nativeFormatting)) {
			patch[key] = next;
		}
		updateQuality(patch);
	};

	return (
		<SettingSection
			boxed
			divided
			icon={TextFontIcon}
			title="Formatting"
			tooltip="Local rule-based cleanup that runs after speech recognition and before any LLM cleanup."
		>
			<SettingField
				caption={caption}
				disabled={fieldDisabled}
				disabledTooltip={
					disabled
						? disabledTooltip
						: allFormattingNative
							? fullNativeReason
							: undefined
				}
				hideReset={fieldDisabled}
				isDefault={formattingAtDefault(quality, nativeFormatting)}
				label="Rules"
				onReset={() => updateQuality(formattingDefaultsPatch())}
				tooltip="Local formatting rules that run before any LLM cleanup."
			>
				<CheckboxGroup
					checkedIndices={checkedIndices}
					className="w-full"
					framed
				>
					{FORMATTING_OPTIONS.map((option, index) => {
						const deterministicKeys = deterministicFormattingKeys(
							option,
							nativeFormatting,
						);
						const checked =
							!fieldDisabled &&
							deterministicKeys.length > 0 &&
							deterministicKeys.every((key) => quality[key]);
						const optionNeedsFormatting = deterministicKeys.length > 0;
						const optionDisabled = fieldDisabled || !optionNeedsFormatting;
						const nativeReason = optionNeedsFormatting
							? undefined
							: `${activeModelName} already handles ${formatList(
									optionNativeFormattingLabels(option, nativeFormatting),
								)}, so WinSTT skips this deterministic pass.`;
						const tooltip =
							optionDisabled && disabledTooltip
								? disabledTooltip
								: optionDisabled && nativeReason
									? nativeReason
									: option.tooltip;
						return (
							<CheckboxItem
								checked={checked}
								disabled={optionDisabled}
								index={index}
								key={option.key}
								label={option.label}
								onToggle={() => setOption(option, !checked)}
								tooltip={tooltip}
							/>
						);
					})}
				</CheckboxGroup>
			</SettingField>
		</SettingSection>
	);
}

/**
 * Extra controls that are NOT the LLM provider config. Renders after
 * `LlmSettingsPanel` on the Processing tab: model-specific assistance,
 * deterministic formatting, and Context awareness (+ deny-list).
 */
export function ProcessingExtrasPanel() {
	const general = useSettingsStore((s) => s.settings.general);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const quality = useSettingsStore((s) => s.settings.quality);
	const updateQuality = useSettingsStore((s) => s.updateQualitySettings);
	const llmDictationEnabled = useSettingsStore(
		(s) => s.settings.llm?.dictation?.enabled ?? false,
	);
	// Context awareness has two consumers (see relay-context-capture):
	//   1. ASR-side: Whisper-only via `<|startofprev|>`. Canary / Cohere
	//      have a `<|startofcontext|>` slot but the released checkpoints
	//      aren't trained on it — empirical bench shows broken / truncated
	//      / hallucinated outputs (see memory note `canary-cohere-prompt-
	//      slot-untrained`). Moonshine / SenseVoice / CTC families have
	//      no prompt mechanism at all.
	//   2. LLM cleanup works for every engine when the dictation LLM runs.
	// So the section is meaningful when EITHER condition is met; if
	// neither is, the toggle does nothing — hide it.
	const activeSttModelId = useSettingsStore(
		(s) => s.settings.model?.model ?? "",
	);
	const activeSttModel = useCatalogStore((s) => s.getModel(activeSttModelId));
	const activeSttFamily = activeSttModel?.family;
	const activeModelName = activeSttModel?.displayName ?? activeSttModelId;
	const modelAssistance = getModelAssistance(activeSttModel);
	const modelAssistanceUseful = modelAssistance.length > 0;
	const nativeFormatting = getModelNativeFormatting(activeSttModel);
	const contextAwarenessUseful =
		activeSttFamily === "whisper" || llmDictationEnabled;
	const tg = useTranslations("general");
	const tl = useTranslations("llm");

	const isListenMode = (general?.recordingMode ?? "ptt") === "listen";
	const listenModeDisabledTooltip = isListenMode
		? LISTEN_MODE_PROCESSING_DISABLED_TOOLTIP
		: undefined;
	const contextAwarenessEnabled = general?.contextAwareness ?? false;

	return (
		<div className="flex flex-col">
			{modelAssistanceUseful ? (
				<ModelAssistanceSection
					assistance={modelAssistance}
					cleanupEnabled={llmDictationEnabled}
					disabled={isListenMode}
					disabledTooltip={listenModeDisabledTooltip}
					modelName={activeModelName}
					t={tl}
				/>
			) : null}
			<DeterministicFormattingSection
				activeModelName={activeModelName || "The selected model"}
				disabled={isListenMode}
				disabledTooltip={listenModeDisabledTooltip}
				nativeFormatting={nativeFormatting}
				quality={quality}
				updateQuality={updateQuality}
			/>
			{/* ── Context Awareness ────────────────────────────
				 Shown only when at least one consumer can actually act on
				 the captured snapshot:
				   * ASR-side: active model is a Whisper variant (the only
				     family whose released checkpoints accept and respond
				     to prior-text prompts — see memory note
				     `canary-cohere-prompt-slot-untrained` for the bench
				     evidence on Canary / Cohere / Moonshine).
				   * LLM-side: dictation LLM is enabled (the cleanup pass
				     consumes context regardless of which ASR engine ran).
				 With neither condition met the toggle does nothing, so we
				 hide it instead of advertising a dead setting. */}
			{contextAwarenessUseful ? (
				<ContextAwarenessSection
					disabled={isListenMode}
					disabledTooltip={listenModeDisabledTooltip}
					enabled={contextAwarenessEnabled}
					onCancel={() => updateGeneral({ contextAwareness: false })}
					onConfirm={() => updateGeneral({ contextAwareness: true })}
					tg={tg}
				/>
			) : null}
		</div>
	);
}
