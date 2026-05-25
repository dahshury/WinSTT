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
} from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";
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

	return (
		<SettingSection
			description={t("updatesDescription")}
			headerAction={
				<Button
					className="flex h-8 items-center gap-2 rounded-md border border-foreground/15 bg-foreground/5 px-3 font-medium text-body text-foreground transition-colors duration-150 hover:bg-foreground/10 disabled:cursor-not-allowed disabled:opacity-50"
					disabled={checking}
					onClick={handleCheck}
				>
					<HugeiconsIcon
						className={checking ? "animate-spin" : undefined}
						icon={RefreshIcon}
						size={12}
					/>
					{checking ? t("updatesChecking") : t("updatesCheckNow")}
				</Button>
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
				<ElevatedSurface className="px-3 py-2">
					<span className="text-body text-foreground-muted">{formatStatus(latestStatus, t)}</span>
				</ElevatedSurface>
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
