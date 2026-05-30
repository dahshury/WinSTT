import {
	ArrowTurnBackwardIcon,
	DashboardCircleIcon,
	Mic01Icon,
	PowerSocket01Icon,
} from "@hugeicons/core-free-icons";
import { type ReactNode, useState } from "react";
import { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	SettingResetButton,
	SettingSection,
	useDiarizationToggleStore,
	useSettingsStore,
} from "@/entities/setting";
import { useLoopbackDevices } from "@/features/listen-mode";
import { SoundLibrary } from "@/features/recording-sound";
import { LOCALE_NAMES, LOCALES, type Locale, useLocaleStore } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Spinner } from "@/shared/ui/spinner";
import { Switcher } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import {
	buildAuraShapeSwitcherOptions,
	buildOverlayModeSwitcherOptions,
	buildRecordingModeOptions,
	buildVisualizerTypeSwitcherOptions,
	buildWakeWordOptions,
	computeDisplayFlags,
	effectiveLiveDisplay,
	flagsToLiveDisplay,
	getVisualizerType,
	indexToReduction,
	type LiveTranscriptionDisplayValue,
	liveDisplayToFlags,
	liveOverlayDisabled,
	muteLevel,
	overlaySliderLabel,
	overlaySliderMax,
	overlaySliderPatch,
	overlaySliderToIndex,
	pickAuraShape,
	pickLocale,
	pickVisualizerType,
	REDUCTION_STEPS,
	readStartupFlags,
	recordingModePatch,
	reductionStepLabel,
	reductionToIndex,
	SENSITIVITY_STEPS,
	sensitivityFromIndex,
	sensitivityToIndex,
} from "../lib/general-settings-panel-test-helpers";

// Short label shown in the picker chip — same shape as the OS keyboard-
// indicator: native-script abbreviation when one exists, ISO code
// upper-case otherwise. Keep entries in sync with LOCALES in
// shared/i18n/config.ts when adding a new locale baseline.
const LOCALE_BADGE: Record<Locale, string> = {
	en: "EN",
	ar: "ع",
	bg: "БГ",
	cs: "CS",
	de: "DE",
	es: "ES",
	fr: "FR",
	he: "עב",
	hi: "हि",
	it: "IT",
	ja: "日",
	ko: "한",
	pl: "PL",
	pt: "PT",
	ru: "РУ",
	sv: "SV",
	tr: "TR",
	uk: "УК",
	vi: "VI",
	zh: "中",
};

const LANGUAGE_OPTIONS: SelectOption[] = LOCALES.map((code) => ({
	id: code,
	label: LOCALE_NAMES[code].native,
	badge: LOCALE_BADGE[code],
}));

type GeneralT = ReturnType<typeof useTranslations<"general">>;
type CommonT = ReturnType<typeof useTranslations<"common">>;
type GeneralSettings = NonNullable<
	ReturnType<typeof useSettingsStore.getState>["settings"]["general"]
>;
type UpdateFn = (patch: Partial<GeneralSettings>) => void;

interface LoopbackControlProps {
	currentLoopbackId: string;
	handleLoopbackChange: (value: string) => void;
	loopbackOpts: SelectOption[];
	t: GeneralT;
}

function LoopbackControl({
	t,
	currentLoopbackId,
	loopbackOpts,
	handleLoopbackChange,
}: LoopbackControlProps): ReactNode {
	return (
		<FormControl label={t("loopbackDevice")} layout="row" tooltip={t("loopbackDeviceTooltip")}>
			<ElevatedSurface className="w-52" inline>
				<Select onChange={handleLoopbackChange} options={loopbackOpts} value={currentLoopbackId} />
			</ElevatedSurface>
		</FormControl>
	);
}

interface MuteSystemAudioControlProps {
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateFn;
}

