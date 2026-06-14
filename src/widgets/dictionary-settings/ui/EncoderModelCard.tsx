import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { Button } from "@/shared/ui/button";
import { DownloadProgressBar } from "@/shared/ui/download/DownloadProgressBar";
import { useEncoderModel } from "../lib/use-encoder-model";

const PRIMARY_BTN =
	"rounded-md bg-accent px-3 py-1.5 font-medium text-sm text-white shadow-surface-1 transition-opacity hover:opacity-90 disabled:opacity-40";
const GHOST_BTN =
	"rounded-md px-3 py-1.5 text-sm text-foreground-muted transition-colors hover:bg-surface-6/80 hover:text-foreground";

function mb(bytes: number): string {
	return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * On-device model gate for the dictionary's NON-LLM fallback. Shown only when LLM cleanup is off
 * (the caller gates on that): the dictionary needs the small encoder model to work without an LLM,
 * so the user opts to download it here with full start/pause/resume/cancel + progress. Once present,
 * it collapses to a quiet "ready" line. (When LLM cleanup is on, this card isn't rendered at all —
 * the LLM does the dictionary.)
 */
export function EncoderModelCard(): ReactNode {
	const t = useTranslations("dictionary");
	const common = useTranslations("common");
	const m = useEncoderModel();

	if (m.state === "loading") {
		return null;
	}
	if (m.state === "present") {
		return (
			<div className="flex items-center gap-1.5 text-foreground-muted text-xs">
				<span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
				{t("encoderReady")}
			</div>
		);
	}

	const percent = m.totalBytes > 0 ? Math.round(m.progress * 100) : null;
	const stats =
		m.totalBytes > 0 ? `${mb(m.downloadedBytes)} / ${mb(m.totalBytes)}` : undefined;

	return (
		<div className="flex flex-col gap-2.5 rounded-lg bg-surface-3 p-3 ring-1 ring-divider/60">
			<div>
				<div className="font-medium text-sm">{t("encoderTitle")}</div>
				<div className="mt-0.5 text-foreground-muted text-xs leading-5">
					{t("encoderDescription")}
				</div>
			</div>

			{m.state === "absent" ? (
				<Button className={PRIMARY_BTN} onClick={m.start}>
					{t("encoderDownload")}
				</Button>
			) : (
				<>
					<DownloadProgressBar
						label={m.state === "paused" ? t("encoderPaused") : t("encoderDownloading")}
						percent={percent}
						variant={m.state === "paused" ? "paused" : "active"}
						{...(stats ? { statsLabel: stats } : {})}
					/>
					<div className="flex gap-2">
						{m.state === "downloading" ? (
							<Button className={GHOST_BTN} onClick={m.pause}>
								{t("encoderPause")}
							</Button>
						) : (
							<Button className={PRIMARY_BTN} onClick={m.resume}>
								{t("encoderResume")}
							</Button>
						)}
						<Button className={GHOST_BTN} onClick={m.cancel}>
							{common("cancel")}
						</Button>
					</div>
				</>
			)}
		</div>
	);
}
