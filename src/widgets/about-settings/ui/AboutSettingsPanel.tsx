import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import { type AboutAppInfo, aboutGetAppInfo } from "@/shared/api/ipc-client";
import { AppSection } from "./AppSection";
import { DiagnosticsSection } from "./DiagnosticsSection";
import { ResetSection } from "./ResetSection";
import { SettingsTransferSection } from "./SettingsTransferSection";

// Fallback app metadata shown while the real values are fetched from the
// backend; the app name / version / copyright are rendered inline by
// AppSection once the real values arrive.
const EMPTY_APP_INFO: AboutAppInfo = {
	copyright: "",
	version: "",
};

export function AboutSettingsPanel() {
	const t = useTranslations("about");
	const tg = useTranslations("general");
	const general = useSettingsStore((s) => s.settings.general);
	const update = useSettingsStore((s) => s.updateGeneralSettings);
	const [info, setInfo] = useState<AboutAppInfo>(EMPTY_APP_INFO);

	useEffect(() => {
		let cancelled = false;
		aboutGetAppInfo()
			.then((appInfo) => {
				if (cancelled) {
					return;
				}
				setInfo(appInfo);
			})
			.catch(() => {
				// Keep the fallback version text if metadata cannot be read.
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// Ordered by how often the rows are reached and how dangerous they are:
	// the product itself, then the settings-file round trip, then diagnostics,
	// and finally the application-data / destructive group.
	return (
		<div className="flex flex-col">
			<AppSection general={general} info={info} t={t} tg={tg} update={update} />
			<SettingsTransferSection />
			<DiagnosticsSection t={t} />
			<ResetSection />
		</div>
	);
}
