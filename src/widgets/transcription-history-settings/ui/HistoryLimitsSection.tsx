import {
	CalendarClockIcon,
	CalendarDaysIcon,
	CalendarRangeIcon,
	DatabaseSettingIcon,
	InfinityIcon,
	ListViewIcon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Select, type SelectOption } from "@/shared/ui/select";

type RetentionValue = "never" | "cap" | "days3" | "weeks2" | "months3";

/**
 * Limits — history-entry cap and saved-recording retention. Cap defaults to
 * 1000, retention defaults to "cap" (delete only when the entry count exceeds
 * the cap; absolute time cutoffs are opt-in).
 */
export function HistoryLimitsSection() {
	const t = useTranslations("history");
	const historyMaxEntries = useSettingsStore(
		(s) => s.settings.general?.historyMaxEntries ?? 1000,
	);
	const recordingRetention = useSettingsStore(
		(s) =>
			(s.settings.general?.recordingRetention as RetentionValue | undefined) ??
			"cap",
	);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const retentionOptions: SelectOption[] = [
		{ id: "never", label: t("retentionNever"), icon: InfinityIcon },
		{ id: "cap", label: t("retentionCap"), icon: ListViewIcon },
		{ id: "days3", label: t("retentionDays3"), icon: CalendarDaysIcon },
		{ id: "weeks2", label: t("retentionWeeks2"), icon: CalendarRangeIcon },
		{ id: "months3", label: t("retentionMonths3"), icon: CalendarClockIcon },
	];

	return (
		<SettingSection
			boxed
			divided
			icon={DatabaseSettingIcon}
			title={t("limitsTitle")}
		>
			<SettingField
				defaultValue={DEFAULT_SETTINGS.general.historyMaxEntries}
				label={t("historyMaxEntries")}
				layout="row"
				onReset={() =>
					updateGeneral({
						historyMaxEntries: DEFAULT_SETTINGS.general.historyMaxEntries,
					})
				}
				tooltip={`${t("historyMaxEntriesTooltip")} ${t("historyMaxEntriesCaption")}`}
				value={historyMaxEntries}
			>
				<NumberStepper
					max={10_000}
					min={10}
					onChange={(v) => updateGeneral({ historyMaxEntries: v })}
					scrubbable
					step={10}
					value={historyMaxEntries}
				/>
			</SettingField>
			<SettingField
				defaultValue={DEFAULT_SETTINGS.general.recordingRetention}
				label={t("retention")}
				layout="row"
				onReset={() =>
					updateGeneral({
						recordingRetention: DEFAULT_SETTINGS.general.recordingRetention,
					})
				}
				tooltip={t("retentionTooltip")}
				value={recordingRetention}
			>
				<Select
					className="w-52"
					onChange={(v) =>
						updateGeneral({ recordingRetention: v as RetentionValue })
					}
					options={retentionOptions}
					value={recordingRetention}
				/>
			</SettingField>
		</SettingSection>
	);
}