function MuteSystemAudioControl({ general, t, update }: MuteSystemAudioControlProps): ReactNode {
	const level = muteLevel(general);
	return (
		<FormControl label={t("muteSystemAudio")} tooltip={t("muteSystemAudioTooltip")}>
			<ElevatedSurface inline>
				<Slider
					aria-label={t("muteSystemAudio")}
					formatValue={(v) => reductionStepLabel(indexToReduction(v), t)}
					max={REDUCTION_STEPS.length - 1}
					min={0}
					onChange={(v) => update({ systemAudioReductionWhileDictating: indexToReduction(v) })}
					step={1}
					value={reductionToIndex(level)}
				/>
			</ElevatedSurface>
		</FormControl>
	);
}

interface SpeakerDiarizationControlProps {
	enabled: boolean;
	t: GeneralT;
	update: UpdateFn;
}

function SpeakerDiarizationControl({
	enabled,
	t,
	update,
}: SpeakerDiarizationControlProps): ReactNode {
	// Diarization is toggled at runtime (no server restart). The server
	// pushes started/completed/failed; this store tracks the in-flight
	// window. Driven purely by broadcast IPC so it works in the settings
	// window (its own BrowserWindow, no connection store there). The
	// optimistic-revert on failure is performed in the toggle-store's
	// IPC listener (`diarization-toggle-store.ts`) so the failure handler
	// owns the lifecycle directly — no effect-in-render needed here.
	const pending = useDiarizationToggleStore((s) => s.pending);

	return (
		<FormControl
			label={t("speakerDiarization")}
			labelAddon={
				<div className="flex items-center gap-2">
					{pending ? (
						<Spinner
							aria-label={t("speakerDiarization")}
							className="size-3.5 text-foreground-muted"
						/>
					) : null}
					<Toggle
						aria-label={t("speakerDiarization")}
						checked={enabled}
						disabled={pending}
						onCheckedChange={(v) => update({ speakerDiarization: v })}
					/>
				</div>
			}
			tooltip={t("speakerDiarizationTooltip")}
		/>
	);
}

interface RecordingSectionProps {
	currentLoopbackId: string;
	general: GeneralSettings | undefined;
	handleLoopbackChange: (value: string) => void;
	isListenMode: boolean;
	loopbackOpts: SelectOption[];
	recordingMode: "ptt" | "toggle" | "listen" | "wakeword";
	recordingSoundEnabled: boolean;
	t: GeneralT;
	tc: CommonT;
	update: UpdateFn;
}

interface WakeWordControlProps {
	t: GeneralT;
	update: UpdateFn;
	value: string;
}

interface WakeWordSensitivityControlProps {
	t: GeneralT;
	update: UpdateFn;
	value: number;
}

interface WakeWordTimeoutControlProps {
	t: GeneralT;
	update: UpdateFn;
	value: number;
}

interface ManualToggleStopControlProps {
	enabled: boolean;
	t: GeneralT;
	update: UpdateFn;
}

// "Stop only on hotkey press" — surfaces under the toggle-mode option only.
// Flips silence_endpoint_enabled and silence_timing off on the server so a
// toggle-mode session runs continuously from first press to second press,
// fixing the mid-speech cutoff users hit when their voice goes soft.
function ManualToggleStopControl({ enabled, t, update }: ManualToggleStopControlProps): ReactNode {
	return (
		<FormControl
			label={t("manualToggleStop")}
			labelAddon={
				<Toggle
					aria-label={t("manualToggleStop")}
					checked={enabled}
					onCheckedChange={(v) => update({ manualToggleStop: v })}
				/>
			}
			tooltip={t("manualToggleStopTooltip")}
		/>
	);
}

function WakeWordControl({ t, value, update }: WakeWordControlProps): ReactNode {
	const options = buildWakeWordOptions();
	return (
		<FormControl label={t("wakeWord")} layout="row" tooltip={t("wakeWordTooltip")}>
			<ElevatedSurface className="w-52" inline>
				<Select
					aria-label={t("wakeWord")}
					onChange={(v) => update({ wakeWord: v })}
					options={options}
					value={value}
				/>
			</ElevatedSurface>
		</FormControl>
	);
}

