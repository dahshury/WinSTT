import { AppWindowIcon } from "@hugeicons/core-free-icons";
import { SettingSection } from "@/entities/setting";
import type { AboutAppInfo } from "@/shared/api/ipc-client";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import type { AboutT } from "./types";

// Brand / product name — a proper noun that is identical in every locale (see
// the `IDENTICAL_BY_DESIGN` allowlist in tools/i18n/check-i18n.ts). Held in a
// constant so it isn't flagged as a translatable literal.
const APP_NAME = "WinSTT";

export const EMPTY_APP_INFO: AboutAppInfo = {
  copyright: "",
  version: "",
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

export function AppInfoSection({ info, t }: { info: AboutAppInfo; t: AboutT }) {
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
        </ElevatedSurface>
      </div>
    </SettingSection>
  );
}
