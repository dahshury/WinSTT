import { resolveEffectiveQuant, resolveQuantCache } from "@picker";
import type { ReactNode } from "react";
import type { useCatalogStore, useModelStateStore } from "@/entities/model-catalog";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { formatBytes } from "@/shared/lib/format-bytes";
import { surfaceClasses, useSurface } from "@/shared/lib/surface";
import { DialogActionButton } from "@/shared/ui/dialog";
import { DialogShell } from "@/shared/ui/dialog-shell";
import { DownloadActions, type DownloadPhase, DownloadProgressBar } from "@/shared/ui/download";
import { useDownloadStore } from "../model/download-store";

type StatesById = ReturnType<typeof useModelStateStore.getState>["statesById"];
type SystemInfo = ReturnType<typeof useModelStateStore.getState>["systemInfo"];

/** "12 MB / 30 MB · 2 MB/s" — drives the right-side caption on the dictation
 *  progress bar. Hidden when no total has been received yet (early frames). */
function formatStatsLine(downloaded: number, total: number, speed: number): string {
	const parts: string[] = [];
	if (total > 0) {
		parts.push(`${formatBytes(downloaded) ?? "0 B"} / ${formatBytes(total) ?? "0 B"}`);
	}
	if (speed > 0) {
		if (speed < 1024) {
			parts.push(`${speed.toFixed(0)} B/s`);
		} else if (speed < 1024 * 1024) {
			parts.push(`${(speed / 1024).toFixed(1)} KB/s`);
		} else {
			parts.push(`${(speed / (1024 * 1024)).toFixed(1)} MB/s`);
		}
	}
	return parts.join(" · ");
}

/** Byte size with this widget's legacy `<= 0 → "unknown"` sentinel. */
function sizeLabel(bytes: number | null | undefined): string {
	return formatBytes(bytes) ?? "unknown";
}

export interface DownloadConfirmationDialogProps {
	getModel: (
		id: string
	) => ReturnType<typeof useCatalogStore.getState>["getModel"] extends (id: string) => infer R
		? R
		: never;
	onCancel: () => void;
	pending: {
		kind: "main" | "realtime";
		modelId: string;
		previousModelId: string;
		quantization?: OnnxQuantization | undefined;
	} | null;
	statesById: StatesById;
	systemInfo: SystemInfo;
}

export function DownloadConfirmationDialog({
	pending,
	getModel,
	onCancel,
	statesById,
	systemInfo,
}: DownloadConfirmationDialogProps): ReactNode {
	return (
		<DownloadConfirmationContent
			getModel={getModel}
			onCancel={onCancel}
			pending={pending}
			statesById={statesById}
			systemInfo={systemInfo}
		/>
	);
}

function dialogTitle(phase: DownloadPhase): string {
	if (phase === "active") {
		return "Downloading model";
	}
	if (phase === "paused") {
		return "Resume download?";
	}
	return "Download model?";
}

function dialogSubtitle(
	phase: DownloadPhase,
	displayName: string,
	sizeSuffix: string,
	quantLabel: string
): ReactNode {
	if (phase === "active") {
		return (
			<>
				<span className="font-medium text-foreground">{displayName}</span>
				{sizeSuffix} is downloading at{" "}
				<span className="font-medium text-foreground">{quantLabel}</span>.
			</>
		);
	}
	if (phase === "paused") {
		return (
			<>
				<span className="font-medium text-foreground">{displayName}</span>
				{sizeSuffix} is partly downloaded at{" "}
				<span className="font-medium text-foreground">{quantLabel}</span>. Resume to finish, or
				discard to clear the partial files.
			</>
		);
	}
	return (
		<>
			<span className="font-medium text-foreground">{displayName}</span>
			{sizeSuffix} isn't downloaded yet at{" "}
			<span className="font-medium text-foreground">{quantLabel}</span>.
		</>
	);
}

const DIALOG_ACTION_LABELS = {
	download: "Download",
	stop: "Stop",
	discard: "Discard",
	resume: "Resume",
} as const;

function dismissLabel(phase: DownloadPhase): string {
	if (phase === "active") {
		return "Hide";
	}
	if (phase === "paused") {
		return "Close";
	}
	return "Cancel";
}

function resolveDownloadPhase(isDownloading: boolean, partialOnDisk: boolean): DownloadPhase {
	if (isDownloading) {
		return "active";
	}
	if (partialOnDisk) {
		return "paused";
	}
	return "idle";
}

type TargetCache = ReturnType<typeof resolveQuantCache>;
type ModelState = StatesById[string] | undefined;

interface DownloadFitness {
	availableLabel: string;
	estimatedLabel: string;
	isUncomfortable: boolean;
}

/** Hardware fitness — surface the same heuristic the picker uses, plus
 *  concrete numbers so the user can decide. We don't refuse — the user
 *  can always proceed at their own risk. */