function WakeWordSensitivityControl({
	t,
	value,
	update,
}: WakeWordSensitivityControlProps): ReactNode {
	return (
		<FormControl
			label={t("wakeWordSensitivity")}
			labelTrailing={
				<SettingResetButton
					isDefault={value === DEFAULT_SETTINGS.general.wakeWordSensitivity}
					onReset={() =>
						update({ wakeWordSensitivity: DEFAULT_SETTINGS.general.wakeWordSensitivity })
					}
				/>
			}
			tooltip={t("wakeWordSensitivityTooltip")}
		>
			<ElevatedSurface inline>
				<Slider
					aria-label={t("wakeWordSensitivity")}
					formatValue={(idx) => sensitivityFromIndex(idx).toFixed(2)}
					max={SENSITIVITY_STEPS}
					min={0}
					onChange={(idx) => update({ wakeWordSensitivity: sensitivityFromIndex(idx) })}
					step={1}
					value={sensitivityToIndex(value)}
				/>
			</ElevatedSurface>
		</FormControl>
	);
}

function WakeWordTimeoutControl({ t, value, update }: WakeWordTimeoutControlProps): ReactNode {
	return (
		<FormControl
			label={t("wakeWordTimeout")}
			labelTrailing={
				<SettingResetButton
					isDefault={value === DEFAULT_SETTINGS.general.wakeWordTimeout}
					onReset={() => update({ wakeWordTimeout: DEFAULT_SETTINGS.general.wakeWordTimeout })}
				/>
			}
			tooltip={t("wakeWordTimeoutTooltip")}
		>
			<ElevatedSurface inline>
				<Slider
					aria-label={t("wakeWordTimeout")}
					formatValue={(v) => `${v}s`}
					max={30}
					min={1}
					onChange={(v) => update({ wakeWordTimeout: v })}
					step={1}
					value={value}
				/>
			</ElevatedSurface>
		</FormControl>
	);
}

