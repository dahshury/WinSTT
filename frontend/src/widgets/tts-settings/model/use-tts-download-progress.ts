import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
	onTtsModelDownloadComplete,
	onTtsModelDownloadProgress,
	onTtsModelDownloadStart,
	type TtsInstallPhase,
} from "@/shared/api/ipc-client";
import { formatBytes } from "@/shared/lib/format-bytes";

interface DownloadState {
	active: boolean;
	downloadedBytes: number;
	progress: number;
	totalBytes: number;
}

const INITIAL: DownloadState = { active: false, progress: 0, downloadedBytes: 0, totalBytes: 0 };

export interface TtsDownloadProgress {
	/** Whether a download is currently in flight (show the bar). */
	active: boolean;
	/**
	 * Bar label. Prefixed with the install phase ("Installing TTS
	 * engine…" → "Downloading voice model…") so the ~220 MB on-demand
	 * install reads as distinct steps, not one anonymous bar.
	 */
	label: string;
	/** Integer 0–100 for the progress bar. */
	percent: number;
}

/**
 * Tracks the on-demand TTS install download (engine pack → voice model
 * → voicepacks) and produces a phase-labelled progress descriptor.
 */
export function useTtsDownloadProgress(installPhase: TtsInstallPhase | null): TtsDownloadProgress {
	const t = useTranslations("tts");
	const [download, setDownload] = useState<DownloadState>(INITIAL);

	useEffect(() => onTtsModelDownloadStart(() => setDownload({ ...INITIAL, active: true })), []);
	useEffect(
		() =>
			onTtsModelDownloadProgress((p) =>
				setDownload({
					active: true,
					progress: p.progress,
					downloadedBytes: p.downloadedBytes,
					totalBytes: p.totalBytes,
				})
			),
		[]
	);
	useEffect(() => onTtsModelDownloadComplete(() => setDownload(INITIAL)), []);

	let phaseLabel: string | null = null;
	if (installPhase === "engine") {
		phaseLabel = t("installPhaseEngine");
	} else if (installPhase === "model") {
		phaseLabel = t("installPhaseModel");
	}

	const progressLabel =
		download.totalBytes > 0
			? t("downloadingProgress", {
					percent: Math.round(download.progress * 100).toString(),
					downloaded: formatBytes(download.downloadedBytes) ?? "0 B",
					total: formatBytes(download.totalBytes) ?? "0 B",
				})
			: t("downloading");

	return {
		active: download.active,
		percent: Math.round(download.progress * 100),
		label: phaseLabel ? `${phaseLabel} · ${progressLabel}` : progressLabel,
	};
}