function computeFitness(state: ModelState, systemInfo: SystemInfo): DownloadFitness {
	const hasGpu = !!systemInfo && systemInfo.gpus.length > 0;
	const isUncomfortable =
		!!state &&
		state.estimated_bytes > 0 &&
		(hasGpu ? !state.comfortable_on_gpu : !state.comfortable_on_cpu);
	const estimatedLabel =
		state && state.estimated_bytes > 0 ? sizeLabel(state.estimated_bytes) : "unknown";
	const availableLabel = hasGpu
		? `GPU VRAM: ${sizeLabel(systemInfo?.gpus[0]?.total_vram_bytes ?? 0)}`
		: `RAM: ${sizeLabel(systemInfo?.total_ram_bytes ?? 0)}`;
	return { isUncomfortable, estimatedLabel, availableLabel };
}

interface LiveDownload {
	downloadedBytes: number;
	progress: number | null;
	speedBps: number;
	totalBytes: number;
}

function ActiveProgress({ live }: { live: LiveDownload }): ReactNode {
	return (
		<DownloadProgressBar
			label={live.progress == null ? "Starting..." : `${live.progress}%`}
			percent={live.progress}
			statsLabel={formatStatsLine(live.downloadedBytes, live.totalBytes, live.speedBps)}
			variant="active"
		/>
	);
}

function PausedProgress({ targetCache }: { targetCache: TargetCache }): ReactNode {
	const pausedPercent =
		targetCache && targetCache.total_bytes > 0
			? Math.round((targetCache.progress ?? 0) * 100)
			: null;
	return (
		<DownloadProgressBar
			label={pausedPercent == null ? "Paused" : `Paused at ${pausedPercent}%`}
			percent={pausedPercent}
			statsLabel={formatStatsLine(
				targetCache?.downloaded_bytes ?? 0,
				targetCache?.total_bytes ?? 0,
				0
			)}
			variant="paused"
		/>
	);
}

function IdleInfoCard({
	infoLevel,
	targetCache,
	catalogBytes,
	fitness,
}: {
	catalogBytes: number;
	fitness: DownloadFitness;
	infoLevel: number;
	targetCache: TargetCache;
}): ReactNode {
	const pausedDownloaded = targetCache?.downloaded_bytes ?? 0;
	const pausedTotal = targetCache?.total_bytes ?? 0;
	// Prefer the per-quant byte count baked into the catalog by
	// `scripts/refresh_catalog.py` — that's the exact HF-reported download
	// size for the selected precision and is known offline. Fall back to
	// the partial-cache delta (resume scenario), then to the size_label hint.
	let sizeLine: string;
	if (pausedTotal > pausedDownloaded) {
		sizeLine = `Need to download: ${sizeLabel(pausedTotal - pausedDownloaded)}`;
	} else if (catalogBytes > 0) {
		sizeLine = `Download size: ${sizeLabel(catalogBytes)}`;
	} else {
		sizeLine = "Size: unknown for this variant";
	}
	return (
		<div
			className={`flex flex-col gap-1 rounded-md p-3 text-foreground-secondary text-xs ${surfaceClasses(infoLevel)}`}
		>
			<div>
				<span className="text-foreground">{sizeLine}</span>
			</div>
			<div>
				<span className="text-foreground">Estimated memory:</span> {fitness.estimatedLabel} ·{" "}
				{fitness.availableLabel}
			</div>
		</div>
	);
}

