import { CloudDownloadIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { useEffect, useState } from "react";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import {
	onUpdaterStatus,
	type UpdaterStatusEntry,
	updaterCheckNow,
	updaterGetStatusHistory,
	updaterQuitAndInstall,
} from "@/shared/api/ipc-client";
import { formatBytes } from "@/shared/lib/format-bytes";
import { DownloadProgressBar } from "@/shared/ui/download";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { Toggle } from "@/shared/ui/toggle";
import { AboutActionButton } from "./AboutActionButton";
import type { AboutT } from "./types";

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

interface UpdatesHeaderActionProps {
	checking: boolean;
	isDownloaded: boolean;
	isDownloading: boolean;
	onCheck: () => void;
	onRestart: () => void;
	t: AboutT;
}

function UpdatesHeaderAction({
	checking,
	isDownloaded,
	isDownloading,
	onCheck,
	onRestart,
	t,
}: UpdatesHeaderActionProps) {
	if (isDownloaded) {
		// Once downloaded, the only meaningful action is "restart now". The
		// accent text signals it's the recommended next step without leaving the
		// standard settings action-button surface.
		return (
			<AboutActionButton
				icon={RefreshIcon}
				onClick={onRestart}
				variant="accent"
			>
				{t("updatesRestartToInstall")}
			</AboutActionButton>
		);
	}
	const disabled = checking || isDownloading;
	const label = (() => {
		if (isDownloading) {
			return t("updatesDownloading");
		}
		if (checking) {
			return t("updatesChecking");
		}
		return t("updatesCheckNow");
	})();
	return (
		<AboutActionButton
			disabled={disabled}
			icon={RefreshIcon}
			iconClassName={disabled ? "animate-spin" : undefined}
			onClick={onCheck}
		>
			{label}
		</AboutActionButton>
	);
}

export function UpdatesSection({ t }: { t: AboutT }) {
	const receivePrereleaseUpdates = useSettingsStore(
		(s) => s.settings.general?.receivePrereleaseUpdates ?? false,
	);
	const update = useSettingsStore((s) => s.updateGeneralSettings);
	const [latestStatus, setLatestStatus] = useState<UpdaterStatusEntry | null>(
		null,
	);
	const [checking, setChecking] = useState(false);

	useEffect(() => {
		let cancelled = false;
		updaterGetStatusHistory().then((history) => {
			if (cancelled) {
				return;
			}
			// History is append-only; the freshest entry is at the end.
			setLatestStatus(history.at(-1) ?? null);
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

	const handleCheck = async () => {
		setChecking(true);
		const result = await updaterCheckNow({
			includePrereleaseUpdates: receivePrereleaseUpdates,
		});
		// If the main process can't trigger a check (dev mode / disabled),
		// flip the button back to idle immediately — no status event will
		// arrive to do it for us.
		if (!result.triggered) {
			setChecking(false);
		}
	};

	const handleRestart = () => {
		// Fire-and-forget — main will quit the app a tick later. The Promise
		// from invokeOrDefault may never settle in practice; we don't need it,
		// but `.catch(() => {})` keeps biome's no-floating-promises lint happy
		// without the void-as-statement trick.
		updaterQuitAndInstall().catch(() => {
			// Intentionally ignored: the app is shutting down anyway.
		});
	};

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
			headerAction={
				<UpdatesHeaderAction
					checking={checking}
					isDownloaded={isDownloaded}
					isDownloading={isDownloading}
					onCheck={handleCheck}
					onRestart={handleRestart}
					t={t}
				/>
			}
			icon={CloudDownloadIcon}
			title={t("updatesTitle")}
		>
			<div className="flex flex-col gap-3">
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
				) : (
					<ElevatedSurface className="px-3 py-2">
						<span className="text-body text-foreground-muted">
							{formatStatus(latestStatus, t)}
						</span>
					</ElevatedSurface>
				)}
			</div>
		</SettingSection>
	);
}
