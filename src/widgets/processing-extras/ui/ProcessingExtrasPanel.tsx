import {
	EyeIcon,
	SparklesIcon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import { useState } from "react";
import { useTranslations } from "use-intl";
import {
	getModelAssistance,
	modelHasNativeBasicFormatting,
	type ModelAssistance,
	useCatalogStore,
} from "@/entities/model-catalog";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { OptInDialog } from "@/shared/ui/opt-in-dialog";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import { ContextAllowedAppsSection } from "./ContextAllowedAppsSection";
import { ContextDenyListSection } from "./ContextDenyListSection";

type GeneralSettings = NonNullable<
	ReturnType<typeof useSettingsStore.getState>["settings"]["general"]
>;
type QualitySettings = NonNullable<
	ReturnType<typeof useSettingsStore.getState>["settings"]["quality"]
>;
type UpdateQualityFn = (patch: Partial<QualitySettings>) => void;

type GeneralT = ReturnType<typeof useTranslations<"general">>;
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

function formattingOptionKeys(
	option: FormattingOption,
): readonly FormattingOptionKey[] {
	return option.linkedKeys ? [option.key, ...option.linkedKeys] : [option.key];
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

function formattingAtDefault(quality: QualitySettings): boolean {
	return FORMATTING_OPTIONS.every((option) =>
		formattingOptionKeys(option).every(
			(key) => quality[key] === DEFAULT_SETTINGS.quality[key],
		),
	);
}

const CONTEXT_APP_MODE_OPTIONS: readonly SwitcherOption<ContextAppMode>[] = [
	{
		value: "all-except-denied",
		label: "All apps except blocked",
	},
	{
		value: "selected-only",
		label: "Selected apps only",
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

function ContextAwarenessSection({
	disabled = false,
	disabledTooltip,
	enabled,
	onCancel,
	onConfirm,
	tg,
}: ContextAwarenessSectionProps) {
	const ts = useTranslations("settings");
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
	// Selected-only mode with an empty allow-list captures nothing, so the
	// "on + selected-only + no apps" combination is a dead state. We make it
	// unreachable by gating the toggle's visible on-state on having ≥1 app:
	// the toggle reads off until an app is chosen, then lights up on its own.
	const selectedOnlyWithoutApps =
		contextAppMode === "selected-only" && !hasAllowedApps;
	const effectiveEnabled = !disabled && enabled && !selectedOnlyWithoutApps;
	// Toggle ON ⇒ ask for consent the first time (the dialog's confirm path is
	// what flips the stored value); once consented, the only thing left to do in
	// selected-only mode is pick apps, so surface the picker instead of leaving a
	// dead toggle. Toggle OFF ⇒ persist immediately (no consent needed).
	const handleToggle = (next: boolean): void => {
		if (disabled) {
			return;
		}
		if (next) {
			if (!enabled) {
				setDialogOpen(true);
			} else if (selectedOnlyWithoutApps) {
				requestAppsOpen();
			}
			return;
		}
		onCancel();
	};
	// After consent, if we're in selected-only mode with no apps yet, open the
	// picker so the freshly-on toggle doesn't sit visibly off with nothing to do.
	const handleConfirm = (): void => {
		if (disabled) {
			return;
		}
		onConfirm();
		if (selectedOnlyWithoutApps) {
			requestAppsOpen();
		}
	};
	const handleScopeChange = (next: ContextAppMode): void => {
		if (disabled) {
			return;
		}
		updateGeneral({ contextAppMode: next });
		if (next === "selected-only") {
			requestAppsOpen();
		}
	};
	return (
		<SettingSection icon={EyeIcon} title={tg("contextAwarenessSection")}>
			<div className="flex flex-col">
				<SettingField
					disabled={disabled}
					disabledTooltip={
						disabled
							? disabledTooltip
							: effectiveEnabled
								? undefined
								: ts("disabledReason", { name: tg("contextAwareness") })
					}
					hideReset={disabled}
					isDefault={
						effectiveEnabled === DEFAULT_SETTINGS.general.contextAwareness
					}
					label={tg("contextAwareness")}
					labelAddon={
						<Toggle
							checked={effectiveEnabled}
							disabled={disabled}
							onCheckedChange={handleToggle}
						/>
					}
					onReset={onCancel}
					tooltip={tg("contextAwarenessTooltip")}
				/>
				{/* The deny-list (apps/sites to skip) configures the same capture
				    pipeline this toggle gates, so it lives directly beneath it —
				    shown disabled (not hidden) until context awareness is on. */}
				<div
					className={cn(
						"transition-opacity duration-200 ease-out",
						(disabled || !enabled) && "pointer-events-none opacity-40",
					)}
				>
					<SettingField
						disabled={disabled}
						disabledTooltip={disabledTooltip}
						hideReset={disabled}
						isDefault={
							contextAppMode === DEFAULT_SETTINGS.general.contextAppMode
						}
						label="Context scope"
						onReset={() =>
							updateGeneral({
								contextAppMode: DEFAULT_SETTINGS.general.contextAppMode,
							})
						}
						tooltip="Choose whether context awareness can read every app except blocked entries, or only apps you select."
					>
						<ElevatedSurface>
							<Switcher
								fullWidth
								onChange={handleScopeChange}
								options={CONTEXT_APP_MODE_OPTIONS}
								value={contextAppMode}
							/>
						</ElevatedSurface>
					</SettingField>
					{contextAppMode === "selected-only" ? (
						<ContextAllowedAppsSection
							initialOpen={appsOpenNonce > 0}
							key={appsOpenNonce}
						/>
					) : (
						<ContextDenyListSection />
					)}
				</div>
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
	nativeBasicFormatting,
	quality,
	updateQuality,
}: {
	activeModelName: string;
	disabled?: boolean;
	disabledTooltip?: string | undefined;
	nativeBasicFormatting: boolean;
	quality: QualitySettings;
	updateQuality: UpdateQualityFn;
}) {
	const basicEnabled =
		!disabled && quality.formatBasicPunctuationCasing && !nativeBasicFormatting;
	const basicDisabledReason = nativeBasicFormatting
		? `${activeModelName} already adds punctuation and casing`
		: undefined;
	const checkedIndices = new Set<number>();
	FORMATTING_OPTIONS.forEach((option, index) => {
		const checked =
			option.key === "formatBasicPunctuationCasing"
				? basicEnabled
				: !disabled &&
					formattingOptionKeys(option).every((key) => quality[key]);
		if (checked) {
			checkedIndices.add(index);
		}
	});

	const setOption = (option: FormattingOption, next: boolean): void => {
		if (disabled) {
			return;
		}
		const patch: Partial<QualitySettings> = {};
		for (const key of formattingOptionKeys(option)) {
			patch[key] = next;
		}
		updateQuality(patch);
	};

	return (
		<SettingSection
			divided
			icon={TextFontIcon}
			title="Formatting"
			tooltip="Local rule-based cleanup that runs after speech recognition and before any LLM cleanup."
		>
			<SettingField
				caption={
					disabled
						? LISTEN_MODE_PROCESSING_DISABLED_TOOLTIP
						: nativeBasicFormatting
							? `${activeModelName} provides this natively, so WinSTT skips the deterministic pass.`
							: "Choose which deterministic formatting rules run after speech recognition."
				}
				disabled={disabled}
				disabledTooltip={disabledTooltip}
				hideReset={disabled}
				isDefault={formattingAtDefault(quality)}
				label="Rules"
				onReset={() => updateQuality(formattingDefaultsPatch())}
				tooltip="Local formatting rules that run before any LLM cleanup."
			>
				<ElevatedSurface>
					<CheckboxGroup checkedIndices={checkedIndices} className="w-full">
						{FORMATTING_OPTIONS.map((option, index) => {
							const checked =
								option.key === "formatBasicPunctuationCasing"
									? basicEnabled
									: !disabled &&
										formattingOptionKeys(option).every((key) => quality[key]);
							const optionDisabled =
								disabled ||
								(option.key === "formatBasicPunctuationCasing" &&
									nativeBasicFormatting);
							const tooltip =
								optionDisabled && disabledTooltip
									? disabledTooltip
									: optionDisabled && basicDisabledReason
										? `${basicDisabledReason}, so WinSTT skips this deterministic pass.`
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
				</ElevatedSurface>
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
	const nativeBasicFormatting = modelHasNativeBasicFormatting(activeSttModel);
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
		<div className="flex flex-col gap-2">
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
				nativeBasicFormatting={nativeBasicFormatting}
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
