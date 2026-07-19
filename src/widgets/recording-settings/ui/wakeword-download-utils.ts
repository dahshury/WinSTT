import type { WakewordModelStatusPayload } from "@/shared/api/ipc-client";
import { formatBytes, formatBytesPerSecond } from "@/shared/lib/format-bytes";
import { WAKEWORD_DOWNLOAD_SIZE_LABEL } from "./recording-settings-types";

function formatDownloadBytes(bytes: number | null | undefined): string | null {
	return formatBytes(bytes, { minUnit: "B", mbDecimals: 1 });
}

function formatDuration(seconds: number | null | undefined): string | null {
	if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
		return null;
	}
	if (seconds < 60) {
		return `${Math.max(1, Math.round(seconds))}s left`;
	}
	const minutes = Math.floor(seconds / 60);
	const remainder = Math.round(seconds % 60);
	return remainder === 0
		? `${minutes}m left`
		: `${minutes}m ${remainder}s left`;
}

export function wakewordProgressPercent(
	status: WakewordModelStatusPayload,
): number | null {
	return status.progress == null ? null : Math.round(status.progress * 100);
}

export function wakewordDownloadStatsLabel(
	status: WakewordModelStatusPayload,
): string {
	const downloaded = formatDownloadBytes(status.downloadedBytes);
	const total = formatDownloadBytes(status.totalBytes);
	const speed = formatBytesPerSecond(status.speedBps, {
		minUnit: "B",
		mbDecimals: 1,
	});
	const eta = formatDuration(status.etaSeconds);
	const byteLabel =
		downloaded && total
			? `${downloaded} / ${total}`
			: (downloaded ??
				status.downloadSizeLabel ??
				WAKEWORD_DOWNLOAD_SIZE_LABEL);
	return [byteLabel, speed, eta].filter(Boolean).join(" · ");
}

export function wakewordDownloadPhase(
	status: WakewordModelStatusPayload,
): "idle" | "active" | "paused" {
	if (status.downloading || status.phase === "downloading") {
		return "active";
	}
	if (status.phase === "paused") {
		return "paused";
	}
	return "idle";
}
