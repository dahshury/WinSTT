import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { SettingSubsection, useSettingsStore } from "@/entities/setting";
import { type ContextAppEntry, listContextApps } from "@/shared/api/ipc-client";
import { useLlmConfigurationsStore } from "../model/configurations";
import { resolveActivePostProcessingPreset } from "../model/use-post-processing-profile-swap";
import { AppProfileRulesGrid } from "./AppProfileRulesGrid";

export function AppProfileRulesSection({ enabled }: { enabled: boolean }) {
	const t = useTranslations("llm");
	const rules = useSettingsStore(
		(state) => state.settings.llm.appProfiles.rules,
	);
	const dictation = useSettingsStore((state) => state.settings.llm.dictation);
	const updateRules = useSettingsStore((state) => state.updateLlmAppProfiles);
	const configurations = useLlmConfigurationsStore(
		(state) => state.configurations,
	);
	const [apps, setApps] = useState<ContextAppEntry[]>([]);

	useEffect(() => {
		let cancelled = false;
		void listContextApps()
			.then((result) => {
				if (!cancelled) {
					setApps(result);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	const fallback =
		resolveActivePostProcessingPreset(dictation)?.name ?? t("appProfileCustom");

	return (
		<SettingSubsection
			caption={t("appProfilesCaption")}
			contentDisabled={!enabled}
			title={t("appProfilesTitle")}
		>
			<AppProfileRulesGrid
				apps={apps}
				configurations={configurations}
				enabled={enabled}
				fallback={fallback}
				onChange={updateRules}
				rules={rules}
			/>
		</SettingSubsection>
	);
}
