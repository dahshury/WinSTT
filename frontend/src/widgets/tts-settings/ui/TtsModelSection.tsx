import {
	Cancel01Icon,
	PauseIcon,
	PlayIcon,
	StopIcon,
	VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	SettingResetButton,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import {
	listTtsVoices,
	onTtsFailed,
	onTtsPlaybackEnded,
	onTtsPlaybackStarted,
	onTtsStarted,
	type TtsVoiceCatalog,
	ttsCancel,
	ttsInstallCancel,
	ttsInstallPause,
	ttsInstallResume,
	ttsSpeak,
} from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { DownloadProgressBar } from "@/shared/ui/download";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { IconButton } from "@/shared/ui/icon-button";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Spinner } from "@/shared/ui/spinner";
import { useTtsDownloadProgress } from "../model/use-tts-download-progress";
import { useTtsInstallGate } from "../model/use-tts-install-gate";
import { TtsInstallDialog } from "./TtsInstallDialog";

export interface TtsModelSectionProps {
	/** Reserved for future composition — currently the section pulls all state
	 * from the settings store and IPC client itself. */
	className?: string;
}

type DeviceValue = "auto" | "cuda" | "cpu";

// Sample sentence read aloud by the "Test voice" button. Static so the speed/
// voice change is the only audible variable.
const TEST_SAMPLE_FALLBACK = "The quick brown fox jumps over the lazy dog.";

// Voice ids encode language as a short prefix ("af_heart" → "a" → "en-us").
// When the catalog response provides an explicit `language` field we use that;
// this fallback only fires if the field is missing.
function deriveLanguage(voiceId: string): string {
	const prefix = voiceId.slice(0, 1).toLowerCase();
	switch (prefix) {
		case "a":
			return "en-us";
		case "b":
			return "en-gb";
		case "e":
			return "es";
		case "f":
			return "fr-fr";
		case "h":
			return "hi";
		case "i":
			return "it";
		case "j":
			return "ja";
		case "p":
			return "pt-br";
		case "z":
			return "zh";
		default:
			return "en-us";
	}
}

function buildVoiceOptions(catalog: TtsVoiceCatalog): SelectOption[] {
	// Each voice belongs to exactly one language, so listing them in language-
	// grouped order keeps the searchable list scannable even at 54 voices.
	const sorted = catalog.voices.toSorted((a, b) => {
		const langCmp = a.language.localeCompare(b.language);
		return langCmp === 0 ? a.label.localeCompare(b.label) : langCmp;
	});
	return sorted.map<SelectOption>((voice) => ({
		id: voice.id,
		label: `${voice.label} (${voice.language})`,
		badge: voice.language.split("-")[0]?.toUpperCase() ?? voice.language.toUpperCase(),
	}));
}

function buildDeviceOptions(t: ReturnType<typeof useTranslations>): SelectOption[] {
	return [
		{ id: "auto", label: t("deviceAuto") },
		{ id: "cuda", label: t("deviceCuda") },
		{ id: "cpu", label: t("deviceCpu") },
	];
}

