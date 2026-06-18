import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";
import {
	Elevated,
	surfaceBg,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { DownloadActions, DownloadProgressBar } from "@/shared/ui/download";
import { Toggle } from "@/shared/ui/toggle";
import type { EncoderModel } from "../lib/use-encoder-model";

function mb(bytes: number): string {
	return `${Math.round(bytes / 1_000_000)} MB`;
}

function speed(bps: number): string {
	return bps >= 1_000_000
		? `${(bps / 1_000_000).toFixed(1)} MB/s`
		: `${Math.round(bps / 1000)} KB/s`;
}

/** Surfaced neutral button (destructive on hover) for deleting the downloaded model. Rendered inside
 *  the card's {@link Elevated}, so `useSurface()` reads the card level and lifts the button one step
 *  above it — matching the shared {@link DownloadActions} button treatment. */
function DeleteModelButton({
	label,
	onClick,
}: {
	label: string;
	onClick: () => void;
}): ReactNode {
	const substrate = useSurface();
	return (
		<Button
			className={cn(
				"inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-foreground-secondary text-xs transition-colors hover:text-error",
				surfaceBg(Math.min(substrate + 1, 8)),
				surfaceHoverBg(Math.min(substrate + 2, 8)),
			)}
			onClick={onClick}
		>
			<HugeiconsIcon icon={Delete02Icon} size={13} />
			<span>{label}</span>
		</Button>
	);
}

interface EncoderModelCardProps {
	/** Master on/off for the on-device dictionary feature. */
	enabled: boolean;
	model: EncoderModel;
	/** Enable/disable the feature. Does NOT touch the download — the model stays on disk so
	 *  re-enabling is instant. Deleting the model is a separate, explicit action (the trash button). */
	onToggle: (enabled: boolean) => void;
}

/**
 * On-device model gate for the dictionary's NON-LLM fallback. Shown only when LLM cleanup is off
 * (the caller gates on that): the dictionary needs the small encoder model to work without an LLM.
 *
 * Rendered as an elevated surface card (lifts a step above the settings panel substrate so it reads
 * as a real raised control). The header toggle is the master switch — it only enables/disables the
 * feature and never deletes the download, so toggling off then on is instant. The body offers managed
 * download (start/pause/resume/cancel via the shared {@link DownloadActions}, so the buttons are
 * surfaced and grouped consistently with the rest of the app); once present it collapses to a status
 * line plus an explicit "Delete" action to reclaim the ~310 MB on disk.
 */
export function EncoderModelCard({
	model: m,
	enabled,
	onToggle,
}: EncoderModelCardProps): ReactNode {
	const t = useTranslations("dictionary");
	const common = useTranslations("common");

	const percent = m.totalBytes > 0 ? Math.round(m.progress * 100) : null;
	// Show the downloaded size even when the total isn't known yet (a partial restored from a previous
	// session, before resume re-fetches the total) so the progress is never invisible.
	const bytesLabel =
		m.totalBytes > 0
			? `${mb(m.downloadedBytes)} / ${mb(m.totalBytes)}`
			: m.downloadedBytes > 0
				? mb(m.downloadedBytes)
				: null;
	const speedLabel =
		m.state === "downloading" && m.speedBps > 0 ? speed(m.speedBps) : null;

	const downloadActions = (
		<DownloadActions
			labels={{
				download: t("encoderDownload"),
				stop: t("encoderPause"),
				resume: t("encoderResume"),
				discard: common("cancel"),
			}}
			onDownload={m.start}
			onStop={m.pause}
			onResume={m.resume}
			onDiscard={m.cancel}
			phase={
				m.state === "paused"
					? "paused"
					: m.state === "downloading"
						? "active"
						: "idle"
			}
			size="sm"
		/>
	);

	let body: ReactNode = null;
	if (m.state === "present") {
		// Present -> status + an explicit delete (available even when the feature is off, so the disk
		// can be reclaimed without re-enabling).
		body = (
			<div className="flex items-center justify-between gap-2">
				{enabled ? (
					<span className="flex items-center gap-1.5 text-foreground-muted text-xs">
						<span
							className="size-1.5 rounded-full bg-success"
							aria-hidden="true"
						/>
						{t("encoderReady")}
					</span>
				) : (
					<span className="text-foreground-muted text-xs">
						{t("encoderDownloadedOff")}
					</span>
				)}
				<DeleteModelButton label={common("delete")} onClick={m.remove} />
			</div>
		);
	} else if (enabled && m.state === "absent") {
		body = downloadActions;
	} else if (enabled && m.state !== "loading") {
		// downloading | paused -> progress + caption + tri-state actions.
		body = (
			<div className="flex flex-col gap-2.5">
				{/* Bar only — the byte/speed caption is rendered as PLAIN text below so the
				    MB counter doesn't animate (DownloadProgressBar's label/statsLabel run
				    through AnimatedValueText, which jitters on every progress frame). */}
				<DownloadProgressBar
					percent={percent}
					variant={m.state === "paused" ? "paused" : "active"}
				/>
				<div className="flex items-center justify-between text-foreground-muted text-xs tabular-nums">
					<span>
						{m.state === "paused"
							? t("encoderPaused")
							: t("encoderDownloading")}
						{percent !== null ? ` · ${percent}%` : ""}
					</span>
					{bytesLabel ? (
						<span className="font-mono">
							{bytesLabel}
							{speedLabel ? ` · ${speedLabel}` : ""}
						</span>
					) : null}
				</div>
				{downloadActions}
			</div>
		);
	}

	return (
		<Elevated
			className="flex flex-col gap-3 rounded-lg p-3.5 ring-1 ring-divider/60"
			offset={1}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="font-medium text-sm">{t("encoderTitle")}</div>
					<div className="mt-0.5 text-foreground-muted text-xs leading-5">
						{t("encoderDescription")}
					</div>
				</div>
				<Toggle
					aria-label={t("encoderTitle")}
					checked={enabled}
					onCheckedChange={onToggle}
				/>
			</div>
			{body}
		</Elevated>
	);
}
