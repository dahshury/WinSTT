"use client";

import {
	AiBeautifyIcon,
	ArrowTurnBackwardIcon,
	AudioWave02Icon,
	BarChartIcon,
	DashboardCircleIcon,
	EarIcon,
	GridIcon,
	Mic01Icon,
	PowerSocket01Icon,
	RadialIcon,
	ToggleOnIcon,
	TouchInteraction01Icon,
	VoiceIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { isVisualizerType } from "@/features/audio-visualizer";
import { useLoopbackDevices } from "@/features/listen-mode";
import { SoundLibrary } from "@/features/recording-sound";
import { RECORDING_MODE_COLOR_HEX } from "@/shared/config/recording-mode-color";
import { isLocale, LOCALE_NAMES, LOCALES, type Locale, useLocaleStore } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";

const LOCALE_BADGE: Record<Locale, string> = {
	en: "EN",
	zh: "中",
	es: "ES",
	hi: "हि",
	fr: "FR",
	ar: "ع",
};

const LANGUAGE_OPTIONS: SelectOption[] = LOCALES.map((code) => ({
	id: code,
	label: LOCALE_NAMES[code].native,
	badge: LOCALE_BADGE[code],
}));

type VisualizerSizePreset = "xs" | "sm" | "md" | "lg" | "xl";
const VISUALIZER_SIZE_OPTIONS = [
	{ value: "xs", label: "XS" },
	{ value: "sm", label: "S" },
	{ value: "md", label: "M" },
	{ value: "lg", label: "L" },
	{ value: "xl", label: "XL" },
] as const satisfies readonly { value: VisualizerSizePreset; label: string }[];

type GeneralT = ReturnType<typeof useTranslations<"general">>;
type CommonT = ReturnType<typeof useTranslations<"common">>;
type GeneralSettings = NonNullable<
	ReturnType<typeof useSettingsStore.getState>["settings"]["general"]
>;
type UpdateFn = (patch: Partial<GeneralSettings>) => void;

function buildVisualizerTypeOptions(t: GeneralT): SelectOption[] {
	return [
		{ id: "bar", label: t("visualizerBar"), icon: BarChartIcon },
		{ id: "grid", label: t("visualizerGrid"), icon: GridIcon },
		{ id: "radial", label: t("visualizerRadial"), icon: RadialIcon },
		{ id: "wave", label: t("visualizerWave"), icon: AudioWave02Icon },
		{ id: "aura", label: t("visualizerAura"), icon: AiBeautifyIcon },
	] satisfies SelectOption[];
}

function buildVisualizerTypeSwitcherOptions(t: GeneralT): SwitcherOption[] {
	return [
		{ value: "bar", label: t("visualizerBar"), icon: BarChartIcon },
		{ value: "grid", label: t("visualizerGrid"), icon: GridIcon },
		{ value: "radial", label: t("visualizerRadial"), icon: RadialIcon },
		{ value: "wave", label: t("visualizerWave"), icon: AudioWave02Icon },
		{ value: "aura", label: t("visualizerAura"), icon: AiBeautifyIcon },
	];
}

function buildRecordingModeOptions(t: GeneralT): readonly {
	value: "ptt" | "toggle" | "listen" | "wakeword";
	label: string;
	icon: IconSvgElement;
	color: string;
}[] {
	return [
		{
			value: "ptt",
			label: t("pushToTalk"),
			icon: TouchInteraction01Icon,
			color: RECORDING_MODE_COLOR_HEX.ptt,
		},
		{
			value: "toggle",
			label: t("toggle"),
			icon: ToggleOnIcon,
			color: RECORDING_MODE_COLOR_HEX.toggle,
		},
		{
			value: "listen",
			label: t("listen"),
			icon: EarIcon,
			color: RECORDING_MODE_COLOR_HEX.listen,
		},
		{
			value: "wakeword",
			label: t("wakeWord"),
			icon: VoiceIcon,
			color: RECORDING_MODE_COLOR_HEX.wakeword,
		},
	] as const;
}

// Porcupine's free built-in keywords — usable without an access key on the
// 1.9.x line we pin in server/pyproject.toml. The 2.0+ Porcupine line
// requires a Picovoice signup for every user including free tier, which is
// why we don't upgrade.
const PORCUPINE_FREE_KEYWORDS = [
	"alexa",
	"americano",
	"blueberry",
	"bumblebee",
	"computer",
	"grapefruit",
	"grasshopper",
	"hey google",
	"hey siri",
	"jarvis",
	"ok google",
	"picovoice",
	"porcupine",
	"terminator",
] as const;

// openWakeWord's bundled pre-trained models (downloaded on first server
// start to ~/.cache/openwakeword/). The strings match the model short
// names openWakeWord's `Model(wakeword_models=[...])` accepts and what
// the server's `--openwakeword_model_paths` flag forwards verbatim.
const OPENWAKEWORD_KEYWORDS = [
	"alexa",
	"hey_jarvis",
	"hey_mycroft",
	"hey_rhasspy",
	"timer",
	"weather",
] as const;

type WakeWordEngine = "porcupine" | "openwakeword" | "composite";

// Single source of truth for which engine handles each keyword. Keywords
// supported by both engines run as a composite (both must agree → highest
// accuracy); single-engine keywords route to whichever engine knows them.
// This mirrors the renderer-side decision in electron/ipc/stt-process.ts
// `wakeWordBackendFor` — keep the two lists in sync.
function engineForKeyword(word: string): WakeWordEngine {
	const inPorc = (PORCUPINE_FREE_KEYWORDS as readonly string[]).includes(word);
	const inOww = (OPENWAKEWORD_KEYWORDS as readonly string[]).includes(word);
	if (inPorc && inOww) {
		return "composite";
	}
	if (inOww) {
		return "openwakeword";
	}
	return "porcupine";
}

// Pretty label for openWakeWord's underscore-separated model names. The
// stored value stays underscored so the CLI flag matches openWakeWord's
// expected model identifiers; only the dropdown label spaces it out.
function formatWakeWordLabel(word: string): string {
	return word.replace(/_/g, " ");
}

// Union of all engines' keywords, deduplicated, "alexa" once. Sorted so the
// shared-keywords (composite mode, highest accuracy) come first under a
// visual divider implemented via the badge — those are the recommended picks.
function buildUnifiedWakeWordList(): readonly string[] {
	const all = new Set<string>([...PORCUPINE_FREE_KEYWORDS, ...OPENWAKEWORD_KEYWORDS]);
	const sortKey = (w: string): number => {
		const engine = engineForKeyword(w);
		if (engine === "composite") {
			return 0;
		}
		if (engine === "porcupine") {
			return 1;
		}
		return 2;
	};
	return [...all].toSorted((a, b) => sortKey(a) - sortKey(b) || a.localeCompare(b));
}

const ALL_WAKE_WORDS = buildUnifiedWakeWordList();
const DEFAULT_WAKE_WORD = "alexa";

function engineBadge(engine: WakeWordEngine): string {
	if (engine === "composite") {
		return "2x";
	}
	if (engine === "openwakeword") {
		return "OWW";
	}
	return "PVP";
}

function buildWakeWordOptions(): SelectOption[] {
	return ALL_WAKE_WORDS.map((word) => ({
		id: word,
		label: formatWakeWordLabel(word),
		badge: engineBadge(engineForKeyword(word)),
	}));
}

// Snap the stored value to a valid keyword when entering wakeword mode for
// the first time (or after a settings migration left it dangling). Anything
// already in the unified list stays as-is so users keep their pick.
function reconcileWakeWord(currentWord: string | undefined): string {
	if (currentWord && ALL_WAKE_WORDS.includes(currentWord)) {
		return currentWord;
	}
	return DEFAULT_WAKE_WORD;
}

function recordingModePatch(
	value: "ptt" | "toggle" | "listen" | "wakeword",
	currentWakeWord: string | undefined
): Partial<GeneralSettings> {
	if (value !== "wakeword") {
		return { recordingMode: value };
	}
	const reconciled = reconcileWakeWord(currentWakeWord);
	if (reconciled === currentWakeWord) {
		return { recordingMode: value };
	}
	return { recordingMode: value, wakeWord: reconciled };
}

function pickLocale(value: string, setLocale: (locale: Locale) => void): void {
	if (isLocale(value)) {
		setLocale(value);
	}
}

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
		<FormControl
			caption={t("loopbackDeviceCaption")}
			label={t("loopbackDevice")}
			tooltip={t("loopbackDeviceTooltip")}
		>
			<ElevatedSurface inline>
				<Select onChange={handleLoopbackChange} options={loopbackOpts} value={currentLoopbackId} />
			</ElevatedSurface>
		</FormControl>
	);
}

