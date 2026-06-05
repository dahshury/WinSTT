import {
	ArrowTurnBackwardIcon,
	AppWindowIcon,
	Certificate01Icon,
	CloudDownloadIcon,
	Delete02Icon,
	LicenseIcon,
	PowerSocket01Icon,
	RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import {
	type AboutAppInfo,
	aboutGetAppInfo,
	aboutGetLicense,
	aboutGetNotices,
	removeApplicationData,
	removeDownloadedModels,
	onUpdaterStatus,
	type UpdaterStatusEntry,
	updaterCheckNow,
	updaterGetStatusHistory,
	updaterQuitAndInstall,
} from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { DownloadProgressBar } from "@/shared/ui/download";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Toggle } from "@/shared/ui/toggle";

type AboutT = ReturnType<typeof useTranslations<"about">>;
type GeneralT = ReturnType<typeof useTranslations<"general">>;
type GeneralSettings = NonNullable<
	ReturnType<typeof useSettingsStore.getState>["settings"]["general"]
>;
type UpdateFn = (patch: Partial<GeneralSettings>) => void;

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

// Brand / product name — a proper noun that is identical in every locale (see
// the `IDENTICAL_BY_DESIGN` allowlist in tools/i18n/check-i18n.ts). Held in a
// constant so it isn't flagged as a translatable literal.
const APP_NAME = "WinSTT";

const EMPTY_APP_INFO: AboutAppInfo = {
	copyright: "",
	frameworkVersion: "",
	version: "",
	webview2Version: "",
};

function InfoRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-baseline justify-between gap-4 py-1 text-body">
			<span className="text-foreground-muted">{label}</span>
			<span className="font-mono text-foreground tabular-nums">
				{value || "—"}
			</span>
		</div>
	);
}