export function TtsModelSection(_props: TtsModelSectionProps = {}) {
	const t = useTranslations("tts");
	const tts = useSettingsStore((s) => s.settings.tts);
	const update = useSettingsStore((s) => s.updateTtsSettings);

	const [catalog, setCatalog] = useState<TtsVoiceCatalog>({ voices: [], languages: [] });

	// The play/loading/stop affordance tracks *audible* playback via events
	// the main process broadcasts to every window — so it works even though
	// the audio queue lives in a different window (the settings window has
	// none). Lifecycle: `onTtsStarted` → loading (synthesis ~1s);
	// `onTtsPlaybackStarted` → speaking (audio actually playing);
	// `onTtsPlaybackEnded` → idle (buffered audio fully played out, not the
	// much-earlier `tts_complete`).
	const [playback, setPlayback] = useState<{ requestId: string | null; playing: boolean }>({
		requestId: null,
		playing: false,
	});
	const [errorReason, setErrorReason] = useState<string | null>(null);
	// Which voice the active preview belongs to — drives the per-row and
	// in-trigger play/stop/loading affordance. Set optimistically on click
	// (the request id isn't known until `onTtsStarted`) and cleared whenever
	// playback returns to idle.
	const [previewVoiceId, setPreviewVoiceId] = useState<string | null>(null);
	// Confirm-before-download gate (state + handlers live in the model
	// hook — see use-tts-install-gate). `handleEnabledToggle` only flips
	// the store's `enabled` flag after the user accepts the dialog.
	const {
		confirmOpen,
		estimate,
		probing,
		installPhase,
		installError,
		handleEnabledToggle,
		handleInstallConfirm,
		handleInstallCancel,
		closeConfirm,
		retryInstall,
	} = useTtsInstallGate();

	const enabled = tts?.enabled ?? false;
	const voice = tts?.voice ?? "af_heart";
	const speed = tts?.speed ?? DEFAULT_SETTINGS.tts.speed;
	const device: DeviceValue = (tts?.device as DeviceValue) ?? "auto";

	// Fetch the voice catalog whenever the section becomes enabled. The IPC
	// layer caches the result on the main side, so re-enabling is cheap.
	useEffect(() => {
		if (!enabled) {
			return;
		}
		let cancelled = false;
		listTtsVoices().then((result) => {
			if (!cancelled) {
				setCatalog(result);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [enabled]);

	// Guard: TTS must always resolve to a voice the catalog actually offers.
	// The schema default ("af_heart") covers the common case, but a stale
	// saved voice (catalog change, corrupted settings) would otherwise leave
	// the dropdown in an empty-selection state and crash synth at request
	// time. Auto-fall back to the first catalog entry so the selector stays
	// in a usable state.
	useEffect(() => {
		if (!enabled || catalog.voices.length === 0) {
			return;
		}
		const valid = catalog.voices.some((v) => v.id === voice);
		if (valid) {
			return;
		}
		const first = catalog.voices[0];
		if (first) {
			update({ voice: first.id, lang: first.language });
		}
	}, [enabled, catalog.voices, voice, update]);

	useEffect(
		() =>
			onTtsStarted(({ requestId }) => {
				setPlayback({ requestId, playing: false });
				setErrorReason(null);
			}),
		[]
	);
	useEffect(
		() =>
			onTtsPlaybackStarted(({ requestId }) => {
				// Synthesis gap is over, audio is now playing. Exact-match so
				// a stale start from a superseded preview can't promote the
				// wrong request.
				setPlayback((p) => (p.requestId === requestId ? { requestId, playing: true } : p));
			}),
		[]
	);
	useEffect(
		() =>
			onTtsPlaybackEnded(({ requestId }) => {
				// Exact-match only. `onTtsStarted` always delivers the real id
				// before audio plays, so we never need a wildcard reset — and
				// a stale empty-id "ended" (from the cancel that precedes
				// every preview) must NOT clear the freshly-started request.
				setPlayback((p) => (p.requestId === requestId ? { requestId: null, playing: false } : p));
			}),
		[]
	);
	useEffect(
		() =>
			onTtsFailed(({ requestId, reason }) => {
				setPlayback((p) => (p.requestId === requestId ? { requestId: null, playing: false } : p));
				setErrorReason(reason);
			}),
		[]
	);

	// Reset the row affordance once audio stops, fails, or finishes — the
	// playback handlers above null out `requestId` on every terminal event.
	useEffect(() => {
		if (playback.requestId === null) {
			setPreviewVoiceId(null);
		}
	}, [playback.requestId]);

	const downloadProgress = useTtsDownloadProgress(installPhase);
	const voiceOptions = buildVoiceOptions(catalog);
	const deviceOptions = buildDeviceOptions(t);

	const langForVoice = useCallback(
		(voiceId: string) =>
			catalog.voices.find((v) => v.id === voiceId)?.language ?? deriveLanguage(voiceId),
		[catalog.voices]
	);

	// Speak a short sample in the given voice. Cancels any in-flight
	// playback first so rapid voice switching always previews the latest
	// pick (the renderer queue drops chunks whose request_id doesn't match
	// the active one, so an un-cancelled prior preview would otherwise
	// swallow the new one).
	const previewVoice = useCallback(
		(nextVoiceId: string, previewLang: string) => {
			ttsCancel();
			setPreviewVoiceId(nextVoiceId);
			ttsSpeak({
				text: t("testVoiceSample") || TEST_SAMPLE_FALLBACK,
				voice: nextVoiceId,
				lang: previewLang,
				speed,
			});
		},
		[t, speed]
	);

	const handleVoiceChange = useCallback(
		(nextVoice: string) => {
			// Each voice belongs to one language — derive it so the user doesn't
			// have to keep two pickers in sync. Prefer the catalog field when
			// present; fall back to the prefix heuristic for offline mode.
			const meta = catalog.voices.find((v) => v.id === nextVoice);
			const nextLang = meta?.language ?? deriveLanguage(nextVoice);
			update({ voice: nextVoice, lang: nextLang });
			// Picking a voice in the dropdown immediately previews it — the
			// preview lives in the selector itself, not a separate button.
			previewVoice(nextVoice, nextLang);
		},
		[catalog.voices, update, previewVoice]
	);

	const handleSpeedChange = useCallback(
		(next: number) => {
			update({ speed: next });
		},
		[update]
	);

	const handleDeviceChange = useCallback(
		(next: string) => {
			update({ device: next as DeviceValue });
		},
		[update]
	);

	const isLoading = playback.requestId !== null && !playback.playing;
	const isSpeaking = playback.requestId !== null && playback.playing;

	// Builds the play / loading / stop control for one voice. Used both as
	// the per-row button in the dropdown and as the in-trigger control for
	// the selected voice (closed state). Playback state is global, so only
	// the row matching `previewVoiceId` shows stop/spinner — every other row
	// stays a plain play button. `compact` shrinks it to fit a list row.
	const renderPreviewButton = useCallback(
		(targetVoiceId: string, compact: boolean) => {
			const active = previewVoiceId === targetVoiceId;
			const thisLoading = active && isLoading;
			const thisSpeaking = active && isSpeaking;
			let label = t("previewVoice");
			if (thisSpeaking) {
				label = t("stopSpeaking");
			} else if (thisLoading) {
				label = t("loadingVoice");
			}
			const icon = thisLoading ? (
				<Spinner className="size-4" />
			) : (
				<HugeiconsIcon icon={thisSpeaking ? StopIcon : PlayIcon} size={compact ? 14 : 16} />
			);
			const onClick = () => {
				if (thisSpeaking) {
					if (playback.requestId) {
						ttsCancel(playback.requestId);
					}
					return;
				}
				if (thisLoading) {
					return;
				}
				previewVoice(targetVoiceId, langForVoice(targetVoiceId));
			};
			return (
				<IconButton
					aria-label={label}
					className={compact ? "size-6" : undefined}
					disabled={thisLoading}
					icon={icon}
					onClick={onClick}
					tooltip={label}
				/>
			);
		},
		[previewVoiceId, isLoading, isSpeaking, t, playback.requestId, previewVoice, langForVoice]
	);
	const voicePlaceholder = voiceOptions.length === 0 ? t("noVoicesYet") : t("voiceCaption");

	// While the on-demand install is downloading OR sitting paused, every
	// settings control below the section header is locked. Two reasons:
	//   1. Voice / speed / device changes can't take effect until the
	//      engine is loaded — letting the user fiddle here pretends to
	//      change something it doesn't, then surprises them once the
	//      install finishes and the new settings retroactively apply.
	//   2. Server-side, swap_parameter on a half-initialized synthesizer
	//      races the warm-up executor. The pause/resume/cancel buttons
	//      in the install banner are the only legitimate interactions
	//      during this window.
	// `installPhase` covers the WHOLE install (engine → model → ready),
	// including the gaps between asset downloads (extraction, ORT session
	// init) where no progress events fire. `downloadProgress.active` is a
	// belt-and-suspenders backup for any window where bytes are streaming
	// before the next status ping arrives.
	const installing = installPhase !== null || downloadProgress.active;
	const handleCancelInstall = (): void => {
		ttsInstallCancel();
		// Cancel means "discard, I don't want this anymore" — flip the
		// toggle back off so the section returns to its pre-enable state
		// rather than sitting on `enabled: true` with no engine.
		update({ enabled: false });
	};

	return (
		<>
			<SettingSection
				description={t("description")}
				icon={VolumeHighIcon}
				onToggle={handleEnabledToggle}
				title={t("title")}
				toggleDisabled={installing}
				toggled={enabled}
			>
				<div className="flex flex-col divide-y divide-surface-1">
					<div
						className={cn(
							"flex flex-col divide-y divide-surface-1 transition-opacity duration-200 ease-out",
							installing && "pointer-events-none opacity-40"
						)}
					>
						<FormControl caption={voicePlaceholder} label={t("voice")}>
							<ElevatedSurface inline>
								<SearchableSelect
									inputTrailing={renderPreviewButton(voice, true)}
									onChange={handleVoiceChange}
									options={voiceOptions}
									placeholder={t("noVoicesYet")}
									renderItemTrailing={(option) => renderPreviewButton(option.id, true)}
									value={voice}
								/>
							</ElevatedSurface>
						</FormControl>
						<FormControl
							caption={t("speedCaption")}
							label={t("speed")}
							labelTrailing={
								<SettingResetButton
									isDefault={speed === DEFAULT_SETTINGS.tts.speed}
									onReset={() => update({ speed: DEFAULT_SETTINGS.tts.speed })}
								/>
							}
						>
							<ElevatedSurface inline>
								<Slider
									aria-label={t("speed")}
									formatValue={(v) => `${v.toFixed(1)}×`}
									max={2.0}
									min={0.5}
									onChange={handleSpeedChange}
									step={0.1}
									value={speed}
								/>
							</ElevatedSurface>
						</FormControl>
						<FormControl caption={t("deviceCaption")} label={t("device")}>
							<ElevatedSurface inline>
								<Select
									aria-label={t("device")}
									onChange={handleDeviceChange}
									options={deviceOptions}
									value={device}
								/>
							</ElevatedSurface>
						</FormControl>
					</div>
					<div className="flex flex-col gap-3 py-3">
						{downloadProgress.active ? (
							<div className="flex flex-col gap-2">
								<DownloadProgressBar
									label={downloadProgress.label}
									percent={downloadProgress.percent}
									variant={downloadProgress.paused ? "paused" : "active"}
								/>
								<div className="flex items-center justify-end gap-1.5">
									{downloadProgress.paused ? (
										<Button
											className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 text-foreground-secondary text-xs transition-colors hover:bg-surface-3"
											onClick={() => ttsInstallResume()}
											type="button"
										>
											<HugeiconsIcon icon={PlayIcon} size={13} />
											<span>{t("resumeInstall")}</span>
										</Button>
									) : (
										<Button
											className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 text-foreground-secondary text-xs transition-colors hover:bg-surface-3"
											onClick={() => ttsInstallPause()}
											type="button"
										>
											<HugeiconsIcon icon={PauseIcon} size={13} />
											<span>{t("pauseInstall")}</span>
										</Button>
									)}
									<Button
										className="inline-flex h-7 items-center gap-1.5 rounded-md border border-error/50 bg-error/10 px-2.5 text-error text-xs transition-colors hover:bg-error/20"
										onClick={handleCancelInstall}
										type="button"
									>
										<HugeiconsIcon icon={Cancel01Icon} size={13} />
										<span>{t("cancelInstall")}</span>
									</Button>
								</div>
							</div>
						) : null}
						{installError ? (
							<div className="flex items-start gap-2 rounded-md border border-error/40 bg-error/10 p-2 text-error text-xs">
								<div className="flex-1">
									<div className="font-medium">{t("installFailedTitle")}</div>
									<div className="opacity-90">{installError}</div>
								</div>
								<button
									className="rounded border border-error/60 px-2 py-0.5 font-medium text-error transition hover:bg-error/20"
									onClick={retryInstall}
									type="button"
								>
									{t("retry")}
								</button>
							</div>
						) : null}
						{errorReason && !installError ? (
							<div className="rounded-md border border-error/40 bg-error/10 p-2 text-error text-xs">
								<span className="font-medium">{t("errorTitle")}:</span> {errorReason}
							</div>
						) : null}
					</div>
				</div>
			</SettingSection>
			<TtsInstallDialog
				estimate={estimate}
				onCancel={handleInstallCancel}
				onClose={closeConfirm}
				onConfirm={handleInstallConfirm}
				open={confirmOpen && !probing}
			/>
		</>
	);
}
