import {
  AiEditingIcon,
  Analytics01Icon,
  CalendarAnalysisIcon,
  CalendarClockIcon,
  CalendarDaysIcon,
  CalendarRangeIcon,
  DatabaseSettingIcon,
  Delete02Icon,
  InfinityIcon,
  ListViewIcon,
  SparklesIcon,
  VoiceIdIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";
import { useTranslations } from "use-intl";
import {
  DEFAULT_SETTINGS,
  SettingField,
  SettingSection,
  useSettingsStore,
} from "@/entities/setting";
import {
  clearTranscriptionHistory,
  clearTransformHistory,
  deleteTransformHistoryEntry,
} from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";
import type { DateRange } from "@/shared/ui/calendar-heatmap";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Select, type SelectOption } from "@/shared/ui/select";
import { useTranscriptionHistorySync } from "../api/use-history-sync";
import { computeVoiceProfile } from "../lib/voice-profile";
import { aggregate, filterEntriesByDateRange } from "../lib/word-stats";
import { useTranscriptionHistoryStore } from "../model/history-store";
import { ActivityHeatmap } from "./ActivityHeatmap";
import { HistoryImpact } from "./HistoryImpact";
import { HistorySummary } from "./HistorySummary";
import { HistoryTable } from "./HistoryTable";
import { VoiceProfile } from "./VoiceProfile";

type RetentionValue = "never" | "cap" | "days3" | "weeks2" | "months3";

export function TranscriptionHistoryPanel() {
  const t = useTranslations("history");
  useTranscriptionHistorySync();
  const entries = useTranscriptionHistoryStore((s) => s.entries);
  const transformEntries = useTranscriptionHistoryStore(
    (s) => s.transformEntries,
  );
  const clearLocal = useTranscriptionHistoryStore((s) => s.clear);
  const clearTransformLocal = useTranscriptionHistoryStore(
    (s) => s.clearTransforms,
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTransformsOpen, setConfirmTransformsOpen] = useState(false);
  const [selectedRange, setSelectedRange] = useState<DateRange | null>(null);
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

  const filteredEntries = filterEntriesByDateRange(
    entries,
    selectedRange?.from ?? null,
    selectedRange?.to ?? null,
  );
  const filteredTransformEntries = filterEntriesByDateRange(
    transformEntries,
    selectedRange?.from ?? null,
    selectedRange?.to ?? null,
  );
  const stats = useMemo(() => aggregate(filteredEntries), [filteredEntries]);
  const voiceProfile = useMemo(
    () => computeVoiceProfile(filteredEntries),
    [filteredEntries],
  );

  const handleClear = () => {
    clearTranscriptionHistory().then(() => clearLocal());
  };

  const handleClearTransforms = () => {
    clearTransformHistory().then(() => clearTransformLocal());
  };

  const handleDeleteTransform = (id: string) => {
    deleteTransformHistoryEntry(id).catch(() => undefined);
  };

  return (
    <div className="flex flex-col gap-2">
      <SettingSection icon={Analytics01Icon} title={t("summaryTitle")}>
        <div className="py-2">
          <HistorySummary stats={stats} />
        </div>
      </SettingSection>

      <SettingSection icon={SparklesIcon} title={t("impactTitle")}>
        <div className="py-2">
          <HistoryImpact stats={stats} />
        </div>
      </SettingSection>

      <SettingSection icon={VoiceIdIcon} title={t("profileTitle")}>
        <div className="py-2">
          <VoiceProfile stats={voiceProfile} />
        </div>
      </SettingSection>

      <SettingSection icon={CalendarAnalysisIcon} title={t("heatmapTitle")}>
        <div className="py-2">
          <ActivityHeatmap
            entries={entries}
            onRangeChange={setSelectedRange}
            selectedRange={selectedRange}
          />
        </div>
      </SettingSection>

      <SettingSection
        headerAction={
          <>
            <ConfirmDialog
              confirmLabel={t("clearConfirm")}
              description={t("clearDescription")}
              onConfirm={handleClear}
              onOpenChange={setConfirmOpen}
              open={confirmOpen}
              title={t("clearTitle")}
            />
            <Button
              className="flex items-center gap-1.5 bg-surface-elevated px-3 py-1.5 text-foreground-secondary text-xs-tight hover:bg-error hover:text-white disabled:opacity-50"
              disabled={entries.length === 0}
              onClick={() => setConfirmOpen(true)}
            >
              <HugeiconsIcon icon={Delete02Icon} size={14} />
              {t("clearButton")}
            </Button>
          </>
        }
        icon={ListViewIcon}
        title={t("tableTitle")}
      >
        <div className="py-2">
          <HistoryTable entries={filteredEntries} />
        </div>
      </SettingSection>

      <SettingSection
        headerAction={
          <>
            <ConfirmDialog
              confirmLabel={t("clearConfirm")}
              description={t("clearTransformsDescription")}
              onConfirm={handleClearTransforms}
              onOpenChange={setConfirmTransformsOpen}
              open={confirmTransformsOpen}
              title={t("clearTransformsTitle")}
            />
            <Button
              className="flex items-center gap-1.5 bg-surface-elevated px-3 py-1.5 text-foreground-secondary text-xs-tight hover:bg-error hover:text-white disabled:opacity-50"
              disabled={transformEntries.length === 0}
              onClick={() => setConfirmTransformsOpen(true)}
            >
              <HugeiconsIcon icon={Delete02Icon} size={14} />
              {t("clearTransformsButton")}
            </Button>
          </>
        }
        icon={AiEditingIcon}
        title={t("transformTableTitle")}
      >
        <div className="py-2">
          <HistoryTable
            emptyLabel={t("transformTableEmpty")}
            entries={filteredTransformEntries}
            onDeleteEntry={handleDeleteTransform}
            showAudioStats={false}
          />
        </div>
      </SettingSection>

      {/* Limits — history-entry cap and saved-recording retention.
			    Cap defaults to 1000, retention defaults to "cap" (delete
			    only when the entry count exceeds the cap; absolute time
			    cutoffs are opt-in). */}
      <SettingSection
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
          <ElevatedSurface className="w-fit" inline>
            <NumberStepper
              max={10_000}
              min={10}
              onChange={(v) => updateGeneral({ historyMaxEntries: v })}
              step={10}
              value={historyMaxEntries}
            />
          </ElevatedSurface>
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
          <ElevatedSurface className="w-52" inline>
            <Select
              onChange={(v) =>
                updateGeneral({ recordingRetention: v as RetentionValue })
              }
              options={retentionOptions}
              value={recordingRetention}
            />
          </ElevatedSurface>
        </SettingField>
      </SettingSection>
    </div>
  );
}