function muteCaption(isListenMode: boolean, t: GeneralT): string {
	return isListenMode ? t("muteSystemAudioCaptionDisabled") : t("muteSystemAudioCaption");
}

// Slider stops, left → right, monotonically increasing reduction:
// 20% → 40% → 60% → 80% → Mute (100%). On/off is a separate toggle, so the
// slider only ever holds a "how aggressive" value. Stored value is the
// percent reduction; the slider works in index space.
const REDUCTION_STEPS = [20, 40, 60, 80, 100] as const;

// Value applied when the toggle is switched on. Full mute preserves the
// behaviour of the legacy boolean toggle and sits at the slider's top stop.
const DEFAULT_REDUCTION = 100;

function reductionToIndex(pct: number): number {
	const idx = REDUCTION_STEPS.indexOf(pct as (typeof REDUCTION_STEPS)[number]);
	return idx === -1 ? REDUCTION_STEPS.length - 1 : idx;
}

function indexToReduction(index: number): number {
	return REDUCTION_STEPS[index] ?? DEFAULT_REDUCTION;
}

function reductionStepLabel(pct: number, t: GeneralT): string {
	return pct >= 100 ? t("systemAudioReductionMute") : `${pct}%`;
}

function muteLevel(isListenMode: boolean, settings: GeneralSettings | undefined): number {
	if (isListenMode) {
		return 0;
	}
	return settings?.systemAudioReductionWhileDictating ?? 0;
}

