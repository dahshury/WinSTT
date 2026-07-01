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
import { formatBytes, formatBytesPerSecond } from "@/shared/lib/format-bytes";
import { Button } from "@/shared/ui/button";
import { DownloadProgressBar } from "@/shared/ui/download";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { IconButton } from "@/shared/ui/icon-button";
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
	const speed = formatBytesPerSecond(bps, { minUnit: "B" });
	return speed ? `${tally} · ${speed}` : tally;
}

type StatusTone = "accent" | "success" | "error" | "muted";

/** Tone → text-color utility; the dot and (active/error) status spine read it
 *  via `currentColor`. Grayscale by default — the "good / up-to-date" state is a
 *  calm neutral dot, NOT a green LED — with colour reserved for in-flight work
 *  (accent) and failures (error). */
const TONE_TEXT: Record<StatusTone, string> = {
	accent: "text-accent",
	success: "text-foreground-secondary",
	error: "text-error",
	muted: "text-foreground-dim",
};

/** Map updater state → an at-a-glance tone. `checking` (a transient local flag)
 *  wins over the persisted entry so the indicator goes live the instant the user
 *  hits refresh. Grayscale at rest; accent only while work is in flight. */
function statusTone(
	status: UpdaterStatusEntry["status"] | null,
	checking: boolean,
): StatusTone {
	if (checking) {
		return "accent";
	}
	switch (status) {
		case "checking":
		case "available":
		case "downloading":
			return "accent";
		case "downloaded":
		case "not-available":
			return "success";
		case "error":
			return "error";
		default:
			return "muted";
	}
}

/** A small, flat status dot — no glow, no pulse. Activity is carried by the
 *  spinning refresh icon, so the dot stays a quiet at-a-glance colour cue
 *  (neutral at rest, accent while checking, red on error). */
function StatusDot({ tone }: { tone: StatusTone }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-flex size-1.5 shrink-0 rounded-full bg-current",
				TONE_TEXT[tone],
			)}
		/>
	);
}

/** Stacked "VERSION / 1.2.3" identity block anchoring the left of the bar. */
function VersionBlock({ t, version }: { t: AboutT; version: string }) {
	return (
		<div className="flex shrink-0 flex-col gap-1">
			<span className="font-medium text-2xs text-foreground-muted uppercase leading-none tracking-[0.16em]">
				{t("appVersion")}
			</span>
			<span className="font-mono font-semibold text-body text-foreground leading-none tabular-nums">
				{version || "—"}
			</span>
		</div>
	);
}

interface UpdateStatusBarProps {
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

/**
 * Compact "release console": an elevated bar with a light-catching top sheen,
 * the current version, a live status line with a small flat status dot, and a
 * single trailing action — a quiet refresh icon-button normally, an accent
 * "restart to install" CTA once an update is staged.
 */
function UpdateStatusBar({
	checking,
	isDownloaded,
	isDownloading,
	onCheck,
	onRestart,
	status,
	statusLabel,
	t,
	version,
}: UpdateStatusBarProps) {
	const tone = statusTone(status, checking);
	const disabled = checking || isDownloading;

	return (
		<ElevatedSurface className="overflow-hidden" inline>
			<div
				aria-label={t("updatesTitle")}
				className="relative flex items-center gap-3 py-2.5 pr-2 pl-4"
				role="toolbar"
			>
				{/* light-catching bevel along the top edge */}
				<span
					aria-hidden="true"
					className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-foreground/15 to-transparent"
				/>
				<VersionBlock t={t} version={version} />
				<span
					aria-hidden="true"
					className="h-7 w-px shrink-0 bg-divider-strong"
				/>
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<StatusDot tone={tone} />
					<span
						aria-live="polite"
						className="min-w-0 truncate text-body text-foreground-secondary"
						title={statusLabel}
					>
						{statusLabel}
					</span>
				</div>
				{isDownloaded ? (
					<Button
						className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 font-medium text-body text-on-accent shadow-action-accent transition-[background-color,box-shadow] hover:bg-accent-hover hover:shadow-action-accent-hover"
						onClick={onRestart}
					>
						<HugeiconsIcon aria-hidden="true" icon={RefreshIcon} size={14} />
						<span className="truncate">{t("updatesRestartToInstall")}</span>
					</Button>
				) : (
					<IconButton
						aria-label={t("updatesCheckNow")}
						className="group size-8 rounded-md"
						disabled={disabled}
						icon={
							<HugeiconsIcon
								aria-hidden="true"
								className={cn(
									"transition-transform duration-300 ease-out",
									disabled
										? "animate-spin"
										: "group-hover:-rotate-180 group-active:rotate-0",
								)}
								icon={RefreshIcon}
								size={15}
							/>
						}
						onClick={onCheck}
						tooltip={t("updatesCheckNow")}
					/>
				)}
			</div>
		</ElevatedSurface>
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
	// The local `checking` flag flips the instant the user hits refresh, before
	// any backend event lands — surface that immediately so the line never lags.
	const statusLabel = checking
		? t("updatesStatusChecking")
		: formatStatus(latestStatus, t);

	return (
		<SettingSection
			description={t("updatesDescription")}
			icon={AppWindowIcon}
			title={APP_NAME}
		>
			<div className="flex flex-col gap-3">
				<UpdateStatusBar
					checking={checking}
					isDownloaded={isDownloaded}
					isDownloading={isDownloading}
					onCheck={handleCheck}
					onRestart={handleRestart}
					status={latestStatus?.status ?? null}
					statusLabel={statusLabel}
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
				{info.copyright ? (
					<span className="px-0.5 text-[11px] text-foreground-dim leading-relaxed">
						{info.copyright}
					</span>
				) : null}
			</div>
		</SettingSection>
	);
}
