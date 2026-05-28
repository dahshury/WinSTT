import { Cancel01Icon, PauseIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { useTranslations } from "use-intl";
import { ttsInstallPause, ttsInstallResume } from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";
import { DownloadProgressBar } from "@/shared/ui/download";
import type { TtsDownloadProgress } from "../model/use-tts-download-progress";

export interface TtsInstallBannerProps {
	downloadProgress: TtsDownloadProgress;
	errorReason: string | null;
	installError: string | null;
	onCancelInstall: () => void;
	onRetry: () => void;
	t: ReturnType<typeof useTranslations>;
}

export function TtsInstallBanner({
	downloadProgress,
	errorReason,
	installError,
	onCancelInstall,
	onRetry,
	t,
}: TtsInstallBannerProps) {
	return (
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
							onClick={onCancelInstall}
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
						onClick={onRetry}
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
	);
}
