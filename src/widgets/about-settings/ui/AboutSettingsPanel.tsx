import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import { type AboutAppInfo, aboutGetAppInfo } from "@/shared/api/ipc-client";
import { AppInfoSection, EMPTY_APP_INFO } from "./AppInfoSection";
import { DiagnosticsSection } from "./DiagnosticsSection";
import { ResetSection } from "./ResetSection";
import { StartupSection } from "./StartupSection";
import { UpdatesSection } from "./UpdatesSection";

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

	return (
		<div className="flex flex-col gap-2">
			<AppInfoSection info={info} t={t} />
			<UpdatesSection t={t} />
			<DiagnosticsSection t={t} />
			<StartupSection general={general} t={tg} update={update} />
			<ResetSection />
		</div>
	);
}
