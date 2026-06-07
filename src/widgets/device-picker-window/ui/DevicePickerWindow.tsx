import { Button as BaseButton } from "@base-ui/react/button";
import { Mic01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import {
  buildInputDeviceOptions,
  MicrophoneLevelMeter,
  useInputDevices,
  useMicrophoneLevels,
} from "@/entities/audio-device";
import { IPC } from "@/shared/api/ipc-channels";
import {
  ipcSend,
  onSettingsChanged,
  settingsLoad,
  settingsSave,
} from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { surfaceClasses } from "@/shared/lib/surface";
import { useEscapeToClose } from "@/shared/lib/window-effects";
import { MenuHighlightLayer } from "@/shared/ui/menu-highlight";

// This picker pops out of the tray menu's mic row. The tray menu now sits at
// surface-3 (matching the settings window); per the surfaces model a popup
// opened from a surface lifts +2, so the picker rides at surface-5 — a clear
// floating layer above the tray menu rather than the old, much-too-light
// surface-7 box that clashed once the tray menu darkened. Shadow + ring mirror
// the tray menu so the two read as one family.
const PANEL_LEVEL = 5;
const PANEL_SHADOW_LEVEL = 7;

function close(): void {
  ipcSend(IPC.DEVICE_PICKER_CLOSE);
}

/**
 * Renderer half of the detached input-device picker. The tray menu is a tiny
 * popup; expanding the device list inside it ballooned the window off-screen.
 * This hosts the list in its own window instead, mirrors the tray's selection
 * (`settings.audio.inputDeviceIndex`) over IPC, and reports its content size
 * back so the OS window hugs the list.
 *
 * Styled to match the app's fluidfunctionalism `Select` popup: the same
 * `MenuHighlightLayer` gliding selected (accent) / hover (neutral) pills, an
 * accent checkmark on the active device, and hugeicons rows. Because the window
 * IS the open popup (no trigger), the rows are plain buttons that drive the
 * highlight layer manually — `data-menu-option` marks each row's id (so the
 * selected pill can find the active device) and a `highlightedId` state stamps
 * `data-highlighted` on hover/focus (so the hover pill glides, exactly like Base
 * UI's `data-highlighted` does inside `Select`).
 */
export function DevicePickerWindow() {
  const t = useTranslations("audio");
  const { devices, defaultDevice } = useInputDevices();
  const [inputDeviceIndex, setInputDeviceIndex] = useState<number | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  useEscapeToClose(close);

  useEffect(() => {
    settingsLoad().then((s) =>
      setInputDeviceIndex(s.audio?.inputDeviceIndex ?? null),
    );
    return onSettingsChanged((s) =>
      setInputDeviceIndex(s.audio?.inputDeviceIndex ?? null),
    );
  }, []);

  // Report the live content size so the main process can hug the window to
  // the list and re-anchor it above the row (device count varies).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const report = () => {
      const r = el.getBoundingClientRect();
      ipcSend(IPC.DEVICE_PICKER_RESIZE, { width: r.width, height: r.height });
    };
    const observer = new ResizeObserver(report);
    observer.observe(el);
    report();
    return () => observer.disconnect();
  }, []);

  const handleSelect = async (id: string) => {
    const next = id === "default" ? null : Number.parseInt(id, 10);
    const settings = await settingsLoad();
    await settingsSave({
      ...settings,
      audio: { ...settings.audio, inputDeviceIndex: next },
    });
    close();
  };

  const defaultLabel = defaultDevice
    ? `${t("systemDefault")} (${defaultDevice.name})`
    : t("systemDefault");
  const { deviceOptions, currentDeviceId } = useMemo(
    () =>
      buildInputDeviceOptions(
        devices,
        inputDeviceIndex,
        defaultLabel,
        defaultDevice?.name,
      ),
    [defaultDevice?.name, defaultLabel, devices, inputDeviceIndex],
  );
  const levels = useMicrophoneLevels(
    true,
    deviceOptions.map((opt) => opt.id),
  );

  return (
    <div className="flex h-screen w-screen items-end overflow-hidden">
      <div
        className={cn(
          "max-h-screen w-full overflow-y-auto rounded-xl p-1 ring-1 ring-divider-strong",
          surfaceClasses(PANEL_LEVEL, PANEL_SHADOW_LEVEL),
          "font-sans text-body-sm text-foreground",
        )}
        ref={containerRef}
      >
        {/* `position: relative` anchor the gliding pills measure against; rows
				    carry `data-menu-option` and scroll inside the panel together with it. */}
        <div className="relative" ref={listRef}>
          <MenuHighlightLayer containerRef={listRef} value={currentDeviceId} />
          {deviceOptions.map((opt) => {
            const active = opt.id === currentDeviceId;
            return (
              <BaseButton
                aria-pressed={active}
                className={cn(
                  "relative z-raised flex w-full cursor-default select-none items-center gap-2 rounded-xs px-3 py-2 text-left text-body leading-normal outline-none",
                  active ? "font-medium text-foreground" : "text-foreground",
                )}
                data-menu-option={opt.id}
                key={opt.id}
                onBlur={() =>
                  setHighlightedId((cur) => (cur === opt.id ? null : cur))
                }
                onClick={() => handleSelect(opt.id)}
                onFocus={() => setHighlightedId(opt.id)}
                onMouseEnter={() => setHighlightedId(opt.id)}
                onMouseLeave={() =>
                  setHighlightedId((cur) => (cur === opt.id ? null : cur))
                }
                type="button"
                {...(highlightedId === opt.id
                  ? { "data-highlighted": "" }
                  : {})}
              >
                <HugeiconsIcon
                  aria-hidden="true"
                  className="shrink-0 text-foreground-muted"
                  icon={opt.icon ?? Mic01Icon}
                  size={16}
                  strokeWidth={active ? 2 : 1.5}
                />
                <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                {active ? (
                  <HugeiconsIcon
                    aria-hidden="true"
                    className="shrink-0 text-accent"
                    icon={Tick02Icon}
                    size={16}
                  />
                ) : null}
                <MicrophoneLevelMeter
                  active={active}
                  level={levels[opt.id] ?? 0}
                />
              </BaseButton>
            );
          })}
        </div>
      </div>
    </div>
  );
}
