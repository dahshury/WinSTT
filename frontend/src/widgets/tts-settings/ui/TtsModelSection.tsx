"use client";

import { PlayIcon, StopIcon, VolumeHighIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import {
	listTtsVoices,
	onTtsFailed,
	onTtsModelDownloadComplete,
	onTtsModelDownloadProgress,
	onTtsModelDownloadStart,
	onTtsPlaybackEnded,
	onTtsPlaybackStarted,
	onTtsStarted,
	type TtsVoiceCatalog,
	ttsCancel,
	ttsSpeak,
} from "@/shared/api/ipc-client";
import { formatBytes } from "@/shared/lib/format-bytes";
import { DownloadProgressBar } from "@/shared/ui/download";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { IconButton } from "@/shared/ui/icon-button";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Spinner } from "@/shared/ui/spinner";

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

interface DownloadState {
	active: boolean;
	downloadedBytes: number;
	progress: number;
	totalBytes: number;
}

const INITIAL_DOWNLOAD: DownloadState = {
	active: false,
	progress: 0,
	downloadedBytes: 0,
	totalBytes: 0,
};

export function TtsModelSection(_props: TtsModelSectionProps = {}) {
	const t = useTranslations("tts");
	const tts = useSettingsStore((s) => s.settings.tts);
	const update = useSettingsStore((s) => s.updateTtsSettings);

	const [catalog, setCatalog] = useState<TtsVoiceCatalog>({ voices: [], languages: [] });
	const [download, setDownload] = useState<DownloadState>(INITIAL_DOWNLOAD);

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

	const enabled = tts?.enabled ?? false;
	const voice = tts?.voice ?? "af_heart";
	const lang = tts?.lang ?? "en-us";
	const speed = tts?.speed ?? 1.0;
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

	// First-use download lifecycle. Reset to idle on completion so the bar
	// disappears once the model lands on disk (or the user cancels).
	useEffect(
		() =>
			onTtsModelDownloadStart(() => {
				setDownload({ ...INITIAL_DOWNLOAD, active: true });
			}),
		[]
	);
	useEffect(
		() =>
			onTtsModelDownloadProgress((payload) => {
				setDownload({
					active: true,
					progress: payload.progress,
					downloadedBytes: payload.downloadedBytes,
					totalBytes: payload.totalBytes,
				});
			}),
		[]
	);
	useEffect(
		() =>
			onTtsModelDownloadComplete(() => {
				setDownload(INITIAL_DOWNLOAD);
			}),
		[]
	);

	const voiceOptions = buildVoiceOptions(catalog);
	const deviceOptions = buildDeviceOptions(t);

	const handleEnabledToggle = useCallback(
		(next: boolean) => {
			update({ enabled: next });
		},
		[update]
	);

	// Speak a short sample in the given voice. Cancels any in-flight
	// playback first so rapid voice switching always previews the latest
	// pick (the renderer queue drops chunks whose request_id doesn't match
	// the active one, so an un-cancelled prior preview would otherwise
	// swallow the new one).
	const previewVoice = useCallback(
		(previewVoiceId: string, previewLang: string) => {
			ttsCancel();
			ttsSpeak({
				text: t("testVoiceSample") || TEST_SAMPLE_FALLBACK,
				voice: previewVoiceId,
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

	// Inline play/stop affordance next to the select: replays the current
	// voice without re-picking it, and doubles as a stop control while a
	// preview (or any TTS) is playing. Disabled (no-op) during the
	// synthesis-loading window — the button shows a spinner then.
	const handlePreviewToggle = useCallback(() => {
		if (playback.requestId !== null) {
			if (playback.playing) {
				ttsCancel(playback.requestId);
			}
			return;
		}
		previewVoice(voice, lang);
	}, [playback.requestId, playback.playing, previewVoice, voice, lang]);

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

	const percentLabel =
		download.totalBytes > 0
			? t("downloadingProgress", {
					percent: Math.round(download.progress * 100).toString(),
					downloaded: formatBytes(download.downloadedBytes) ?? "0 B",
					total: formatBytes(download.totalBytes) ?? "0 B",
				})
			: t("downloading");

	const isLoading = playback.requestId !== null && !playback.playing;
	const isSpeaking = playback.requestId !== null && playback.playing;
	let previewLabel = t("previewVoice");
	if (isSpeaking) {
		previewLabel = t("stopSpeaking");
	} else if (isLoading) {
		previewLabel = t("loadingVoice");
	}
	const previewIcon = isLoading ? (
		<Spinner className="size-4" />
	) : (
		<HugeiconsIcon icon={isSpeaking ? StopIcon : PlayIcon} size={16} />
	);
	const voicePlaceholder = voiceOptions.length === 0 ? t("noVoicesYet") : t("voiceCaption");

	return (
		<SettingSection
			description={t("description")}
			icon={VolumeHighIcon}
			onToggle={handleEnabledToggle}
			title={t("title")}
			toggled={enabled}
		>
			<div className="flex flex-col divide-y divide-surface-1">
				<FormControl caption={voicePlaceholder} label={t("voice")}>
					<div className="flex items-center gap-2">
						<div className="min-w-0 flex-1">
							<ElevatedSurface inline>
								<SearchableSelect
									onChange={handleVoiceChange}
									options={voiceOptions}
									placeholder={t("noVoicesYet")}
									value={voice}
								/>
							</ElevatedSurface>
						</div>
						<IconButton
							aria-label={previewLabel}
							disabled={isLoading}
							icon={previewIcon}
							onClick={handlePreviewToggle}
							tooltip={previewLabel}
						/>
					</div>
				</FormControl>
				<FormControl caption={t("speedCaption")} label={t("speed")}>
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
				<div className="flex flex-col gap-3 py-3">
					{download.active ? (
						<DownloadProgressBar
							label={percentLabel}
							percent={Math.round(download.progress * 100)}
							variant="active"
						/>
					) : null}
					{errorReason ? (
						<div className="rounded-md border border-error/40 bg-error/10 p-2 text-error text-xs">
							<span className="font-medium">{t("errorTitle")}:</span> {errorReason}
						</div>
					) : null}
				</div>
			</div>
		</SettingSection>
	);
}