function RecordingSection({
	t,
	tc,
	general,
	recordingMode,
	isListenMode,
	update,
	loopbackOpts,
	currentLoopbackId,
	handleLoopbackChange,
	recordingSoundEnabled,
}: RecordingSectionProps): ReactNode {
	const recordingModeOptions = buildRecordingModeOptions(t);
	return (
		<SettingSection icon={Mic01Icon} title={t("recording")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<FormControl label={t("recordingMode")} tooltip={t("recordingModeTooltip")}>
					{/* Hero control — sets the design template for every other
					    interactive group on the tab. Same ElevatedSurface wraps
					    them all so the tab reads as one consistent language. */}
					<ElevatedSurface>
						<Switcher
							fullWidth
							onChange={(v) => update(recordingModePatch(v, general?.wakeWord))}
							options={recordingModeOptions}
							value={recordingMode}
						/>
					</ElevatedSurface>
				</FormControl>
				{recordingMode === "toggle" ? (
					<ManualToggleStopControl
						enabled={general?.manualToggleStop ?? false}
						t={t}
						update={update}
					/>
				) : null}
				{recordingMode === "listen" ? (
					<LoopbackControl
						currentLoopbackId={currentLoopbackId}
						handleLoopbackChange={handleLoopbackChange}
						loopbackOpts={loopbackOpts}
						t={t}
					/>
				) : null}
				{recordingMode === "wakeword" ? (
					<>
						<WakeWordControl t={t} update={update} value={general?.wakeWord ?? ""} />
						<WakeWordSensitivityControl
							t={t}
							update={update}
							value={general?.wakeWordSensitivity ?? 0.6}
						/>
						<WakeWordTimeoutControl t={t} update={update} value={general?.wakeWordTimeout ?? 5} />
					</>
				) : null}
				{recordingMode === "listen" ? (
					<SpeakerDiarizationControl
						enabled={general?.speakerDiarization ?? false}
						t={t}
						update={update}
					/>
				) : null}
				{isListenMode ? null : <MuteSystemAudioControl general={general} t={t} update={update} />}
				{isListenMode ? null : (
					<FormControl
						label={t("recordingSound")}
						labelAddon={
							<Toggle
								checked={recordingSoundEnabled}
								onCheckedChange={(v) => update({ recordingSound: v })}
							/>
						}
						tooltip={t("soundLibraryTooltip")}
					>
						{recordingSoundEnabled ? <SoundLibrary t={t} tCommon={tc} /> : null}
					</FormControl>
				)}
			</div>
		</SettingSection>
	);
}

interface StartupSectionProps {
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateFn;
}

function StartupSection({ t, general, update }: StartupSectionProps): ReactNode {
	const flags = readStartupFlags(general);
	return (
		<SettingSection icon={PowerSocket01Icon} title={t("startup")}>
			<div className="flex flex-col divide-y divide-surface-1">
				{/* Single "Start on login" switch — on launches WinSTT on sign-in,
				    minimized straight to the tray (autoStart + startMinimized +
				    minimizeToTray together); off disables auto-launch. The former
				    separate start-minimized / minimize-to-tray toggles are folded in. */}
				<FormControl
					label={t("startOnLogin")}
					labelAddon={
						<Toggle
							checked={flags.autoStart}
							onCheckedChange={(v) =>
								update(
									v
										? { autoStart: true, startMinimized: true, minimizeToTray: true }
										: { autoStart: false, startMinimized: false }
								)
							}
						/>
					}
					tooltip={t("startOnLoginTooltip")}
				/>
				<FormControl
					label={t("sendCrashReports")}
					labelAddon={
						<Toggle
							checked={flags.sendCrashReports}
							onCheckedChange={(v) => update({ sendCrashReports: v })}
						/>
					}
					tooltip={t("sendCrashReportsTooltip")}
				/>
			</div>
		</SettingSection>
	);
}

function ResetSection(): ReactNode {
	const resetSettings = useSettingsStore((s) => s.resetSettings);
	const ts = useTranslations("settings");
	const tc = useTranslations("common");
	const [confirmOpen, setConfirmOpen] = useState(false);

	return (
		<>
			<ConfirmDialog
				confirmLabel={ts("resetConfirm")}
				description={ts("resetDescription")}
				onConfirm={resetSettings}
				onOpenChange={setConfirmOpen}
				open={confirmOpen}
				title={ts("resetTitle")}
			/>
			<SettingSection
				description={ts("resetDescription")}
				headerAction={
					<Button
						className="h-8 rounded-md border border-error/40 bg-error/10 px-4 font-medium text-body text-error transition-colors duration-150 hover:bg-error/20"
						onClick={() => setConfirmOpen(true)}
					>
						{tc("reset")}
					</Button>
				}
				icon={ArrowTurnBackwardIcon}
				title={ts("resetDefaults")}
			/>
		</>
	);
}

export function GeneralSettingsPanel() {
	const general = useSettingsStore((s) => s.settings.general);
	const update = useSettingsStore((s) => s.updateGeneralSettings);
	const t = useTranslations("general");
	const tc = useTranslations("common");

	const locale = useLocaleStore((s) => s.locale);
	const setLocale = useLocaleStore((s) => s.setLocale);

	const recordingMode = general?.recordingMode ?? "ptt";
	const isListenMode = recordingMode === "listen";

	const {
		options: loopbackOpts,
		currentId: currentLoopbackId,
		handleChange: handleLoopbackChange,
	} = useLoopbackDevices();

	const recordingSoundEnabled = general?.recordingSound ?? true;

	return (
		<div className="flex flex-col gap-2">
			<RecordingSection
				currentLoopbackId={currentLoopbackId}
				general={general}
				handleLoopbackChange={handleLoopbackChange}
				isListenMode={isListenMode}
				loopbackOpts={loopbackOpts}
				recordingMode={recordingMode}
				recordingSoundEnabled={recordingSoundEnabled}
				t={t}
				tc={tc}
				update={update}
			/>
			<DisplaySection
				isListenMode={isListenMode}
				locale={locale}
				setLocale={setLocale}
				t={t}
				update={update}
			/>
			<StartupSection general={general} t={t} update={update} />
			<ResetSection />
		</div>
	);
}

interface DisplaySectionProps {
	isListenMode: boolean;
	locale: Locale;
	setLocale: (locale: Locale) => void;
	t: GeneralT;
	update: UpdateFn;
}

interface LanguageControlProps {
	locale: Locale;
	setLocale: (locale: Locale) => void;
	t: GeneralT;
}

function LanguageControl({ locale, setLocale, t }: LanguageControlProps): ReactNode {
	return (
		<FormControl label={t("language")} layout="row" tooltip={t("languageTooltip")}>
			<ElevatedSurface className="w-52" inline>
				<SearchableSelect
					onChange={(v) => pickLocale(v, setLocale)}
					options={LANGUAGE_OPTIONS}
					value={locale}
				/>
			</ElevatedSurface>
		</FormControl>
	);
}

interface OverlayControlProps {
	general: GeneralSettings | undefined;
	isListenMode: boolean;
	t: GeneralT;
	update: UpdateFn;
}

function OverlayControl({ t, isListenMode, general, update }: OverlayControlProps): ReactNode {
	const idx = overlaySliderToIndex(general);
	return (
		<FormControl
			disabled={isListenMode}
			label={t("showRecordingOverlay")}
			tooltip={t("showRecordingOverlayTooltip")}
		>
			<ElevatedSurface
				className={isListenMode ? "pointer-events-none opacity-40" : undefined}
				inline
			>
				<Slider
					aria-label={t("showRecordingOverlay")}
					formatValue={(v) => overlaySliderLabel(v, t)}
					max={overlaySliderMax()}
					min={0}
					onChange={(v) => update(overlaySliderPatch(v, general))}
					step={1}
					value={idx}
				/>
			</ElevatedSurface>
		</FormControl>
	);
}

interface OverlayModeControlProps {
	general: GeneralSettings | undefined;
	subDisabled: boolean;
	t: GeneralT;
	update: UpdateFn;
}

function OverlayModeControl({
	t,
	subDisabled,
	general,
	update,
}: OverlayModeControlProps): ReactNode {
	const value = general?.overlayMode ?? "floating-bottom";
	const options = buildOverlayModeSwitcherOptions(t);
	const onChange = (next: string): void => {
		if (next === "floating-bottom" || next === "dynamic-island") {
			update({ overlayMode: next });
		}
	};
	return (
		<FormControl label={t("overlayMode")} tooltip={t("overlayModeTooltip")}>
			<ElevatedSurface className={subDisabled ? "pointer-events-none opacity-40" : undefined}>
				<Switcher fullWidth onChange={onChange} options={options} value={value} />
			</ElevatedSurface>
		</FormControl>
	);
}

interface LiveTranscriptionDisplayControlProps {
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateFn;
}

function LiveTranscriptionDisplayControl({
	t,
	general,
	update,
}: LiveTranscriptionDisplayControlProps): ReactNode {
	const overlayDisabled = liveOverlayDisabled(general);
	const stored: LiveTranscriptionDisplayValue = general?.liveTranscriptionDisplay ?? "both";
	const value = effectiveLiveDisplay(stored, overlayDisabled);
	const { inApp, inOverlay } = liveDisplayToFlags(value);
	const checkedIndices = new Set<number>();
	if (inApp) {
		checkedIndices.add(0);
	}
	if (inOverlay) {
		checkedIndices.add(1);
	}
	const setInApp = (next: boolean): void => {
		update({ liveTranscriptionDisplay: flagsToLiveDisplay(next, inOverlay) });
	};
	const setInOverlay = (next: boolean): void => {
		if (overlayDisabled) {
			return;
		}
		update({ liveTranscriptionDisplay: flagsToLiveDisplay(inApp, next) });
	};
	return (
		<FormControl
			label={t("liveTranscriptionDisplay")}
			tooltip={t("liveTranscriptionDisplayTooltip")}
		>
			<ElevatedSurface>
				<CheckboxGroup checkedIndices={checkedIndices} className="w-full">
					<CheckboxItem
						checked={inApp}
						index={0}
						label={t("liveTranscriptionDisplayInApp")}
						onToggle={() => setInApp(!inApp)}
					/>
					<CheckboxItem
						checked={inOverlay}
						disabled={overlayDisabled}
						index={1}
						label={t("liveTranscriptionDisplayInPill")}
						onToggle={() => setInOverlay(!inOverlay)}
					/>
				</CheckboxGroup>
			</ElevatedSurface>
		</FormControl>
	);
}

interface VisualizerTypeControlProps {
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateFn;
}

function VisualizerTypeControl({ t, general, update }: VisualizerTypeControlProps): ReactNode {
	const value = general?.visualizerType ?? "bar";
	const options = buildVisualizerTypeSwitcherOptions(t);
	return (
		<FormControl label={t("visualizerType")} tooltip={t("visualizerTypeTooltip")}>
			<ElevatedSurface>
				<Switcher
					fullWidth
					onChange={(v) => pickVisualizerType(v, update)}
					options={options}
					value={value}
				/>
			</ElevatedSurface>
		</FormControl>
	);
}

interface VisualizerBarCountControlProps {
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateFn;
}

function VisualizerBarCountControl({
	t,
	general,
	update,
}: VisualizerBarCountControlProps): ReactNode {
	const value = general?.visualizerBarCount ?? DEFAULT_SETTINGS.general.visualizerBarCount;
	return (
		<FormControl
			label={t("visualizerBarCount")}
			labelTrailing={
				<SettingResetButton
					isDefault={value === DEFAULT_SETTINGS.general.visualizerBarCount}
					onReset={() =>
						update({ visualizerBarCount: DEFAULT_SETTINGS.general.visualizerBarCount })
					}
				/>
			}
			tooltip={t("visualizerBarCountTooltip")}
		>
			<ElevatedSurface inline>
				<Slider
					aria-label={t("visualizerBarCount")}
					max={21}
					min={3}
					onChange={(v) => update({ visualizerBarCount: v })}
					step={2}
					value={value}
				/>
			</ElevatedSurface>
		</FormControl>
	);
}

type GeneralMessageKey = Parameters<GeneralT>[0];

const formatPercent = (v: number): string => `${v}%`;

interface VizSliderControlProps {
	defaultValue: number;
	formatValue?: (v: number) => string;
	labelKey: GeneralMessageKey;
	max: number;
	min: number;
	onChange: (v: number) => void;
	step: number;
	t: GeneralT;
	tooltipKey: GeneralMessageKey;
	value: number;
}

/**
 * Shared presentational slider row for the per-shape visualizer knobs. Mirrors
 * `VisualizerBarCountControl` (label + reset + ElevatedSurface slider) so every
 * shape's controls read identically.
 */
function VizSliderControl({
	t,
	labelKey,
	tooltipKey,
	value,
	defaultValue,
	onChange,
	min,
	max,
	step,
	formatValue,
}: VizSliderControlProps): ReactNode {
	const label = t(labelKey);
	return (
		<FormControl
			label={label}
			labelTrailing={
				<SettingResetButton
					isDefault={value === defaultValue}
					onReset={() => onChange(defaultValue)}
				/>
			}
			tooltip={t(tooltipKey)}
		>
			<ElevatedSurface inline>
				<Slider
					aria-label={label}
					max={max}
					min={min}
					onChange={onChange}
					step={step}
					value={value}
					{...(formatValue ? { formatValue } : {})}
				/>
			</ElevatedSurface>
		</FormControl>
	);
}

interface VisualizerShapeControlsProps {
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateFn;
}

function VisualizerRadialControls({ t, general, update }: VisualizerShapeControlsProps): ReactNode {
	const d = DEFAULT_SETTINGS.general;
	return (
		<>
			<VizSliderControl
				defaultValue={d.visualizerRadialDotCount}
				labelKey="visualizerRadialDotCount"
				max={48}
				min={6}
				onChange={(v) => update({ visualizerRadialDotCount: v })}
				step={2}
				t={t}
				tooltipKey="visualizerRadialDotCountTooltip"
				value={general?.visualizerRadialDotCount ?? d.visualizerRadialDotCount}
			/>
			<VizSliderControl
				defaultValue={d.visualizerRadialRadius}
				formatValue={formatPercent}
				labelKey="visualizerRadialRadius"
				max={90}
				min={20}
				onChange={(v) => update({ visualizerRadialRadius: v })}
				step={1}
				t={t}
				tooltipKey="visualizerRadialRadiusTooltip"
				value={general?.visualizerRadialRadius ?? d.visualizerRadialRadius}
			/>
		</>
	);
}

function VisualizerGridControls({ t, general, update }: VisualizerShapeControlsProps): ReactNode {
	const d = DEFAULT_SETTINGS.general;
	return (
		<>
			<VizSliderControl
				defaultValue={d.visualizerGridRows}
				labelKey="visualizerGridRows"
				max={8}
				min={3}
				onChange={(v) => update({ visualizerGridRows: v })}
				step={1}
				t={t}
				tooltipKey="visualizerGridRowsTooltip"
				value={general?.visualizerGridRows ?? d.visualizerGridRows}
			/>
			<VizSliderControl
				defaultValue={d.visualizerGridColumns}
				labelKey="visualizerGridColumns"
				max={8}
				min={3}
				onChange={(v) => update({ visualizerGridColumns: v })}
				step={1}
				t={t}
				tooltipKey="visualizerGridColumnsTooltip"
				value={general?.visualizerGridColumns ?? d.visualizerGridColumns}
			/>
			<VizSliderControl
				defaultValue={d.visualizerGridSpeed}
				labelKey="visualizerGridSpeed"
				max={10}
				min={1}
				onChange={(v) => update({ visualizerGridSpeed: v })}
				step={1}
				t={t}
				tooltipKey="visualizerGridSpeedTooltip"
				value={general?.visualizerGridSpeed ?? d.visualizerGridSpeed}
			/>
		</>
	);
}

function VisualizerWaveControls({ t, general, update }: VisualizerShapeControlsProps): ReactNode {
	const d = DEFAULT_SETTINGS.general;
	return (
		<>
			<VizSliderControl
				defaultValue={d.visualizerWaveLineWidth}
				labelKey="visualizerWaveLineWidth"
				max={6}
				min={1}
				onChange={(v) => update({ visualizerWaveLineWidth: v })}
				step={1}
				t={t}
				tooltipKey="visualizerWaveLineWidthTooltip"
				value={general?.visualizerWaveLineWidth ?? d.visualizerWaveLineWidth}
			/>
			<VizSliderControl
				defaultValue={d.visualizerWaveSmoothing}
				formatValue={formatPercent}
				labelKey="visualizerWaveSmoothing"
				max={100}
				min={0}
				onChange={(v) => update({ visualizerWaveSmoothing: v })}
				step={5}
				t={t}
				tooltipKey="visualizerWaveSmoothingTooltip"
				value={general?.visualizerWaveSmoothing ?? d.visualizerWaveSmoothing}
			/>
			<VizSliderControl
				defaultValue={d.visualizerWaveColorShift}
				formatValue={formatPercent}
				labelKey="visualizerWaveColorShift"
				max={100}
				min={0}
				onChange={(v) => update({ visualizerWaveColorShift: v })}
				step={5}
				t={t}
				tooltipKey="visualizerWaveColorShiftTooltip"
				value={general?.visualizerWaveColorShift ?? d.visualizerWaveColorShift}
			/>
		</>
	);
}

function VisualizerAuraShapeControl({
	t,
	general,
	update,
}: VisualizerShapeControlsProps): ReactNode {
	const value = general?.visualizerAuraShape ?? DEFAULT_SETTINGS.general.visualizerAuraShape;
	const options = buildAuraShapeSwitcherOptions(t);
	return (
		<FormControl label={t("visualizerAuraShape")} tooltip={t("visualizerAuraShapeTooltip")}>
			<ElevatedSurface>
				<Switcher
					fullWidth
					onChange={(v) => pickAuraShape(v, update)}
					options={options}
					value={value}
				/>
			</ElevatedSurface>
		</FormControl>
	);
}

function VisualizerAuraControls({ t, general, update }: VisualizerShapeControlsProps): ReactNode {
	const d = DEFAULT_SETTINGS.general;
	return (
		<>
			<VisualizerAuraShapeControl general={general} t={t} update={update} />
			<VizSliderControl
				defaultValue={d.visualizerAuraBlur}
				formatValue={formatPercent}
				labelKey="visualizerAuraBlur"
				max={100}
				min={0}
				onChange={(v) => update({ visualizerAuraBlur: v })}
				step={5}
				t={t}
				tooltipKey="visualizerAuraBlurTooltip"
				value={general?.visualizerAuraBlur ?? d.visualizerAuraBlur}
			/>
			<VizSliderControl
				defaultValue={d.visualizerAuraBloom}
				formatValue={formatPercent}
				labelKey="visualizerAuraBloom"
				max={100}
				min={0}
				onChange={(v) => update({ visualizerAuraBloom: v })}
				step={5}
				t={t}
				tooltipKey="visualizerAuraBloomTooltip"
				value={general?.visualizerAuraBloom ?? d.visualizerAuraBloom}
			/>
			<VizSliderControl
				defaultValue={d.visualizerAuraColorShift}
				formatValue={formatPercent}
				labelKey="visualizerAuraColorShift"
				max={100}
				min={0}
				onChange={(v) => update({ visualizerAuraColorShift: v })}
				step={5}
				t={t}
				tooltipKey="visualizerAuraColorShiftTooltip"
				value={general?.visualizerAuraColorShift ?? d.visualizerAuraColorShift}
			/>
		</>
	);
}

/** Renders the customization controls for whichever visualizer shape is active. */
function VisualizerShapeControls({ t, general, update }: VisualizerShapeControlsProps): ReactNode {
	switch (getVisualizerType(general)) {
		case "radial":
			return <VisualizerRadialControls general={general} t={t} update={update} />;
		case "grid":
			return <VisualizerGridControls general={general} t={t} update={update} />;
		case "wave":
			return <VisualizerWaveControls general={general} t={t} update={update} />;
		case "aura":
			return <VisualizerAuraControls general={general} t={t} update={update} />;
		default:
			return <VisualizerBarCountControl general={general} t={t} update={update} />;
	}
}

function DisplaySection({ isListenMode, locale, setLocale, t, update }: DisplaySectionProps) {
	const general = useSettingsStore((s) => s.settings.general);
	const flags = computeDisplayFlags(isListenMode, general);

	return (
		<SettingSection icon={DashboardCircleIcon} title={t("display")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<LanguageControl locale={locale} setLocale={setLocale} t={t} />
				<VisualizerTypeControl general={general} t={t} update={update} />
				<VisualizerShapeControls general={general} t={t} update={update} />
				<OverlayControl general={general} isListenMode={isListenMode} t={t} update={update} />
				<OverlayModeControl
					general={general}
					subDisabled={flags.subDisabled}
					t={t}
					update={update}
				/>
				<LiveTranscriptionDisplayControl general={general} t={t} update={update} />
			</div>
		</SettingSection>
	);
}
