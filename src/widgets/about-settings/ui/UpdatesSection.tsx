import { AppWindowIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import {
	type AboutAppInfo,
	onUpdaterStatus,
	type UpdaterStatusEntry,
	updaterCheckNow,
	updaterGetStatusHistory,
	updaterQuitAndInstall,
} from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { formatBytes } from "@/shared/lib/format-bytes";
import { Button } from "@/shared/ui/button";
import { ButtonGroup } from "@/shared/ui/button-group";
import { DownloadProgressBar } from "@/shared/ui/download";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { Toggle } from "@/shared/ui/toggle";
import type { AboutT } from "./types";

// Brand / product name - a proper noun that is identical in every locale.
const APP_NAME = "WinSTT";

function formatStatus(entry: UpdaterStatusEntry | null, t: AboutT): string {
	if (!entry) {
		return t("updatesStatusIdle");
	}
	switch (entry.status) {
		case "checking":
			return t("updatesStatusChecking");
		case "available":
			return t("updatesStatusAvailable", { version: entry.version ?? "?" });
		case "downloading":
			return t("updatesStatusDownloading");
		case "not-available":
			return t("updatesStatusUpToDate");
		case "downloaded":
			return t("updatesStatusDownloaded", { version: entry.version ?? "?" });
		case "error":
			return t("updatesStatusError", { message: entry.message ?? "" });
		default:
			return t("updatesStatusIdle");
	}
}

/** Compact "12.3 MB" style for the updater's download stats — full B→GB ladder. */
function fmt(value: number): string {
	return formatBytes(value, { minUnit: "B" }) ?? "0 B";
}

function formatDownloadStats(entry: UpdaterStatusEntry): string | undefined {
	const transferred = entry.transferred;
	const total = entry.total;
	const bps = entry.bytesPerSecond;
	if (
		typeof transferred !== "number" ||
		typeof total !== "number" ||
		total <= 0
	) {
		return;
	}
	const tally = `${fmt(transferred)} / ${fmt(total)}`;
	if (typeof bps !== "number" || bps <= 0) {
		return tally;
	}
	return `${tally} · ${fmt(bps)}/s`;
}

interface UpdatesStatusActionGroupProps {
	checking: boolean;
	isDownloaded: boolean;
	isDownloading: boolean;
	onCheck: () => void;
	onRestart: () => void;
	status: UpdaterStatusEntry["status"] | null;
	statusLabel: string;
	t: AboutT;
	version: string;
}

function VersionSegment({ t, version }: { t: AboutT; version: string }) {
	return (
		<div className="flex h-8 min-w-36 shrink-0 items-center gap-2 px-3 text-body">
			<span className="text-foreground-muted">{t("appVersion")}</span>
			<span className="min-w-0 truncate font-mono text-foreground tabular-nums">
				{version || "-"}
			</span>
		</div>
	);
}

function UpdatesStatusActionGroup({
	checking,
	isDownloaded,
	isDownloading,
	onCheck,
	onRestart,
	status,
	statusLabel,
	t,
	version,
}: UpdatesStatusActionGroupProps) {
	if (isDownloaded) {
		// Once downloaded, the only meaningful action is "restart now". The
		// accent text signals it's the recommended next step while staying inside
		// the joined status/action control.
		return (
			<ButtonGroup aria-label={t("updatesTitle")} className="w-full" connected>
				<VersionSegment t={t} version={version} />
				<Button
					aria-live="polite"
					className="h-8 min-w-0 flex-1 gap-2 px-3 font-medium text-accent text-body leading-normal transition-colors hover:bg-foreground/10"
					onClick={onRestart}
				>
					<HugeiconsIcon aria-hidden="true" icon={RefreshIcon} size={14} />
					<span className="min-w-0 truncate">
						{t("updatesRestartToInstall")}
					</span>
				</Button>
			</ButtonGroup>
		);
	}
	const disabled = checking || isDownloading;
	const actionLabel = (() => {
		if (isDownloading) {
			return t("updatesDownloading");
		}
		if (checking) {
			return t("updatesChecking");
		}
		if (status && status !== "idle") {
			return statusLabel;
		}
		return t("updatesCheckNow");
	})();
	return (
		<ButtonGroup aria-label={t("updatesTitle")} className="w-full" connected>
			<VersionSegment t={t} version={version} />
			<Button
				aria-live="polite"
				className="h-8 min-w-0 flex-1 gap-2 px-3 text-body text-foreground leading-normal transition-colors hover:bg-foreground/10 disabled:hover:bg-transparent"
				disabled={disabled}
				onClick={onCheck}
			>
				<HugeiconsIcon
					aria-hidden="true"
					className={cn(
						"shrink-0 text-foreground-muted",
						disabled && "animate-spin",
					)}
					icon={RefreshIcon}
					size={14}
				/>
				<span className="min-w-0 truncate">{actionLabel}</span>
			</Button>
		</ButtonGroup>
	);
}

function shouldAutoCheck(latestStatus: UpdaterStatusEntry | null): boolean {
	return latestStatus === null || latestStatus.status === "idle";
}

function latestHistoryStatus(
	history: UpdaterStatusEntry[],
): UpdaterStatusEntry | null {
	return history.at(-1) ?? null;
}

const handleRestart = () => {
	// Fire-and-forget — main will quit the app a tick later. The Promise
	// from invokeOrDefault may never settle in practice; we don't need it,
	// but `.catch(() => {})` keeps biome's no-floating-promises lint happy
	// without the void-as-statement trick.
	updaterQuitAndInstall().catch(() => {
		// Intentionally ignored: the app is shutting down anyway.
	});
};

export function UpdatesSection({ info, t }: { info: AboutAppInfo; t: AboutT }) {
	const receivePrereleaseUpdates = useSettingsStore(
		(s) => s.settings.general?.receivePrereleaseUpdates ?? false,
	);
	const update = useSettingsStore((s) => s.updateGeneralSettings);
	const [latestStatus, setLatestStatus] = useState<UpdaterStatusEntry | null>(
		null,
	);
	const [checking, setChecking] = useState(false);
	const autoCheckRequestedRef = useRef(false);

	const handleCheck = async () => {
		setChecking(true);
		try {
			const result = await updaterCheckNow({
				includePrereleaseUpdates: receivePrereleaseUpdates,
			});
			// If the main process can't trigger a check (dev mode / disabled),
			// flip the button back to idle immediately. No status event will
			// arrive to do it for us.
			if (!result.triggered) {
				setChecking(false);
			}
		} catch {
			setChecking(false);
		}
	};
	const handleAutoCheck = useEffectEvent(() => {
		void handleCheck();
	});
	const requestAutoCheck = useEffectEvent(
		(status: UpdaterStatusEntry | null) => {
			if (autoCheckRequestedRef.current || !shouldAutoCheck(status)) {
				return;
			}
			autoCheckRequestedRef.current = true;
			handleAutoCheck();
		},
	);

	useEffect(() => {
		let cancelled = false;
		updaterGetStatusHistory()
			.then((history) => {
				if (cancelled) {
					return;
				}
				// History is append-only; the freshest entry is at the end.
				const latest = latestHistoryStatus(history);
				setLatestStatus(latest);
				requestAutoCheck(latest);
			})
			.catch(() => {
				if (cancelled) {
					return;
				}
				setLatestStatus(null);
				requestAutoCheck(null);
			});
		const off = onUpdaterStatus((entry) => {
			setLatestStatus(entry);
			if (entry.status !== "checking") {
				setChecking(false);
			}
		});
		return () => {
			cancelled = true;
			off();
		};
	}, []);

	const isDownloading = latestStatus?.status === "downloading";
	const isDownloaded = latestStatus?.status === "downloaded";
	// Round the percent for display only; the raw value drives the bar.
	const percent =
		isDownloading && typeof latestStatus?.percent === "number"
			? latestStatus.percent
			: null;

	return (
		<SettingSection
			description={t("updatesDescription")}
			icon={AppWindowIcon}
			title={APP_NAME}
		>
			<div className="flex flex-col gap-3">
				{info.copyright ? (
					<span className="text-body text-foreground-muted">
						{info.copyright}
					</span>
				) : null}
				<UpdatesStatusActionGroup
					checking={checking}
					isDownloaded={isDownloaded}
					isDownloading={isDownloading}
					onCheck={handleCheck}
					onRestart={handleRestart}
					status={latestStatus?.status ?? null}
					statusLabel={formatStatus(latestStatus, t)}
					t={t}
					version={info.version}
				/>
				<SettingField
					isDefault={
						receivePrereleaseUpdates ===
						DEFAULT_SETTINGS.general.receivePrereleaseUpdates
					}
					label={t("receivePrereleaseUpdates")}
					labelAddon={
						<Toggle
							checked={receivePrereleaseUpdates}
							onCheckedChange={(v) => update({ receivePrereleaseUpdates: v })}
						/>
					}
					onReset={() =>
						update({
							receivePrereleaseUpdates:
								DEFAULT_SETTINGS.general.receivePrereleaseUpdates,
						})
					}
					tooltip={t("receivePrereleaseUpdatesCaption")}
				/>
				{isDownloading ? (
					<ElevatedSurface className="p-3">
						<DownloadProgressBar
							label={
								percent === null
									? t("updatesStatusDownloading")
									: t("updatesDownloadingPercent", {
											percent: Math.round(percent),
										})
							}
							percent={percent}
							{...(latestStatus
								? (() => {
										const stats = formatDownloadStats(latestStatus);
										return stats ? { statsLabel: stats } : {};
									})()
								: {})}
							variant="active"
						/>
					</ElevatedSurface>
				) : null}
			</div>
		</SettingSection>
	);
}
