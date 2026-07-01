import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";
import {
	onWakewordModelStatus,
	wakewordModelStatus,
	type WakewordModelStatusPayload,
} from "@/shared/api/ipc-client";
import { formatBytes, formatBytesPerSecond } from "@/shared/lib/format-bytes";
import { DialogActionButton } from "@/shared/ui/dialog";
import { DialogShell } from "@/shared/ui/dialog-shell";
import { DownloadActions, DownloadProgressBar } from "@/shared/ui/download";
import {
	WAKEWORD_DOWNLOAD_SIZE_LABEL,
	WAKEWORD_MODEL_STATUS_DEFAULT,
} from "./recording-settings-types";

export function useWakewordModelStatus(
	onStatus?: (next: WakewordModelStatusPayload) => void,
): WakewordModelStatusPayload {
	const [status, setStatus] = useState<WakewordModelStatusPayload>(
		WAKEWORD_MODEL_STATUS_DEFAULT,
	);
	const handleStatus = useEffectEvent((next: WakewordModelStatusPayload) => {
		setStatus(next);
		onStatus?.(next);
	});

	useEffect(() => {
		let mounted = true;
		wakewordModelStatus().then((next) => {
			if (mounted) {
				handleStatus(next);
			}
		});
		const unsubscribe = onWakewordModelStatus((next) => handleStatus(next));
		return () => {
			mounted = false;
			unsubscribe();
		};
	}, []);

	return status;
}

// Full B → KB → MB → GB ladder for the download overlay. MB/KB keep one decimal
// to match the original wake-word formatter (the shared default floors MB to
// whole numbers).
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

function wakewordProgressPercent(
	status: WakewordModelStatusPayload,
): number | null {
	return status.progress == null ? null : Math.round(status.progress * 100);
}

function wakewordDownloadStatsLabel(
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

function wakewordDownloadPhase(
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

export function WakewordDownloadProgress({
	status,
}: {
	status: WakewordModelStatusPayload;
}): ReactNode {
	const t = useTranslations("general");
	if (status.available) {
		return null;
	}
	if (status.downloading) {
		const percent = wakewordProgressPercent(status);
		const engineLabel =
			status.engineLabel ?? t("wakewordDownloadEngineFallback");
		return (
			<div className="py-3">
				<DownloadProgressBar
					label={
						percent == null
							? t("wakewordDownloadPreparing", { engineLabel })
							: t("wakewordDownloadProgressLabel", { percent, engineLabel })
					}
					percent={percent}
					statsLabel={wakewordDownloadStatsLabel(status)}
					variant="active"
				/>
			</div>
		);
	}
	if (status.phase === "paused") {
		return (
			<div className="py-3">
				<DownloadProgressBar
					label={t("wakewordDownloadPausedLabel", {
						artifactLabel:
							status.artifactLabel ?? t("wakewordDownloadFilesFallback"),
					})}
					percent={wakewordProgressPercent(status)}
					statsLabel={wakewordDownloadStatsLabel(status)}
					variant="paused"
				/>
			</div>
		);
	}
	if (status.error) {
		return (
			<div className="py-3 text-body-sm text-error">
				{t("wakewordDownloadFailed", { error: status.error })}
			</div>
		);
	}
	return null;
}

export interface WakewordDownloadDialogProps {
	enablePending: boolean;
	onCancelDownload: () => void;
	onOpenChange: (open: boolean) => void;
	onPause: () => void;
	onResume: () => void;
	onStart: () => void;
	open: boolean;
	status: WakewordModelStatusPayload;
}

export function WakewordDownloadDialog({
	enablePending,
	onCancelDownload,
	onOpenChange,
	onPause,
	onResume,
	onStart,
	open,
	status,
}: WakewordDownloadDialogProps): ReactNode {
	const t = useTranslations("general");
	const phase = wakewordDownloadPhase(status);
	const flowStarted =
		enablePending ||
		phase !== "idle" ||
		!!status.error ||
		status.phase === "failed";
	const engineLabel =
		status.engineLabel ?? t("wakewordDownloadDetectionFallback");
	const artifactLabel =
		status.artifactLabel ?? t("wakewordDownloadFilesFallback");
	const description = flowStarted ? (
		<div className="flex flex-col gap-2">
			<p>
				{t("wakewordDownloadInProgressDescription", {
					artifactLabel,
					engineLabel,
				})}
			</p>
			<p>{t("wakewordDownloadInProgressNote")}</p>
		</div>
	) : (
		<div className="flex flex-col gap-2">
			<p>
				{t("wakewordDownloadPromptDescription", {
					engineLabel,
					sizeLabel: status.downloadSizeLabel ?? WAKEWORD_DOWNLOAD_SIZE_LABEL,
				})}
			</p>
			{status.qualityLabel ? (
				<p className="text-warning">{status.qualityLabel}</p>
			) : null}
			<p>{t("wakewordDownloadPromptNote")}</p>
		</div>
	);
	const handleCancelDownload = () => {
		onCancelDownload();
		onOpenChange(false);
	};

	return (
		<DialogShell
			body={flowStarted ? <WakewordDownloadProgress status={status} /> : null}
			description={description}
			onOpenChange={onOpenChange}
			open={open}
			title={
				flowStarted
					? t("wakewordDownloadTitleInProgress")
					: t("wakewordDownloadTitlePrompt")
			}
			width={500}
		>
			{flowStarted ? (
				<>
					<DialogActionButton
						onClick={() => onOpenChange(false)}
						variant="neutral"
					>
						{t("wakewordDownloadHide")}
					</DialogActionButton>
					{phase === "active" ? (
						<DialogActionButton onClick={handleCancelDownload} variant="danger">
							{t("wakewordDownloadCancel")}
						</DialogActionButton>
					) : null}
					<DownloadActions
						appearance="dialog"
						labels={{
							discard: t("wakewordDownloadCancel"),
							download: status.error
								? t("wakewordDownloadRetry")
								: t("wakewordDownloadStart"),
							resume: t("wakewordDownloadResume"),
							stop: t("wakewordDownloadPause"),
						}}
						onDiscard={handleCancelDownload}
						onDownload={onStart}
						onResume={onResume}
						onStop={onPause}
						phase={phase}
					/>
				</>
			) : (
				<>
					<DialogActionButton
						onClick={() => onOpenChange(false)}
						variant="neutral"
					>
						{t("wakewordDownloadCancelPrompt")}
					</DialogActionButton>
					<DialogActionButton onClick={onStart} variant="accent">
						{t("wakewordDownloadAndEnable")}
					</DialogActionButton>
				</>
			)}
		</DialogShell>
	);
}
