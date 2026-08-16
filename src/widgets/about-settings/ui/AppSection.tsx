import { AppWindowIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
} from "@/entities/setting";
import {
	type AboutAppInfo,
	onUpdaterStatus,
	type UpdaterStatusEntry,
	updaterCheckNow,
	updaterGetStatusHistory,
	updaterQuitAndInstall,
} from "@/shared/api/ipc-client";
import { formatBytes, formatBytesPerSecond } from "@/shared/lib/format-bytes";
import { DownloadProgressBar } from "@/shared/ui/download";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { Toggle } from "@/shared/ui/toggle";
import { AboutActionButton } from "./AboutActionButton";
import type { AboutT, GeneralSettings, GeneralT, UpdateFn } from "./types";

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

interface StartupFlags {
	autoStart: boolean;
	minimizeToTray: boolean;
	sendCrashReports: boolean;
	startMinimized: boolean;
}

function readBoolFlag(value: boolean | undefined, fallback: boolean): boolean {
	return value ?? fallback;
}

// Copied verbatim from general-settings (FSD: a widget may not import another
// widget's lib). Reads the system-pref booleans with their schema fallbacks.
function readStartupFlags(general: GeneralSettings | undefined): StartupFlags {
	return {
		autoStart: readBoolFlag(general?.autoStart, false),
		startMinimized: readBoolFlag(general?.startMinimized, false),
		minimizeToTray: readBoolFlag(general?.minimizeToTray, true),
		sendCrashReports: readBoolFlag(general?.sendCrashReports, true),
	};
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
	// Fire-and-forget — main will quit the app a tick later. The Promise may
	// never settle in practice; we don't need it,
	// but `.catch(() => {})` keeps biome's no-floating-promises lint happy
	// without the void-as-statement trick.
	updaterQuitAndInstall().catch(() => {
		// Intentionally ignored: the app is shutting down anyway.
	});
};

interface AppSectionProps {
	general: GeneralSettings | undefined;
	info: AboutAppInfo;
	t: AboutT;
	tg: GeneralT;
	update: UpdateFn;
}

/**
 * The product section of the About tab: what you are running (version), whether
 * it is current (update status + the single action that changes that), and the
 * two switches that govern how it updates and how it launches.
 *
 * Deliberately plain settings content — a labelled version value, an aria-live
 * status sentence, and one *labelled* button. The former bespoke `role="toolbar"`
 * plate (micro-label + status dot + icon-only refresh) existed nowhere else in
 * the app, and an icon-only control for the tab's most important action read as
 * decoration rather than a button.
 */
export function AppSection({ general, info, t, tg, update }: AppSectionProps) {
	const receivePrereleaseUpdates = general?.receivePrereleaseUpdates ?? false;
	const startup = readStartupFlags(general);
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
	// The local `checking` flag flips the instant the user hits the button,
	// before any backend event lands — surface that immediately so the line
	// never lags.
	const statusLabel = checking
		? t("updatesStatusChecking")
		: formatStatus(latestStatus, t);
	// One busy notion drives both the disabled button and its spinning icon:
	// there is nothing useful to re-trigger while a check or a download runs.
	const busy = checking || isDownloading;

	return (
		<SettingSection
			boxed
			description={t("updatesDescription")}
			icon={AppWindowIcon}
			title={APP_NAME}
		>
			<div className="flex flex-col">
				<div className="flex flex-col divide-y divide-divider">
					<SettingField
						label={t("versionLabel")}
						labelAddon={
							<span className="font-mono text-body text-foreground-secondary tabular-nums">
								{info.version || "—"}
							</span>
						}
						layout="row"
					/>
					{/* `<output>` (implicit role="status") rather than a bare span with
					    aria-live: the codebase's prefer-tag-over-role convention. The
					    aria-label names the live region so the sentence is announced with
					    context ("Updates: You're on the latest version.") instead of
					    arriving bare. */}
					<div className="flex items-center gap-4 py-3">
						<output
							aria-label={t("updatesTitle")}
							aria-live="polite"
							className="min-w-0 flex-1 text-body text-foreground-secondary leading-snug"
						>
							{statusLabel}
						</output>
						{isDownloaded ? (
							<AboutActionButton
								icon={RefreshIcon}
								onClick={handleRestart}
								variant="accent"
							>
								{t("updatesRestartToInstall")}
							</AboutActionButton>
						) : (
							<AboutActionButton
								disabled={busy}
								icon={RefreshIcon}
								iconClassName={busy ? "animate-spin" : undefined}
								onClick={handleCheck}
							>
								{t("updatesCheckAction")}
							</AboutActionButton>
						)}
					</div>
					{isDownloading ? (
						<div className="py-3">
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
						</div>
					) : null}
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
					{/* Single "Start on login" switch — on launches WinSTT on sign-in,
					    minimized straight to the tray (autoStart + startMinimized +
					    minimizeToTray together); off disables auto-launch. The former
					    separate start-minimized / minimize-to-tray toggles are folded in. */}
					<SettingField
						isDefault={
							startup.autoStart === DEFAULT_SETTINGS.general.autoStart &&
							startup.startMinimized ===
								DEFAULT_SETTINGS.general.startMinimized &&
							startup.minimizeToTray === DEFAULT_SETTINGS.general.minimizeToTray
						}
						label={tg("startOnLogin")}
						labelAddon={
							<Toggle
								checked={startup.autoStart}
								onCheckedChange={(v) =>
									update(
										v
											? {
													autoStart: true,
													startMinimized: true,
													minimizeToTray: true,
												}
											: { autoStart: false, startMinimized: false },
									)
								}
							/>
						}
						onReset={() =>
							update({
								autoStart: DEFAULT_SETTINGS.general.autoStart,
								startMinimized: DEFAULT_SETTINGS.general.startMinimized,
								minimizeToTray: DEFAULT_SETTINGS.general.minimizeToTray,
							})
						}
						tooltip={tg("startOnLoginTooltip")}
					/>
					{/* Privacy control, so it stays a visible switch of its own rather
					    than being folded into anything: the user must be able to see at
					    a glance whether the app reports crashes, and turn it off in one
					    click. Dropped by mistake when StartupSection was merged in. */}
					<SettingField
						isDefault={
							startup.sendCrashReports ===
							DEFAULT_SETTINGS.general.sendCrashReports
						}
						label={tg("sendCrashReports")}
						labelAddon={
							<Toggle
								checked={startup.sendCrashReports}
								onCheckedChange={(v) => update({ sendCrashReports: v })}
							/>
						}
						onReset={() =>
							update({
								sendCrashReports: DEFAULT_SETTINGS.general.sendCrashReports,
							})
						}
						tooltip={tg("sendCrashReportsTooltip")}
					/>
				</div>
				{info.copyright ? (
					<span className="px-0.5 pt-3 pb-2 text-[11px] text-foreground-dim leading-relaxed">
						{info.copyright}
					</span>
				) : null}
			</div>
		</SettingSection>
	);
}
