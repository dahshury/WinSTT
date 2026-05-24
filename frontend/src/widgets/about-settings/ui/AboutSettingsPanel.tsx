import { Certificate01Icon, InformationCircleIcon, LicenseIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { SettingSection } from "@/entities/setting";
import {
	type AboutAppInfo,
	aboutGetAppInfo,
	aboutGetLicense,
	aboutGetNotices,
} from "@/shared/api/ipc-client";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { ScrollArea } from "@/shared/ui/scroll-area";

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
			<LicenseSection license={license} loading={loading} t={t} />
			<NoticesSection loading={loading} notices={notices} t={t} />
		</div>
	);
}
