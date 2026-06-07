import { PowerSocket01Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import {
  DEFAULT_SETTINGS,
  SettingField,
  SettingSection,
} from "@/entities/setting";
import { Toggle } from "@/shared/ui/toggle";
import type { GeneralSettings, GeneralT, UpdateFn } from "./types";

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

interface StartupSectionProps {
  general: GeneralSettings | undefined;
  t: GeneralT;
  update: UpdateFn;
}

export function StartupSection({
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
