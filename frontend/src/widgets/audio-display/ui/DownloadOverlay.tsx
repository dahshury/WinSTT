"use client";

import { Progress } from "@base-ui/react/progress";
import { useTranslations } from "next-intl";
import { memo, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDownloadStore } from "@/features/model-download";
import { formatBytes } from "@/shared/lib/format-bytes";
import { Button } from "@/shared/ui/button";

const SIZE_FORMAT = { minUnit: "B", mbDecimals: 1, gbDecimals: 2, kbDecimals: 1 } as const;

function formatSpeed(bps: number): string {
	if (bps < 1024) {
		return `${bps.toFixed(0)} B/s`;
	}
	if (bps < 1024 * 1024) {
		return `${(bps / 1024).toFixed(1)} KB/s`;
	}
	return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

function formatEta(seconds: number): string {
	if (seconds <= 0) {
		return "";
	}
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Joins non-empty strings with a separator. */
function joinStats(parts: string[], sep = " \u00B7 "): string {
	return parts.filter(Boolean).join(sep);
}

export const DownloadOverlay = memo(function DownloadOverlay() {
	const {
		isDownloading,
		modelName,
		progress,
		downloadedBytes,
		totalBytes,
		speedBps,
		etaSeconds,
		cancelled,
		cancelDownload,
	} = useDownloadStore(
		useShallow((s) => ({
			isDownloading: s.isDownloading,
			modelName: s.modelName,
			progress: s.progress,
			downloadedBytes: s.downloadedBytes,
			totalBytes: s.totalBytes,
			speedBps: s.speedBps,
			etaSeconds: s.etaSeconds,
			cancelled: s.cancelled,
			cancelDownload: s.cancelDownload,
		}))
	);
	const t = useTranslations("download");

	const handleCancel = useCallback(() => {
		cancelDownload();
	}, [cancelDownload]);

	if (!isDownloading) {
		return null;
	}

	if (cancelled) {
		return (
			<div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-surface-secondary/90">
				<p className="font-medium text-error">{t("cancelled")}</p>
			</div>
		);
	}

	const statsLine = joinStats([
		totalBytes > 0
			? `${formatBytes(downloadedBytes, SIZE_FORMAT) ?? "0 B"} / ${
					formatBytes(totalBytes, SIZE_FORMAT) ?? "0 B"
				}`
			: "",
		speedBps > 0 ? formatSpeed(speedBps) : "",
		etaSeconds > 0 ? t("eta", { time: formatEta(etaSeconds) }) : "",
	]);

	return (
		<div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-surface-secondary/90">
			<Progress.Root className="flex w-3/4 max-w-sm flex-col gap-2" value={progress}>
				<p className="text-center font-medium text-foreground text-sm">
					{t("downloadingModel", { model: modelName ?? "" })}
				</p>

				<Progress.Track className="h-2.5 overflow-hidden rounded-full bg-surface-tertiary">
					<Progress.Indicator className="h-full rounded-full bg-teal transition-[width] duration-200 ease-out" />
				</Progress.Track>

				<div className="text-center font-mono text-foreground-muted text-xs tabular-nums">
					{progress == null ? "" : `${progress}%`}
					{statsLine && ` \u2014 ${statsLine}`}
				</div>
			</Progress.Root>

			<Button
				className="h-7 rounded-md border border-error bg-transparent px-3 font-medium text-error text-xs transition-colors duration-150 hover:bg-error-dim"
				onClick={handleCancel}
			>
				{t("cancel")}
			</Button>
		</div>
	);
});
