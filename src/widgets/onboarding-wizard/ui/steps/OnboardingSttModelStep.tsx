import {
	CheckmarkCircle02Icon,
	Download04Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";
import { useTranslations } from "use-intl";
import {
	resolveEffectiveQuant,
	resolveQuantCache,
	useCatalogStore,
	useModelStateStore,
} from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { useDownloadStore } from "@/features/model-download";
import { cn } from "@/shared/lib/cn";
import { quantDownloadSeedFromCache } from "@/shared/lib/download-progress-core";
import { formatBytes, formatBytesPerSecond } from "@/shared/lib/format-bytes";
import { SurfaceProvider } from "@/shared/lib/surface";
import {
	DownloadActions,
	type DownloadPhase,
	DownloadProgressBar,
} from "@/shared/ui/download";
import { FormControl } from "@/shared/ui/form-control";
import { Spinner } from "@/shared/ui/spinner";
import { useOnboardingWizardStore } from "../../model/wizard-store";

/**
 * First-run model step: ONE clear action — download the starter model — instead
 * of the full model picker (which new users had no way of knowing they had to
 * open). The starter model is whatever `settings.model` points at, which on a
 * fresh install is the schema default `"tiny"` — the same model the backend
 * spawn is already configured for (`--model tiny`). So no picker and no engine
 * swap are needed here: the engine's configured model just needs its weights on
 * disk, and the wizard's Next gate flips as soon as they land. Users who want a
 * bigger model switch in Settings after setup (the step says so).
 *
 * The download itself is the SAME per-quant background predownload the picker's
 * precision badges and the settings download dialog drive — pause/resume/cancel
 * capable, progress broadcast to every window via `useDownloadListener` (mounted
 * by OnboardingPage).
 */
export function OnboardingSttModelStep() {
	const t = useTranslations("download");
	const catalogLoaded = useCatalogStore((s) => s.isLoaded);
	const getModel = useCatalogStore((s) => s.getModel);
	const statesById = useModelStateStore((s) => s.statesById);
	const modelStatesLoaded = useModelStateStore((s) => s.isLoaded);
	const refreshModelState = useModelStateStore((s) => s.refresh);
	const setSttModelReady = useOnboardingWizardStore((s) => s.setSttModelReady);
	const settingsModel = useSettingsStore((s) => s.settings.model);
	const quantDownloads = useDownloadStore((s) => s.quantDownloads);
	const predownloadQuant = useDownloadStore((s) => s.predownloadQuant);
	const pauseQuantDownload = useDownloadStore((s) => s.pauseQuantDownload);
	const resumeQuantDownload = useDownloadStore((s) => s.resumeQuantDownload);
	const discardQuantCache = useDownloadStore((s) => s.discardQuantCache);

	useEffect(() => {
		refreshModelState();
	}, [refreshModelState]);

	const modelId = settingsModel.model;
	const info = modelId ? getModel(modelId) : undefined;
	const state = modelId ? statesById[modelId] : undefined;
	// The precision that will actually load: "auto" re-resolves to the server's
	// RAM/VRAM-aware pick (`effective_quantization`), mirroring the download
	// dialog so we fetch the file set the engine will really use.
	const targetQuantization = resolveEffectiveQuant(
		state,
		settingsModel.onnxQuantization,
	);
	const downloadQuantization =
		targetQuantization === "auto" ? "" : targetQuantization;
	const targetCache = resolveQuantCache(state, targetQuantization);
	const cacheSeed = quantDownloadSeedFromCache(targetCache);
	const ready = info !== undefined && targetCache?.state === "cached";
	const loading = !(catalogLoaded && modelStatesLoaded);

	useEffect(() => {
		setSttModelReady(ready);
	}, [ready, setSttModelReady]);

	const snapshot = quantDownloads[`${modelId}@${downloadQuantization}`];
	const downloading = snapshot !== undefined && !snapshot.paused;
	// "Paused" covers both an explicitly-paused live entry and a partial left on
	// disk from a previous session (resumable from the bytes already written).
	const partialOnDisk =
		targetCache?.state === "partial" || (snapshot?.paused ?? false);
	const phase: DownloadPhase = downloading
		? "active"
		: partialOnDisk
			? "paused"
			: "idle";

	const handleDownload = () => {
		predownloadQuant(modelId, downloadQuantization, "main", cacheSeed);
	};
	const handleStop = () => {
		pauseQuantDownload(modelId, downloadQuantization);
	};
	const handleResume = () => {
		// A live paused entry resumes in place; a partial-on-disk with no live
		// entry restarts the stream, which continues from the bytes on disk.
		if (snapshot?.paused) {
			resumeQuantDownload(modelId, downloadQuantization, "main", cacheSeed);
			return;
		}
		predownloadQuant(modelId, downloadQuantization, "main", cacheSeed);
	};
	const handleDiscard = () => {
		discardQuantCache(modelId, downloadQuantization);
	};

	// Exact HF download bytes for the target precision, baked into the catalog.
	// Zero / missing (fresh entries) just omits the size from the caption.
	const downloadSize = formatBytes(
		info?.sizeBytesByQuantization?.[downloadQuantization],
	);

	return (
		<div className="flex flex-col gap-3">
			<FormControl
				caption="One small download and dictation works. You can switch to a larger, more accurate model anytime in Settings."
				label="Starter speech model"
				layout="stacked"
			>
				{/* The card paints surface-2 explicitly; re-anchor the surface context
				    so the nested download controls (+1 lifts) land on surface-3, matching
				    the icon chip. */}
				<SurfaceProvider value={2}>
					<div
						className={cn(
							"flex flex-col gap-2.5 rounded-md px-3 py-2.5 ring-1",
							ready
								? "bg-success/10 ring-success/25"
								: "bg-surface-2 ring-divider",
						)}
					>
						<div className="flex items-center justify-between gap-3">
							<div className="flex min-w-0 items-center gap-2.5">
								<span
									aria-hidden
									className={cn(
										"flex size-8 shrink-0 items-center justify-center rounded-md",
										ready
											? "bg-success/15 text-success ring-1 ring-success/30"
											: "bg-surface-3 text-foreground-muted ring-1 ring-divider",
									)}
								>
									{loading ? (
										<Spinner className="size-3 border" />
									) : (
										<HugeiconsIcon
											icon={ready ? CheckmarkCircle02Icon : Download04Icon}
											size={14}
										/>
									)}
								</span>
								<span className="min-w-0">
									<span
										className={cn(
											"block truncate font-medium text-body",
											ready ? "text-success" : "text-foreground",
										)}
									>
										{info?.displayName ?? modelId ?? "Loading models"}
									</span>
									<span className="block text-body-sm text-foreground-muted">
										{cardSubline({
											downloadSize,
											loading,
											phase,
											ready,
											targetQuantization,
										})}
									</span>
								</span>
							</div>
							{loading || ready ? null : (
								<DownloadActions
									labels={{
										download: t("actionDownload"),
										stop: t("actionStop"),
										discard: t("actionDiscard"),
										resume: t("actionResume"),
									}}
									onDiscard={handleDiscard}
									onDownload={handleDownload}
									onResume={handleResume}
									onStop={handleStop}
									phase={phase}
									size="sm"
								/>
							)}
						</div>
						{!ready && phase !== "idle" ? (
							<CardProgress
								cacheSeed={cacheSeed}
								phase={phase}
								snapshot={snapshot}
								t={t}
							/>
						) : null}
					</div>
				</SurfaceProvider>
			</FormControl>
		</div>
	);
}

type DownloadT = ReturnType<typeof useTranslations<"download">>;
type QuantSnapshot = ReturnType<
	typeof useDownloadStore.getState
>["quantDownloads"][string];
type CacheSeed = ReturnType<typeof quantDownloadSeedFromCache>;

function quantLabel(targetQuantization: string): string {
	if (targetQuantization === "auto") {
		return "auto precision";
	}
	return targetQuantization || "default precision";
}

function cardSubline({
	downloadSize,
	loading,
	phase,
	ready,
	targetQuantization,
}: {
	downloadSize: string | null;
	loading: boolean;
	phase: DownloadPhase;
	ready: boolean;
	targetQuantization: string;
}): string {
	if (loading) {
		return "checking local cache";
	}
	const quant = quantLabel(targetQuantization);
	if (ready) {
		return `${quant} - downloaded and ready`;
	}
	if (phase === "active") {
		return `${quant} - downloading`;
	}
	if (phase === "paused") {
		return `${quant} - download paused`;
	}
	return downloadSize === null
		? `${quant} - ready to download`
		: `${quant} - ${downloadSize} download`;
}

/** "12 MB / 30 MB · 2 MB/s" — same composition as the download dialog's bar. */
function statsLine(downloaded: number, total: number, speed: number): string {
	const parts: string[] = [];
	if (total > 0) {
		parts.push(
			`${formatBytes(downloaded) ?? "0 B"} / ${formatBytes(total) ?? "0 B"}`,
		);
	}
	const speedText = formatBytesPerSecond(speed, {
		minUnit: "B",
		mbDecimals: 1,
	});
	if (speedText) {
		parts.push(speedText);
	}
	return parts.join(" · ");
}

function CardProgress({
	cacheSeed,
	phase,
	snapshot,
	t,
}: {
	cacheSeed: CacheSeed;
	phase: DownloadPhase;
	snapshot: QuantSnapshot | undefined;
	t: DownloadT;
}) {
	// A partial left on disk with no live entry has no snapshot — fall back to
	// the cache-derived seed so the paused bar still shows real byte counts.
	const percent = snapshot?.progress ?? cacheSeed?.progress ?? null;
	const downloadedBytes =
		snapshot !== undefined && snapshot.downloadedBytes > 0
			? snapshot.downloadedBytes
			: (cacheSeed?.downloadedBytes ?? 0);
	const totalBytes =
		snapshot !== undefined && snapshot.totalBytes > 0
			? snapshot.totalBytes
			: (cacheSeed?.totalBytes ?? 0);
	const activeLabel = percent === null ? t("progressStarting") : `${percent}%`;
	const pausedLabel =
		percent === null ? t("progressPaused") : t("progressPausedAt", { percent });
	return (
		<DownloadProgressBar
			label={phase === "active" ? activeLabel : pausedLabel}
			percent={percent}
			statsLabel={statsLine(
				downloadedBytes,
				totalBytes,
				phase === "active" ? (snapshot?.speedBps ?? 0) : 0,
			)}
			variant={phase === "active" ? "active" : "paused"}
		/>
	);
}
