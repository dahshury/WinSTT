import { useEffect, useState, type ReactNode } from "react";
import {
	onWakewordModelStatus,
	wakewordModelStatus,
	type WakewordModelStatusPayload,
} from "@/shared/api/ipc-client";
import { formatBytes } from "@/shared/lib/format-bytes";
import { DialogActionButton } from "@/shared/ui/dialog";
import { DialogShell } from "@/shared/ui/dialog-shell";
import { DownloadActions, DownloadProgressBar } from "@/shared/ui/download";
import { isLowerAccuracyWakeWord } from "../lib/recording-settings-helpers";
import {
	WAKEWORD_DOWNLOAD_SIZE_LABEL,
	WAKEWORD_MODEL_STATUS_DEFAULT,
} from "./recording-settings-types";

export function useWakewordModelStatus(): WakewordModelStatusPayload {
	const [status, setStatus] = useState<WakewordModelStatusPayload>(
		WAKEWORD_MODEL_STATUS_DEFAULT,
	);

	useEffect(() => {
		let mounted = true;
		wakewordModelStatus().then((next) => {
			if (mounted) {
				setStatus(next);
			}
		});
		const unsubscribe = onWakewordModelStatus((next) => setStatus(next));
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

function formatBytesPerSecond(bytes: number | null | undefined): string | null {
	const formatted = formatDownloadBytes(bytes);
	return formatted ? `${formatted}/s` : null;
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
	const speed = formatBytesPerSecond(status.speedBps);
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
	if (status.available) {
		return null;
	}
	if (status.downloading) {
		const percent = wakewordProgressPercent(status);
		const engineLabel = status.engineLabel ?? "wake word model";
		return (
			<div className="py-3">
				<DownloadProgressBar
					label={
						percent == null
							? `Preparing ${engineLabel}`
							: `${percent}% - downloading ${engineLabel}`
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
					label={`Paused - ${status.artifactLabel ?? "wake word files"}`}
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
				Wake word model download failed: {status.error}
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
	const phase = wakewordDownloadPhase(status);
	const flowStarted =
		enablePending ||
		phase !== "idle" ||
		!!status.error ||
		status.phase === "failed";
	const engineLabel = status.engineLabel ?? "wake word detection";
	const artifactLabel = status.artifactLabel ?? "wake word files";
	const description = flowStarted ? (
		<div className="flex flex-col gap-2">
			<p>
				Downloading {artifactLabel} for {engineLabel}. Your current recording
				mode stays active while this runs.
			</p>
			<p>
				Wake Word mode will be enabled automatically after the files are ready.
			</p>
		</div>
	) : (
		<div className="flex flex-col gap-2">
			<p>
				Wake Word mode needs a one-time local download for {engineLabel} (
				{status.downloadSizeLabel ?? WAKEWORD_DOWNLOAD_SIZE_LABEL}). The files
				stay on this device and are used to listen for the selected wake word.
			</p>
			{status.qualityLabel ? (
				<p className="text-warning">{status.qualityLabel}</p>
			) : null}
			<p>
				Your current recording mode will stay active during the download, then
				Wake Word mode will turn on automatically.
			</p>
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
					? "Downloading wake word files"
					: "Download wake word files?"
			}
			width={500}
		>
			{flowStarted ? (
				<>
					<DialogActionButton
						onClick={() => onOpenChange(false)}
						variant="neutral"
					>
						Hide
					</DialogActionButton>
					{phase === "active" ? (
						<DialogActionButton onClick={handleCancelDownload} variant="danger">
							Cancel download
						</DialogActionButton>
					) : null}
					<DownloadActions
						appearance="dialog"
						labels={{
							discard: "Cancel download",
							download: status.error ? "Retry" : "Download",
							resume: "Resume",
							stop: "Pause",
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
						Cancel
					</DialogActionButton>
					<DialogActionButton onClick={onStart} variant="accent">
						Download and enable
					</DialogActionButton>
				</>
			)}
		</DialogShell>
	);
}

interface WakewordRuntimeFallback {
	artifactLabel: string;
	downloadSizeLabel: string;
	engine: string;
	engineLabel: string;
	qualityLabel: string;
}

function wakewordRuntimeFallback(
	wakeWord: string | undefined,
): WakewordRuntimeFallback {
	const lowerAccuracy = isLowerAccuracyWakeWord(wakeWord);
	return lowerAccuracy
		? {
				artifactLabel: "sherpa-onnx KWS archive",
				downloadSizeLabel: WAKEWORD_DOWNLOAD_SIZE_LABEL,
				engine: "sherpa-kws",
				engineLabel: "sherpa-onnx custom wake words",
				qualityLabel: "Lower accuracy custom",
			}
		: {
				artifactLabel: "pvporcupine 1.9.5 wheel",
				downloadSizeLabel: "about 2 MB",
				engine: "porcupine-legacy",
				engineLabel: "Porcupine built-in wake words",
				qualityLabel: "High accuracy built-in",
			};
}

export function wakewordStatusWithRuntimeFallback(
	status: WakewordModelStatusPayload,
	wakeWord: string | undefined,
): WakewordModelStatusPayload {
	const fallback = wakewordRuntimeFallback(wakeWord);
	return {
		...status,
		artifactLabel: status.artifactLabel ?? fallback.artifactLabel,
		downloadSizeLabel: status.downloadSizeLabel ?? fallback.downloadSizeLabel,
		engine: status.engine ?? fallback.engine,
		engineLabel: status.engineLabel ?? fallback.engineLabel,
		phase:
			status.phase ??
			(status.available
				? "complete"
				: status.downloading
					? "downloading"
					: "idle"),
		qualityLabel: status.qualityLabel ?? fallback.qualityLabel,
	};
}
