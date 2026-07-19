import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { DialogActionButton } from "@/shared/ui/dialog";
import { DialogShell } from "@/shared/ui/dialog-shell";
import { DownloadActions, DownloadProgressBar } from "@/shared/ui/download";
import type {
	WakewordDownloadDialogProps,
	WakewordDownloadProgressProps,
} from "./wakeword-download.types";
import {
	wakewordDownloadPhase,
	wakewordDownloadStatsLabel,
	wakewordProgressPercent,
} from "./wakeword-download-utils";
import { WAKEWORD_DOWNLOAD_SIZE_LABEL } from "./recording-settings-types";

export function WakewordDownloadProgress({
	status,
}: WakewordDownloadProgressProps): ReactNode {
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
