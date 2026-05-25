import {
	Certificate01Icon,
	CloudDownloadIcon,
	InformationCircleIcon,
	LicenseIcon,
	RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import {
	type AboutAppInfo,
	aboutGetAppInfo,
	aboutGetLicense,
	aboutGetNotices,
	onUpdaterStatus,
	type UpdaterStatusEntry,
	updaterCheckNow,
	updaterGetStatusHistory,
	updaterQuitAndInstall,
} from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";
import { DownloadProgressBar } from "@/shared/ui/download";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Toggle } from "@/shared/ui/toggle";

type AboutT = ReturnType<typeof useTranslations<"about">>;

const EMPTY_APP_INFO: AboutAppInfo = {
	copyright: "",
	electronVersion: "",
	nodeVersion: "",
	version: "",
};

function InfoRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-baseline justify-between gap-4 py-1 text-body">
			<span className="text-foreground-muted">{label}</span>
			<span className="font-mono text-foreground tabular-nums">{value || "—"}</span>
		</div>
	);
}

function AppInfoSection({ info, t }: { info: AboutAppInfo; t: AboutT }) {
	return (
		<SettingSection icon={InformationCircleIcon} title={t("appInfoTitle")}>
			<div className="flex flex-col gap-3">
				<div className="flex flex-col">
					<span className="font-semibold text-foreground text-title">WinSTT</span>
					<span className="text-body text-foreground-muted">{info.copyright}</span>
				</div>
				<ElevatedSurface className="px-3 py-2">
					<InfoRow label={t("appVersion")} value={info.version} />
					<InfoRow label={t("electronVersion")} value={info.electronVersion} />
					<InfoRow label={t("nodeVersion")} value={info.nodeVersion} />
				</ElevatedSurface>
				{/* Hugeicons free-tier attribution — required by the Hugeicons Free
				    License whenever the icon set is used. Keep this string
				    visible; do not gate it behind an expander. */}
				<p className="text-body text-foreground-muted">{t("hugeiconsAttribution")}</p>
			</div>
		</SettingSection>
	);
}

function TextBlock({ text }: { text: string }) {
	return (
		<ElevatedSurface className="p-0">
			<ScrollArea className="h-[360px] w-full" viewportClassName="p-3">
				<pre className="whitespace-pre-wrap break-words font-mono text-body text-foreground-secondary leading-relaxed">
					{text}
				</pre>
			</ScrollArea>
		</ElevatedSurface>
	);
}

function LicenseSection({ license, loading, t }: { license: string; loading: boolean; t: AboutT }) {
	return (
		<SettingSection
			description={t("licenseDescription")}
			icon={LicenseIcon}
			title={t("licenseTitle")}
		>
			<TextBlock text={loading ? t("loading") : license} />
		</SettingSection>
	);
}

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

/** Compact "12.3 MB" style — same scale set as DownloadActions etc. */
function formatBytes(value: number): string {
	if (!Number.isFinite(value) || value <= 0) {
		return "0 B";
	}
	const units = ["B", "KB", "MB", "GB"];
	let scaled = value;
	let unit = 0;
	while (scaled >= 1024 && unit < units.length - 1) {
		scaled /= 1024;
		unit += 1;
	}
	const precision = scaled >= 100 || unit === 0 ? 0 : 1;
	return `${scaled.toFixed(precision)} ${units[unit]}`;
}

function formatDownloadStats(entry: UpdaterStatusEntry): string | undefined {
	const transferred = entry.transferred;
	const total = entry.total;
	const bps = entry.bytesPerSecond;
	if (typeof transferred !== "number" || typeof total !== "number" || total <= 0) {
		return;
	}
	const tally = `${formatBytes(transferred)} / ${formatBytes(total)}`;
	if (typeof bps !== "number" || bps <= 0) {
		return tally;
	}
	return `${tally} · ${formatBytes(bps)}/s`;
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
		// emphasized accent color signals it's the recommended next step.
		return (
			<Button
				className="flex h-8 items-center gap-2 rounded-md bg-accent px-3 font-medium text-accent-contrast text-body transition-colors duration-150 hover:bg-accent/90"
				onClick={onRestart}
			>
				<HugeiconsIcon icon={RefreshIcon} size={12} />
				{t("updatesRestartToInstall")}
			</Button>
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
		<Button
			className="flex h-8 items-center gap-2 rounded-md border border-foreground/15 bg-foreground/5 px-3 font-medium text-body text-foreground transition-colors duration-150 hover:bg-foreground/10 disabled:cursor-not-allowed disabled:opacity-50"
			disabled={disabled}
			onClick={onCheck}
		>
			<HugeiconsIcon
				className={disabled ? "animate-spin" : undefined}
				icon={RefreshIcon}
				size={12}
			/>
			{label}
		</Button>
	);
}

function UpdatesSection({ t }: { t: AboutT }) {
	const receivePrereleaseUpdates = useSettingsStore(
		(s) => s.settings.general?.receivePrereleaseUpdates ?? false
	);
	const update = useSettingsStore((s) => s.updateGeneralSettings);
	const [latestStatus, setLatestStatus] = useState<UpdaterStatusEntry | null>(null);
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
		const result = await updaterCheckNow();
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
		isDownloading && typeof latestStatus?.percent === "number" ? latestStatus.percent : null;

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
				<FormControl
					caption={t("receivePrereleaseUpdatesCaption")}
					label={t("receivePrereleaseUpdates")}
					labelAddon={
						<Toggle
							checked={receivePrereleaseUpdates}
							onCheckedChange={(v) => update({ receivePrereleaseUpdates: v })}
						/>
					}
				/>
				{isDownloading ? (
					<ElevatedSurface className="px-3 py-3">
						<DownloadProgressBar
							label={
								percent === null
									? t("updatesStatusDownloading")
									: t("updatesDownloadingPercent", { percent: Math.round(percent) })
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
						<span className="text-body text-foreground-muted">{formatStatus(latestStatus, t)}</span>
					</ElevatedSurface>
				)}
			</div>
		</SettingSection>
	);
}

function NoticesSection({ loading, notices, t }: { loading: boolean; notices: string; t: AboutT }) {
	return (
		<SettingSection
			description={t("noticesDescription")}
			icon={Certificate01Icon}
			title={t("noticesTitle")}
		>
			<TextBlock text={loading ? t("loading") : notices} />
		</SettingSection>
	);
}

export function AboutSettingsPanel() {
	const t = useTranslations("about");
	const [info, setInfo] = useState<AboutAppInfo>(EMPTY_APP_INFO);
	const [license, setLicense] = useState("");
	const [notices, setNotices] = useState("");
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		Promise.all([aboutGetAppInfo(), aboutGetLicense(), aboutGetNotices()])
			.then(([appInfo, licenseText, noticesText]) => {
				if (cancelled) {
					return;
				}
				setInfo(appInfo);
				setLicense(licenseText);
				setNotices(noticesText);
				setLoading(false);
			})
			.catch(() => {
				if (cancelled) {
					return;
				}
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<div className="flex flex-col gap-2">
			<AppInfoSection info={info} t={t} />
			<UpdatesSection t={t} />
			<LicenseSection license={license} loading={loading} t={t} />
			<NoticesSection loading={loading} notices={notices} t={t} />
		</div>
	);
}