function muteEnabled(isListenMode: boolean, settings: GeneralSettings | undefined): boolean {
	return muteLevel(isListenMode, settings) > 0;
}

interface MuteSystemAudioControlProps {
	general: GeneralSettings | undefined;
	isListenMode: boolean;
	t: GeneralT;
	update: UpdateFn;
}

function MuteSystemAudioControl({
	general,
	isListenMode,
	t,
	update,
}: MuteSystemAudioControlProps): ReactNode {
	const level = muteLevel(isListenMode, general);
	const enabled = muteEnabled(isListenMode, general);
	return (
		<FormControl
			caption={muteCaption(isListenMode, t)}
			disabled={isListenMode}
			label={t("muteSystemAudio")}
			labelAddon={
				<Toggle
					checked={enabled}
					disabled={isListenMode}
					onCheckedChange={(v) =>
						update({ systemAudioReductionWhileDictating: v ? DEFAULT_REDUCTION : 0 })
					}
				/>
			}
			tooltip={t("muteSystemAudioTooltip")}
		>
			{enabled ? (
				<ElevatedSurface className="p-3">
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
			) : undefined}
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
	return (
		<FormControl
			caption={t("speakerDiarizationCaption")}
			label={t("speakerDiarization")}
			labelAddon={
				<Toggle
					aria-label={t("speakerDiarization")}
					checked={enabled}
					onCheckedChange={(v) => update({ speakerDiarization: v })}
				/>
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
			caption={t("manualToggleStopCaption")}
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
		<FormControl
			caption={t("wakeWordCaption")}
			label={t("wakeWord")}
			tooltip={t("wakeWordTooltip")}
		>
			<ElevatedSurface inline>
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

// Sensitivity slider — 0 to 1 in 0.05 steps. The slider works in integer
// step-index space so its `onChange` lands on exact tenths/twentieths
// (avoids floating-point drift like 0.30000004 reaching the server).
const SENSITIVITY_STEPS = 20;
function sensitivityFromIndex(idx: number): number {
	return Math.round((idx / SENSITIVITY_STEPS) * 100) / 100;
}
function sensitivityToIndex(value: number): number {
	return Math.round(value * SENSITIVITY_STEPS);
}

function WakeWordSensitivityControl({
	t,
	value,
	update,
}: WakeWordSensitivityControlProps): ReactNode {
	return (
		<FormControl
			caption={t("wakeWordSensitivityCaption")}
			label={t("wakeWordSensitivity")}
			tooltip={t("wakeWordSensitivityTooltip")}
		>
			<ElevatedSurface className="p-3">
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
			caption={t("wakeWordTimeoutCaption")}
			label={t("wakeWordTimeout")}
			tooltip={t("wakeWordTimeoutTooltip")}
		>
			<ElevatedSurface className="p-3">
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
				<FormControl
					caption={t("recordingModeCaption")}
					label={t("recordingMode")}
					tooltip={t("recordingModeTooltip")}
				>
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
				<MuteSystemAudioControl
					general={general}
					isListenMode={isListenMode}
					t={t}
					update={update}
				/>
				{isListenMode ? null : (
					<FormControl
						caption={t("recordingSoundCaption")}
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

interface StartupFlags {
	autoStart: boolean;
	minimizeToTray: boolean;
	sendCrashReports: boolean;
	startMinimized: boolean;
}

function readBoolFlag(value: boolean | undefined, fallback: boolean): boolean {
	return value ?? fallback;
}

function readStartupFlags(general: GeneralSettings | undefined): StartupFlags {
	return {
		autoStart: readBoolFlag(general?.autoStart, false),
		startMinimized: readBoolFlag(general?.startMinimized, false),
		minimizeToTray: readBoolFlag(general?.minimizeToTray, true),
		// Opt-out by default — installers ship with reporting on. The toggle is
		// surfaced in the Startup section because the change only takes effect
		// at the next launch (Sentry's init can't be safely reversed at runtime).
		sendCrashReports: readBoolFlag(general?.sendCrashReports, true),
	};
}

function StartupSection({ t, general, update }: StartupSectionProps): ReactNode {
	const flags = readStartupFlags(general);
	return (
		<SettingSection icon={PowerSocket01Icon} title={t("startup")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<FormControl
					caption={t("startOnLoginCaption")}
					label={t("startOnLogin")}
					labelAddon={
						<Toggle checked={flags.autoStart} onCheckedChange={(v) => update({ autoStart: v })} />
					}
					tooltip={t("startOnLoginTooltip")}
				/>
				<FormControl
					caption={t("startMinimizedCaption")}
					label={t("startMinimized")}
					labelAddon={
						<Toggle
							checked={flags.startMinimized}
							onCheckedChange={(v) => update({ startMinimized: v })}
						/>
					}
					tooltip={t("startMinimizedTooltip")}
				/>
				<FormControl
					caption={t("minimizeToTrayCaption")}
					label={t("minimizeToTray")}
					labelAddon={
						<Toggle
							checked={flags.minimizeToTray}
							onCheckedChange={(v) => update({ minimizeToTray: v })}
						/>
					}
					tooltip={t("minimizeToTrayTooltip")}
				/>
				<FormControl
					caption={t("sendCrashReportsCaption")}
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
		<SettingSection
			description={ts("resetDescription")}
			icon={ArrowTurnBackwardIcon}
			title={ts("resetDefaults")}
		>
			<ConfirmDialog
				confirmLabel={ts("resetConfirm")}
				description={ts("resetDescription")}
				onConfirm={resetSettings}
				onOpenChange={setConfirmOpen}
				open={confirmOpen}
				title={ts("resetTitle")}
			/>
			<div className="flex justify-end">
				<Button
					className="h-8 rounded-md border border-error/40 bg-error/10 px-4 font-medium text-body text-error transition-colors duration-150 hover:bg-error/20"
					onClick={() => setConfirmOpen(true)}
				>
					{tc("reset")}
				</Button>
			</div>
		</SettingSection>
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
			<DisplaySection
				isListenMode={isListenMode}
				locale={locale}
				setLocale={setLocale}
				t={t}
				update={update}
			/>
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
		<FormControl
			caption={t("languageCaption")}
			label={t("language")}
			tooltip={t("languageTooltip")}
		>
			<ElevatedSurface inline>
				<SearchableSelect
					onChange={(v) => pickLocale(v, setLocale)}
					options={LANGUAGE_OPTIONS}
					value={locale}
				/>
			</ElevatedSurface>
		</FormControl>
	);
}

interface DisplayFlags {
	liveDisplayHidden: boolean;
	overlayEnabled: boolean;
	subDisabled: boolean;
}

function computeDisplayFlags(
	isListenMode: boolean,
	general: GeneralSettings | undefined,
	realtimeEnabled: boolean
): DisplayFlags {
	const showOverlay = general?.showRecordingOverlay ?? true;
	const overlayEnabled = !isListenMode && showOverlay;
	const subDisabled = !overlayEnabled;
	// The combined live-transcription picker is hidden entirely when realtime
	// transcription itself is off — without a realtime model there's nothing
	// to display. Individual overlay-dependent choices (in-overlay/both) are
	// disabled separately when the recording overlay is hidden — see
	// liveOverlayDisabled / buildLiveTranscriptionDisplayOptions.
	const liveDisplayHidden = !realtimeEnabled;
	return { overlayEnabled, subDisabled, liveDisplayHidden };
}

type LiveTranscriptionDisplayValue = "none" | "in-app" | "in-pill" | "both";

function isLiveTranscriptionDisplayValue(value: string): value is LiveTranscriptionDisplayValue {
	return value === "none" || value === "in-app" || value === "in-pill" || value === "both";
}

// The "in-overlay" and "both" choices render the live preview under the
// floating recording overlay, so they only make sense when that overlay is
// enabled. When it isn't, those options are disabled and any previously
// selected one collapses to "in-app".
function liveOverlayDisabled(general: GeneralSettings | undefined): boolean {
	return !(general?.showRecordingOverlay ?? true);
}

function needsOverlay(value: LiveTranscriptionDisplayValue): boolean {
	return value === "in-pill" || value === "both";
}

function effectiveLiveDisplay(
	value: LiveTranscriptionDisplayValue,
	overlayDisabled: boolean
): LiveTranscriptionDisplayValue {
	return overlayDisabled && needsOverlay(value) ? "in-app" : value;
}

// Patch applied when the recording-overlay toggle flips. Turning the overlay
// off also collapses an overlay-dependent live-display choice down to
// "in-app" in the same update so the picker can't keep an impossible value.
function overlayTogglePatch(
	enabled: boolean,
	general: GeneralSettings | undefined
): Partial<GeneralSettings> {
	if (enabled) {
		return { showRecordingOverlay: true };
	}
	const current: LiveTranscriptionDisplayValue = general?.liveTranscriptionDisplay ?? "both";
	if (needsOverlay(current)) {
		return { showRecordingOverlay: false, liveTranscriptionDisplay: "in-app" };
	}
	return { showRecordingOverlay: false };
}

function checkedOrFalseIfDisabled(disabled: boolean, value: boolean): boolean {
	return disabled ? false : value;
}

interface OverlayControlProps {
	general: GeneralSettings | undefined;
	isListenMode: boolean;
	subDisabled: boolean;
	t: GeneralT;
	update: UpdateFn;
}

function OverlayControl({
	t,
	isListenMode,
	subDisabled,
	general,
	update,
}: OverlayControlProps): ReactNode {
	const showOverlay = general?.showRecordingOverlay ?? true;
	const size = general?.visualizerSize ?? "sm";
	return (
		<FormControl
			caption={t("showRecordingOverlayCaption")}
			disabled={isListenMode}
			label={t("showRecordingOverlay")}
			labelAddon={
				<Toggle
					checked={checkedOrFalseIfDisabled(isListenMode, showOverlay)}
					disabled={isListenMode}
					onCheckedChange={(v) => update(overlayTogglePatch(v, general))}
				/>
			}
			tooltip={t("showRecordingOverlayTooltip")}
		>
			<ElevatedSurface className={subDisabled ? "pointer-events-none opacity-40" : undefined}>
				<Switcher
					fullWidth
					onChange={(v) => update({ visualizerSize: v })}
					options={VISUALIZER_SIZE_OPTIONS}
					value={size}
				/>
			</ElevatedSurface>
		</FormControl>
	);
}

function buildLiveTranscriptionDisplayOptions(
	t: GeneralT,
	overlayDisabled: boolean
): readonly {
	value: LiveTranscriptionDisplayValue;
	label: string;
	disabled?: boolean;
}[] {
	return [
		{ value: "none", label: t("liveTranscriptionDisplayNone") },
		{ value: "in-app", label: t("liveTranscriptionDisplayInApp") },
		{ value: "in-pill", label: t("liveTranscriptionDisplayInPill"), disabled: overlayDisabled },
		{ value: "both", label: t("liveTranscriptionDisplayBoth"), disabled: overlayDisabled },
	];
}

/** The 4-way union is conceptually two independent booleans — split for the UI. */
function liveDisplayToFlags(value: LiveTranscriptionDisplayValue): {
	inApp: boolean;
	inOverlay: boolean;
} {
	return {
		inApp: value === "in-app" || value === "both",
		inOverlay: value === "in-pill" || value === "both",
	};
}

function flagsToLiveDisplay(inApp: boolean, inOverlay: boolean): LiveTranscriptionDisplayValue {
	if (inApp && inOverlay) {
		return "both";
	}
	if (inApp) {
		return "in-app";
	}
	if (inOverlay) {
		return "in-pill";
	}
	return "none";
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
			caption={t("liveTranscriptionDisplayCaption")}
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

function pickVisualizerType(value: string, update: UpdateFn): void {
	if (isVisualizerType(value)) {
		update({ visualizerType: value });
	}
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
		<FormControl
			caption={t("visualizerTypeCaption")}
			label={t("visualizerType")}
			tooltip={t("visualizerTypeTooltip")}
		>
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
	const value = general?.visualizerBarCount ?? 9;
	return (
		<FormControl
			caption={t("visualizerBarCountCaption")}
			label={t("visualizerBarCount")}
			tooltip={t("visualizerBarCountTooltip")}
		>
			<ElevatedSurface className="p-3">
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

function isBarVisualizer(general: GeneralSettings | undefined): boolean {
	const type = general?.visualizerType ?? "bar";
	return type === "bar";
}

function DisplaySection({ isListenMode, locale, setLocale, t, update }: DisplaySectionProps) {
	const general = useSettingsStore((s) => s.settings.general);
	const realtimeEnabled = useSettingsStore(
		(s) => s.settings.quality?.enableRealtimeTranscription ?? true
	);
	const flags = computeDisplayFlags(isListenMode, general, realtimeEnabled);

	return (
		<SettingSection icon={DashboardCircleIcon} title={t("display")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<LanguageControl locale={locale} setLocale={setLocale} t={t} />
				<VisualizerTypeControl general={general} t={t} update={update} />
				<OverlayControl
					general={general}
					isListenMode={isListenMode}
					subDisabled={flags.subDisabled}
					t={t}
					update={update}
				/>
				{flags.liveDisplayHidden ? null : (
					<LiveTranscriptionDisplayControl general={general} t={t} update={update} />
				)}
				{isBarVisualizer(general) ? (
					<VisualizerBarCountControl general={general} t={t} update={update} />
				) : null}
			</div>
		</SettingSection>
	);
}

export const __general_settings_panel_test_helpers__ = {
	buildVisualizerTypeOptions,
	buildRecordingModeOptions,
	pickLocale,
	muteCaption,
	muteLevel,
	muteEnabled,
	reductionToIndex,
	indexToReduction,
	reductionStepLabel,
	computeDisplayFlags,
	liveOverlayDisabled,
	needsOverlay,
	effectiveLiveDisplay,
	overlayTogglePatch,
	buildLiveTranscriptionDisplayOptions,
	isLiveTranscriptionDisplayValue,
	checkedOrFalseIfDisabled,
	pickVisualizerType,
	isBarVisualizer,
	readBoolFlag,
	readStartupFlags,
	recordingModePatch,
	reconcileWakeWord,
	engineForKeyword,
	engineBadge,
	formatWakeWordLabel,
	buildWakeWordOptions,
	buildUnifiedWakeWordList,
	sensitivityFromIndex,
	sensitivityToIndex,
	DEFAULT_WAKE_WORD,
	PORCUPINE_FREE_KEYWORDS,
	OPENWAKEWORD_KEYWORDS,
	ALL_WAKE_WORDS,
};
