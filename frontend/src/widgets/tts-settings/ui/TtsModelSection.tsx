"use client";

import { PlayIcon, StopIcon, VolumeHighIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { HotkeyRecorder } from "@/features/record-hotkey";
import {
	listTtsVoices,
	onTtsCompleted,
	onTtsFailed,
	onTtsModelDownloadComplete,
	onTtsModelDownloadProgress,
	onTtsModelDownloadStart,
	onTtsStarted,
	type TtsVoiceCatalog,
	ttsCancel,
	ttsSpeak,
	ttsSpeakSelection,
} from "@/shared/api/ipc-client";
import { formatBytes } from "@/shared/lib/format-bytes";
import { Button } from "@/shared/ui/button";
import { DownloadProgressBar } from "@/shared/ui/download";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { IconButton } from "@/shared/ui/icon-button";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";

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
	const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
	const [download, setDownload] = useState<DownloadState>(INITIAL_DOWNLOAD);
	const [errorReason, setErrorReason] = useState<string | null>(null);

	const enabled = tts?.enabled ?? false;
	const voice = tts?.voice ?? "af_heart";
	const lang = tts?.lang ?? "en-us";
	const speed = tts?.speed ?? 1.0;
	const hotkey = tts?.hotkey ?? "";
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

	// Track in-flight synthesis so the Test button can flip to Stop. Server-
	// correlated request ids let us cancel the right one if multiple speakers
	// were ever stacked (today only one runs at a time, but the contract is
	// per-id and we honor it).
	useEffect(
		() =>
			onTtsStarted(({ requestId }) => {
				setActiveRequestId(requestId);
				setErrorReason(null);
			}),
		[]
	);
	useEffect(
		() =>
			onTtsCompleted(({ requestId }) => {
				setActiveRequestId((current) => (current === requestId ? null : current));
			}),
		[]
	);
	useEffect(
		() =>
			onTtsFailed(({ requestId, reason }) => {
				setActiveRequestId((current) => (current === requestId ? null : current));
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
	// preview (or any TTS) is playing.
	const handlePreviewToggle = useCallback(() => {
		if (activeRequestId) {
			ttsCancel(activeRequestId);
			return;
		}
		previewVoice(voice, lang);
	}, [activeRequestId, previewVoice, voice, lang]);

	const handleSpeedChange = useCallback(
		(next: number) => {
			update({ speed: next });
		},
		[update]
	);

	const handleHotkeyChange = useCallback(
		(next: string) => {
			update({ hotkey: next });
		},
		[update]
	);

	const handleDeviceChange = useCallback(
		(next: string) => {
			update({ device: next as DeviceValue });
		},
		[update]
	);

	const handleSpeakSelection = useCallback(() => {
		ttsSpeakSelection();
	}, []);

	const percentLabel =
		download.totalBytes > 0
			? t("downloadingProgress", {
					percent: Math.round(download.progress * 100).toString(),
					downloaded: formatBytes(download.downloadedBytes) ?? "0 B",
					total: formatBytes(download.totalBytes) ?? "0 B",
				})
			: t("downloading");

	const isSpeaking = activeRequestId !== null;
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
							aria-label={isSpeaking ? t("stopSpeaking") : t("previewVoice")}
							icon={<HugeiconsIcon icon={isSpeaking ? StopIcon : PlayIcon} size={16} />}
							onClick={handlePreviewToggle}
							tooltip={isSpeaking ? t("stopSpeaking") : t("previewVoice")}
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
				<FormControl caption={t("hotkeyHint")} label={t("hotkeyLabel")}>
					<HotkeyRecorder currentKey={hotkey} onKeyRecorded={handleHotkeyChange} />
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
					<div className="flex flex-wrap items-center gap-2">
						<Button
							className="h-8 rounded-md bg-surface-2 px-3 text-foreground text-sm ring-1 ring-divider hover:bg-surface-3"
							disabled={isSpeaking}
							onClick={handleSpeakSelection}
						>
							{t("speakSelection")}
						</Button>
					</div>
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
