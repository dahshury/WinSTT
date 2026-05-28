import { useTranslations } from "use-intl";
import type { TtsDownloadEstimatePayload } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { formatBytes } from "@/shared/lib/format-bytes";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { OptInDialog } from "@/shared/ui/opt-in-dialog";

export interface TtsInstallDialogProps {
	estimate: TtsDownloadEstimatePayload | null;
	onCancel: () => void;
	onClose: () => void;
	onConfirm: () => void;
	open: boolean;
}

/**
 * Confirm-before-download dialog for enabling TTS. Shows the exact size
 * breakdown (engine pack + voice model + voicepacks) so the user knows
 * what the one-time download costs — or an offline notice with a Retry
 * action when the server/internet can't be reached to size it.
 */
export function TtsInstallDialog({
	open,
	estimate,
	onConfirm,
	onCancel,
	onClose,
}: TtsInstallDialogProps) {
	const t = useTranslations("tts");
	const surface = useSurface();
	const level = Math.min(surface + 1, 8);
	const headerLevel = Math.min(surface + 2, 8);
	const offline = estimate?.unavailable === true;
	const totalLabel = formatBytes(estimate?.totalBytes ?? 0) ?? "0 B";

	const body = offline ? (
		<div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-warning">
			<span className="text-body leading-relaxed">{t("installOffline")}</span>
		</div>
	) : (
		<div className="flex flex-col gap-3">
			<span>{t("installIntro")}</span>
			<div
				className={cn(
					"flex flex-col overflow-hidden rounded-lg border border-border",
					surfaceBg(level)
				)}
			>
				{(estimate?.components ?? []).map((c) => (
					<div
						className="flex items-center justify-between border-surface-1 border-b px-3 py-2 text-body last:border-b-0"
						key={c.id}
					>
						<span className="text-foreground">{c.label}</span>
						{c.installed ? (
							<span className="font-medium text-success">{t("installComponentInstalled")}</span>
						) : (
							<span className="font-medium text-foreground-muted tabular-nums">
								{formatBytes(c.bytes) ?? "0 B"}
							</span>
						)}
					</div>
				))}
				<div
					className={cn(
						"flex items-center justify-between px-3 py-2 text-body",
						surfaceBg(headerLevel)
					)}
				>
					<span className="font-semibold text-foreground">{t("installTotalLabel")}</span>
					<span className="font-semibold text-accent tabular-nums">{totalLabel}</span>
				</div>
			</div>
			<span className="text-body-sm text-foreground-muted">{t("installFootnote")}</span>
		</div>
	);

	return (
		<OptInDialog
			body={body}
			cancelLabel={t("installCancel")}
			confirmLabel={offline ? t("installRetry") : t("installConfirm")}
			onCancel={onCancel}
			onConfirm={onConfirm}
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
			open={open}
			title={t("installTitle")}
		/>
	);
}
