import {
  CpuSettingsIcon,
  FlashIcon,
  InfinityIcon,
  Timer01Icon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { useCatalogStore } from "@/entities/model-catalog";
import {
  DEFAULT_SETTINGS,
  SettingField,
  SettingSection,
  useDiarizationToggleStore,
  useSettingsStore,
} from "@/entities/setting";
import { DownloadConfirmationDialog } from "@/features/model-download";
import type { SwapController } from "@/features/swap-model";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { ResourceWarningDialog } from "@/shared/ui/resource-warning-dialog";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import { Spinner } from "@/shared/ui/spinner";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import type {
  DeviceValue,
  GlobalSettings,
  ModelUnloadTimeoutValue,
  StatesById,
  SystemInfo,
  TFn,
  UpdateGlobalFn,
  UpdateModelFn,
} from "../lib/types";

export function ModelLifetimeSection({
  global,
  t,
  update,
}: {
  global: GlobalSettings | undefined;
  t: TFn;
  update: UpdateGlobalFn;
}): ReactNode {
  const value =
    global?.modelUnloadTimeout ?? DEFAULT_SETTINGS.global.modelUnloadTimeout;
  return (
    <SettingSection icon={Timer01Icon} title={t("modelUnloadTimeout")}>
      <SettingField
        isDefault={value === DEFAULT_SETTINGS.global.modelUnloadTimeout}
        label={t("modelUnloadTimeout")}
        layout="row"
        onReset={() =>
          update({
            modelUnloadTimeout: DEFAULT_SETTINGS.global.modelUnloadTimeout,
          })
        }
        tooltip={`${t("modelUnloadTimeoutCaption")} ${t("modelUnloadTimeoutTooltip")}`}
      >
        <ElevatedSurface className="w-52" inline>
          <SearchableSelect
            onChange={(v) =>
              update({ modelUnloadTimeout: v as ModelUnloadTimeoutValue })
            }
            options={[
              {
                id: "immediately",
                label: t("modelUnloadImmediately"),
                icon: FlashIcon,
              },
              { id: "never", label: t("modelUnloadNever"), icon: InfinityIcon },
              { id: "min2", label: t("modelUnloadMin2"), icon: Timer01Icon },
              { id: "min5", label: t("modelUnloadMin5"), icon: Timer01Icon },
              { id: "min10", label: t("modelUnloadMin10"), icon: Timer01Icon },
              { id: "min15", label: t("modelUnloadMin15"), icon: Timer01Icon },
              { id: "hour1", label: t("modelUnloadHour1"), icon: Timer01Icon },
            ]}
            value={value}
          />
        </ElevatedSurface>
      </SettingField>
    </SettingSection>
  );
}

/**
 * Standalone compute-device control. It lives OUTSIDE both the STT and TTS
 * sections because `model.device` is the single device shared by every local
 * model — the loaded ONNX STT session AND local Kokoro TTS (mirrored onto the
 * server's `--tts-device`). Nesting it under "Main Model" made it look like an
 * STT-only knob and left it stranded under a cloud STT selection even though
 * local TTS was still riding on it. The parent renders this only when a GPU is
 * detected AND at least one local model is active: with no GPU there is no
 * choice to make (Auto resolves to CPU), so the section is hidden; it also
 * disappears when STT and TTS are both cloud, since nothing local consumes a
 * device. Because the section never shows without a GPU, the control is a plain
 * Auto/CPU switch — Auto picks the fastest device per model (CPU is the manual
 * escape hatch for GPU contention / driver issues).
 */
export function DeviceSection({
  deviceOpts,
  deviceValue,
  t,
  update,
}: {
  deviceOpts: SwitcherOption<DeviceValue>[];
  deviceValue: DeviceValue;
  t: TFn;
  update: UpdateModelFn;
}): ReactNode {
  return (
    <SettingSection icon={CpuSettingsIcon} title={t("device")}>
      <FormControl
        label={t("device")}
        layout="row"
        tooltip={`${t("deviceSectionCaption")} ${t("deviceCaptionGpu")}`}
      >
        <ElevatedSurface className="w-52">
          <Switcher
            fullWidth
            onChange={(v) => update({ device: v })}
            options={deviceOpts}
            value={deviceValue}
          />
        </ElevatedSurface>
      </FormControl>
    </SettingSection>
  );
}

interface SwapDialogsProps {
  controller: SwapController;
  getModel: ReturnType<typeof useCatalogStore.getState>["getModel"];
  statesById: StatesById;
  systemInfo: SystemInfo;
  t: TFn;
}

/** Thin composition of the two model-swap gates (download confirmation +
 *  resource warning). Rendered by every surface that drives a swap so the
 *  modals appear regardless of which picker the user touched. */
export function SwapDialogs({
  controller,
  getModel,
  statesById,
  systemInfo,
  t,
}: SwapDialogsProps): ReactNode {
  const { pendingDownload, pendingFitWarning, setPendingFitWarning } =
    controller;
  return (
    <>
      <DownloadConfirmationDialog
        getModel={getModel}
        onCancel={controller.cancelPendingDownload}
        pending={pendingDownload}
        statesById={statesById}
        systemInfo={systemInfo}
      />
      <ResourceWarningDialog
        assessment={pendingFitWarning?.assessment ?? null}
        cancelLabel={t("resourceWarning.cancel")}
        candidateName={pendingFitWarning?.candidateName ?? ""}
        confirmLabel={t("resourceWarning.proceedAnyway")}
        kind="dictation"
        onCancel={() => setPendingFitWarning(null)}
        onConfirm={() => {
          const next = pendingFitWarning?.next;
          setPendingFitWarning(null);
          if (next) {
            next();
          }
        }}
        onOpenChange={(open) => {
          if (!open) {
            setPendingFitWarning(null);
          }
        }}
        open={pendingFitWarning !== null}
        t={(key, vars) =>
          t(`resourceWarning.${key}` as Parameters<typeof t>[0], vars)
        }
      />
    </>
  );
}

/**
 * Speaker diarization, copied verbatim from the General-settings panel (it now
 * lives on the Transcription tab — the recognition engine — instead of General). The
 * parent gates it to render only in Listen mode (`general.recordingMode ===
 * 'listen'`), matching the original gate.
 *
 * Diarization is toggled at runtime (no server restart). The server pushes
 * started/completed/failed; `useDiarizationToggleStore` tracks the in-flight
 * window. Driven purely by broadcast IPC so it works in the settings window (its
 * own BrowserWindow, no connection store there). The optimistic-revert on
 * failure is performed in the toggle-store's IPC listener
 * (`diarization-toggle-store.ts`) so the failure handler owns the lifecycle
 * directly — no effect-in-render needed here.
 *
 * The persisted key (`general.speakerDiarization`) stays in the `general` slice
 * and is read/written via `updateGeneralSettings` — only the visual home moved.
 */
export function SpeakerDiarizationSection(): ReactNode {
  const tGeneral = useTranslations("general");
  const enabled = useSettingsStore(
    (s) => s.settings.general?.speakerDiarization ?? false,
  );
  const update = useSettingsStore((s) => s.updateGeneralSettings);
  const pending = useDiarizationToggleStore((s) => s.pending);

  return (
    <SettingSection
      icon={UserMultiple02Icon}
      title={tGeneral("speakerDiarization")}
    >
      <SettingField
        isDefault={enabled === DEFAULT_SETTINGS.general.speakerDiarization}
        label={tGeneral("speakerDiarization")}
        labelAddon={
          <div className="flex items-center gap-2">
            {pending ? (
              <Spinner
                aria-label={tGeneral("speakerDiarization")}
                className="size-3.5 text-foreground-muted"
              />
            ) : null}
            <Toggle
              aria-label={tGeneral("speakerDiarization")}
              checked={enabled}
              disabled={pending}
              onCheckedChange={(v) => update({ speakerDiarization: v })}
            />
          </div>
        }
        onReset={() =>
          update({
            speakerDiarization: DEFAULT_SETTINGS.general.speakerDiarization,
          })
        }
        tooltip={tGeneral("speakerDiarizationTooltip")}
      />
    </SettingSection>
  );
}