function AppInfoSection({ info, t }: { info: AboutAppInfo; t: AboutT }) {
	return (
		<SettingSection icon={AppWindowIcon} title={t("appInfoTitle")}>
			<div className="flex flex-col gap-3">
				<div className="flex flex-col">
					<span className="font-semibold text-foreground text-title">
						{APP_NAME}
					</span>
					<span className="text-body text-foreground-muted">
						{info.copyright}
					</span>
				</div>
				<ElevatedSurface className="px-3 py-2">
					<InfoRow label={t("appVersion")} value={info.version} />
					<InfoRow
						label={t("frameworkVersion")}
						value={info.frameworkVersion}
					/>
					<InfoRow label={t("webview2Version")} value={info.webview2Version} />
				</ElevatedSurface>
				{/* Hugeicons free-tier attribution — required by the Hugeicons Free
				    License whenever the icon set is used. Keep this string
				    visible; do not gate it behind an expander. */}
				<p className="text-body text-foreground-muted">
					{t("hugeiconsAttribution")}
				</p>
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

function LicenseSection({
	license,
	loading,
	t,
}: {
	license: string;
	loading: boolean;
	t: AboutT;
}) {
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
	if (
		typeof transferred !== "number" ||
		typeof total !== "number" ||
		total <= 0
	) {
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

function NoticesSection({
	loading,
	notices,
	t,
}: {
	loading: boolean;
	notices: string;
	t: AboutT;
}) {
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

interface StartupSectionProps {
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateFn;
}

function StartupSection({
	t,
	general,
	update,
}: StartupSectionProps): ReactNode {
	const flags = readStartupFlags(general);
	return (
		<SettingSection icon={PowerSocket01Icon} title={t("startup")}>
			<div className="flex flex-col divide-y divide-surface-1">
				{/* Single "Start on login" switch — on launches WinSTT on sign-in,
				    minimized straight to the tray (autoStart + startMinimized +
				    minimizeToTray together); off disables auto-launch. The former
				    separate start-minimized / minimize-to-tray toggles are folded in. */}
				<SettingField
					isDefault={
						flags.autoStart === DEFAULT_SETTINGS.general.autoStart &&
						flags.startMinimized === DEFAULT_SETTINGS.general.startMinimized &&
						flags.minimizeToTray === DEFAULT_SETTINGS.general.minimizeToTray
					}
					label={t("startOnLogin")}
					labelAddon={
						<Toggle
							checked={flags.autoStart}
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
					tooltip={t("startOnLoginTooltip")}
				/>
				<SettingField
					isDefault={
						flags.sendCrashReports === DEFAULT_SETTINGS.general.sendCrashReports
					}
					label={t("sendCrashReports")}
					labelAddon={
						<Toggle
							checked={flags.sendCrashReports}
							onCheckedChange={(v) => update({ sendCrashReports: v })}
						/>
					}
					onReset={() =>
						update({
							sendCrashReports: DEFAULT_SETTINGS.general.sendCrashReports,
						})
					}
					tooltip={t("sendCrashReportsTooltip")}
				/>
			</div>
		</SettingSection>
	);
}

interface ResetActionRowProps {
	actionClassName: string;
	buttonLabel: string;
	icon: IconSvgElement;
	onClick: () => void;
	summary: string;
	title: string;
}

function ResetActionRow({
	actionClassName,
	buttonLabel,
	icon,
	onClick,
	summary,
	title,
}: ResetActionRowProps) {
	return (
		<ElevatedSurface className="p-0">
			<div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex min-w-0 gap-3">
					<div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-foreground/5 text-foreground-muted ring-1 ring-divider">
						<HugeiconsIcon aria-hidden="true" icon={icon} size={16} />
					</div>
					<div className="flex min-w-0 flex-col gap-1">
						<span className="font-semibold text-foreground text-body">
							{title}
						</span>
						<p className="text-body text-foreground-muted leading-relaxed">
							{summary}
						</p>
					</div>
				</div>
				<Button
					className={cn(
						"flex min-h-[44px] w-full max-w-full shrink-0 items-center gap-2 rounded-md px-4 py-2 text-center font-medium text-body transition-colors duration-150 sm:w-auto",
						actionClassName,
					)}
					onClick={onClick}
				>
					<HugeiconsIcon aria-hidden="true" icon={icon} size={14} />
					<span className="min-w-0">{buttonLabel}</span>
				</Button>
			</div>
		</ElevatedSurface>
	);
}

function ResetSection(): ReactNode {
	const resetSettings = useSettingsStore((s) => s.resetSettings);
	const ts = useTranslations("settings");
	const tc = useTranslations("common");
	const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
	const [removeModelsConfirmOpen, setRemoveModelsConfirmOpen] = useState(false);
	const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
	const [
		deleteOllamaModelsWithModelCleanup,
		setDeleteOllamaModelsWithModelCleanup,
	] = useState(false);
	const [deleteOllamaModels, setDeleteOllamaModels] = useState(false);
	const [modelCleanupError, setModelCleanupError] = useState("");
	const [cleanupError, setCleanupError] = useState("");

	const handleRemoveDownloadedModels = () => {
		setModelCleanupError("");
		removeDownloadedModels(deleteOllamaModelsWithModelCleanup)
			.then((result) => {
				const issues = [...result.errors, ...result.ollamaErrors];
				if (issues.length > 0) {
					setModelCleanupError(issues.join("\n"));
					setRemoveModelsConfirmOpen(true);
				}
			})
			.catch((err) => {
				setModelCleanupError(err instanceof Error ? err.message : String(err));
				setRemoveModelsConfirmOpen(true);
			});
	};

	const handleRemoveApplicationData = () => {
		setCleanupError("");
		removeApplicationData(deleteOllamaModels).catch((err) => {
			setCleanupError(err instanceof Error ? err.message : String(err));
			setRemoveConfirmOpen(true);
		});
	};

	return (
		<>
			<ConfirmDialog
				cancelLabel={tc("cancel")}
				confirmLabel={ts("resetConfirm")}
				description={
					<div className="flex flex-col gap-2">
						<p>{ts("resetDescription")}</p>
						<p className="font-medium text-error">
							{ts("permanentActionWarning")}
						</p>
					</div>
				}
				onConfirm={resetSettings}
				onOpenChange={setResetConfirmOpen}
				open={resetConfirmOpen}
				title={ts("resetTitle")}
			/>
			<ConfirmDialog
				cancelLabel={tc("cancel")}
				confirmLabel={ts("removeDownloadedModelsConfirm")}
				description={
					<div className="flex flex-col gap-3">
						<p>{ts("removeDownloadedModelsDescription")}</p>
						<p className="font-medium text-error">
							{ts("permanentActionWarning")}
						</p>
						<div className="flex items-start justify-between gap-4 rounded-md border border-divider bg-foreground/5 p-3">
							<div className="flex min-w-0 flex-col gap-1">
								<span className="font-medium text-body text-foreground">
									{ts("removeApplicationDataOllama")}
								</span>
								<span className="text-body text-foreground-muted">
									{ts("removeApplicationDataOllamaDescription")}
								</span>
							</div>
							<Toggle
								aria-label={ts("removeApplicationDataOllama")}
								checked={deleteOllamaModelsWithModelCleanup}
								onCheckedChange={setDeleteOllamaModelsWithModelCleanup}
							/>
						</div>
						{modelCleanupError ? (
							<p className="whitespace-pre-line text-body text-error">
								{modelCleanupError}
							</p>
						) : null}
					</div>
				}
				onConfirm={handleRemoveDownloadedModels}
				onOpenChange={setRemoveModelsConfirmOpen}
				open={removeModelsConfirmOpen}
				title={ts("removeDownloadedModelsTitle")}
			/>
			<ConfirmDialog
				cancelLabel={tc("cancel")}
				confirmLabel={ts("removeApplicationDataConfirm")}
				description={
					<div className="flex flex-col gap-3">
						<p>{ts("removeApplicationDataDescription")}</p>
						<p className="font-medium text-error">
							{ts("permanentActionWarning")}
						</p>
						<div className="flex items-start justify-between gap-4 rounded-md border border-divider bg-foreground/5 p-3">
							<div className="flex min-w-0 flex-col gap-1">
								<span className="font-medium text-body text-foreground">
									{ts("removeApplicationDataOllama")}
								</span>
								<span className="text-body text-foreground-muted">
									{ts("removeApplicationDataOllamaDescription")}
								</span>
							</div>
							<Toggle
								aria-label={ts("removeApplicationDataOllama")}
								checked={deleteOllamaModels}
								onCheckedChange={setDeleteOllamaModels}
							/>
						</div>
						{cleanupError ? (
							<p className="text-body text-error">{cleanupError}</p>
						) : null}
					</div>
				}
				onConfirm={handleRemoveApplicationData}
				onOpenChange={setRemoveConfirmOpen}
				open={removeConfirmOpen}
				title={ts("removeApplicationDataTitle")}
			/>
			<SettingSection
				description={ts("resetAndRemovalDescription")}
				icon={ArrowTurnBackwardIcon}
				title={ts("resetAndRemovalTitle")}
			>
				<div className="flex flex-col gap-3 pt-2">
					<div className="grid gap-3">
						<ResetActionRow
							actionClassName="border border-warning/50 bg-warning/10 text-warning hover:bg-warning/20"
							buttonLabel={ts("resetDefaults")}
							icon={ArrowTurnBackwardIcon}
							onClick={() => setResetConfirmOpen(true)}
							summary={ts("resetDefaultsSummary")}
							title={ts("resetDefaults")}
						/>
						<ResetActionRow
							actionClassName="border border-warning/50 bg-warning/10 text-warning hover:bg-warning/20"
							buttonLabel={ts("removeDownloadedModelsButton")}
							icon={CloudDownloadIcon}
							onClick={() => {
								setModelCleanupError("");
								setRemoveModelsConfirmOpen(true);
							}}
							summary={ts("removeDownloadedModelsSummary")}
							title={ts("removeDownloadedModelsButton")}
						/>
						<ResetActionRow
							actionClassName="border border-error/50 bg-error text-white hover:bg-error/90"
							buttonLabel={ts("removeApplicationDataButton")}
							icon={Delete02Icon}
							onClick={() => {
								setCleanupError("");
								setRemoveConfirmOpen(true);
							}}
							summary={ts("removeApplicationDataSummary")}
							title={ts("removeApplicationDataButton")}
						/>
					</div>
				</div>
			</SettingSection>
		</>
	);
}

export function AboutSettingsPanel() {
	const t = useTranslations("about");
	const tg = useTranslations("general");
	const general = useSettingsStore((s) => s.settings.general);
	const update = useSettingsStore((s) => s.updateGeneralSettings);
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
			<StartupSection general={general} t={tg} update={update} />
			<LicenseSection license={license} loading={loading} t={t} />
			<NoticesSection loading={loading} notices={notices} t={t} />
			<ResetSection />
		</div>
	);
}