function DownloadConfirmationContent({
	pending,
	getModel,
	onCancel,
	statesById,
	systemInfo,
}: DownloadConfirmationDialogProps): ReactNode {
	// DialogShell raises the substrate by +4 for the popup; mirror that math
	// here (this component renders the shell, so its own useSurface() reads the
	// OUTER level) to lift the body info cards +1 above the popup. The footer
	// dismiss button uses DialogActionButton, which derives its own +1/+2 lift
	// from the popup surface — so it matches the other dialogs without us
	// recomputing the level here.
	const substrate = useSurface();
	const popupLevel = Math.min(substrate + 4, 8);
	const infoLevel = Math.min(popupLevel + 1, 8);
	const state = pending ? statesById[pending.modelId] : undefined;
	const info = pending ? getModel(pending.modelId) : undefined;
	// The precision the swap will actually load. When the user left the quant
	// on auto/default (""), the server re-resolves it per model (NeMo / Cohere
	// /… → int8 on non-CUDA); ``resolveEffectiveQuant`` mirrors that so the
	// dialog sizes + describes the file set that's really being fetched rather
	// than the (often already-cached) default export.
	const targetQuant = resolveEffectiveQuant(state, pending?.quantization ?? "");
	const targetCache = resolveQuantCache(state, targetQuant);
	const quantLabel = targetQuant === "" ? "default precision" : targetQuant;

	// This dialog drives the SAME per-quant streaming predownload the badges
	// use — NOT a model swap. Keeping ``activeMain`` unset is the whole point:
	// the picker never freezes / shows "Switching" while bytes flow, downloads
	// run in the background (parallel-safe), and the user switches to the model
	// explicitly once it's cached (the swap controller blocks switching TO a
	// still-downloading model). The legacy whole-model swap-download (which set
	// activeMain and locked the picker for the entire transfer) is gone.
	const downloadKey = `${pending?.modelId ?? ""}@${targetQuant}`;
	const quant = useDownloadStore((s) => s.quantDownloads[downloadKey]);
	const predownloadQuant = useDownloadStore((s) => s.predownloadQuant);
	const pauseQuantEntry = useDownloadStore((s) => s.pauseQuantEntry);
	const pauseQuantDownload = useDownloadStore((s) => s.pauseQuantDownload);
	const resumeQuantDownload = useDownloadStore((s) => s.resumeQuantDownload);
	const discardQuantCache = useDownloadStore((s) => s.discardQuantCache);

	const isThisDownloading = quant !== undefined && !quant.paused;
	// "Paused" covers both an explicitly-paused live entry and a partial left on
	// disk from a previous session (no live entry, resumable from the bytes).
	const partialOnDisk = targetCache?.state === "partial" || (quant?.paused ?? false);
	const phase: DownloadPhase = resolveDownloadPhase(isThisDownloading, partialOnDisk);
	const liveForBar: LiveDownload = {
		progress: quant?.progress ?? null,
		downloadedBytes: quant?.downloadedBytes ?? 0,
		totalBytes: quant?.totalBytes ?? 0,
		speedBps: quant?.speedBps ?? 0,
	};

	const fitness = computeFitness(state, systemInfo);
	const displayName = info?.displayName ?? pending?.modelId ?? "";
	// Exact HF download bytes for the selected quantization — baked into the
	// catalog by `scripts/refresh_catalog.py`. Zero when the catalog hasn't
	// covered this variant (custom models, fresh entries before next refresh).
	const catalogBytes = info?.sizeBytesByQuantization?.[targetQuant] ?? 0;
	// Header label still uses the human-readable param-derived hint
	// (`243 MB`) — the precise byte count goes in the IdleInfoCard.
	const sizeSuffix = info?.sizeLabel ? ` (${info.sizeLabel})` : "";

	// Download / Resume / Stop / Discard all act on the per-quant streaming
	// download for the precision that will actually load — never a swap.
	//
	// Starting / resuming a download is a BACKGROUND action: kick it off and
	// immediately dismiss this (modal) dialog so the user can keep using the
	// picker — switch to an already-cached model, queue more downloads, etc.
	// Live progress continues on the precision badge + the selector trigger;
	// ``onCancel`` only clears the dialog's pending-state, it does NOT cancel
	// the download.
	const startDownload = (): void => {
		if (pending) {
			predownloadQuant(pending.modelId, targetQuant);
		}
		onCancel();
	};
	const handleResume = (): void => {
		if (!pending) {
			return;
		}
		// A live paused entry resumes in place; a partial-on-disk with no live
		// entry restarts the stream, which the downloader continues from the
		// bytes already written.
		if (quant?.paused) {
			resumeQuantDownload(pending.modelId, targetQuant);
		} else {
			predownloadQuant(pending.modelId, targetQuant);
		}
		onCancel();
	};
	const handleStop = (): void => {
		if (!pending) {
			return;
		}
		// Optimistic local flip so the badge/dialog re-render as paused before
		// the server's confirmation lands; the partial bytes stay on disk.
		pauseQuantEntry(pending.modelId, targetQuant);
		pauseQuantDownload(pending.modelId, targetQuant);
	};

	const handleDiscard = (): void => {
		if (!pending) {
			return;
		}
		discardQuantCache(pending.modelId, targetQuant);
	};

	return (
		<DialogShell
			body={
				<div className="flex flex-col gap-3">
					{phase === "active" && <ActiveProgress live={liveForBar} />}
					{phase === "paused" && <PausedProgress targetCache={targetCache} />}
					{phase === "idle" && (
						<IdleInfoCard
							catalogBytes={catalogBytes}
							fitness={fitness}
							infoLevel={infoLevel}
							targetCache={targetCache}
						/>
					)}
					{fitness.isUncomfortable && phase !== "active" && (
						<div className="rounded-md border border-error/40 bg-error/10 p-3 text-error text-xs">
							⚠ This model may not run comfortably on your hardware. Loading may fail or
							transcription may be slow. You can continue at your own risk.
						</div>
					)}
				</div>
			}
			description={dialogSubtitle(phase, displayName, sizeSuffix, quantLabel)}
			onOpenChange={(next) => {
				if (!next) {
					onCancel();
				}
			}}
			open={pending !== null}
			title={dialogTitle(phase)}
			width={440}
		>
			<DialogActionButton onClick={onCancel} variant="neutral">
				{dismissLabel(phase)}
			</DialogActionButton>
			<DownloadActions
				labels={DIALOG_ACTION_LABELS}
				onDiscard={handleDiscard}
				onDownload={startDownload}
				onResume={handleResume}
				onStop={handleStop}
				phase={phase}
			/>
		</DialogShell>
	);
}
