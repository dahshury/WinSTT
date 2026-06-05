import { Separator } from "@base-ui/react/separator";
import {
  ArrowRight01Icon,
  Bug01Icon,
  Folder01Icon,
  Mic01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useEffect, useReducer, useRef } from "react";
import { useTranslations } from "use-intl";
import {
  buildInputDeviceOptions,
  useInputDevices,
} from "@/entities/audio-device";
import { IPC } from "@/shared/api/ipc-channels";
import {
  copyLastTranscript,
  diagOpenLogsFolder,
  diagSaveBundle,
  fileQueuePickAndEnqueue,
  ipcSend,
  onConnectionChange,
  onSettingsChanged,
  settingsLoad,
  settingsSave,
  sttIsConnected,
  updaterCheckNow,
} from "@/shared/api/ipc-client";
import { CONTEXT_PLAYGROUND_ENABLED } from "@/shared/config/debug-flags";
import type { RecordingMode } from "@/shared/config/recording-mode-color";
import { cn } from "@/shared/lib/cn";
import {
  SurfaceProvider,
  surfaceActivePseudoBg,
  surfaceClasses,
  surfaceHoverBg,
} from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { Switcher } from "@/shared/ui/switcher";

interface TrayMenuState {
  inputDeviceIndex: number | null;
  isConnected: boolean;
  recordingMode: RecordingMode;
}

type TrayMenuAction =
  | {
      type: "load-settings";
      recordingMode: RecordingMode;
      inputDeviceIndex: number | null;
    }
  | { type: "set-connected"; value: boolean }
  | { type: "set-recording-mode"; value: RecordingMode }
  | { type: "set-input-device"; value: number | null };

function trayMenuReducer(
  state: TrayMenuState,
  action: TrayMenuAction,
): TrayMenuState {
  switch (action.type) {
    case "load-settings":
      return {
        ...state,
        recordingMode: action.recordingMode,
        inputDeviceIndex: action.inputDeviceIndex,
      };
    case "set-connected":
      return { ...state, isConnected: action.value };
    case "set-recording-mode":
      return { ...state, recordingMode: action.value };
    case "set-input-device":
      return { ...state, inputDeviceIndex: action.value };
    default:
      return state;
  }
}

const INITIAL_TRAY_MENU_STATE: TrayMenuState = {
  recordingMode: "ptt",
  inputDeviceIndex: null,
  isConnected: false,
};

export function TrayMenu() {
  const [state, dispatch] = useReducer(
    trayMenuReducer,
    INITIAL_TRAY_MENU_STATE,
  );
  const { recordingMode, inputDeviceIndex, isConnected } = state;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const t = useTranslations("tray");
  const tAudio = useTranslations("audio");
  const { devices, defaultDevice } = useInputDevices();

  useEffect(() => {
    settingsLoad().then((settings) => {
      dispatch({
        type: "load-settings",
        recordingMode: settings.general.recordingMode,
        inputDeviceIndex: settings.audio?.inputDeviceIndex ?? null,
      });
    });

    sttIsConnected().then((connected) =>
      dispatch({ type: "set-connected", value: connected }),
    );
    const unsubscribeConn = onConnectionChange((connected) => {
      dispatch({ type: "set-connected", value: connected });
    });
    // The device popup writes the new index to settings; mirror it back so
    // the row label stays correct while the (persistent) tray window is up.
    const unsubscribeSettings = onSettingsChanged((s) => {
      dispatch({
        type: "set-input-device",
        value: s.audio?.inputDeviceIndex ?? null,
      });
    });

    return () => {
      unsubscribeConn();
      unsubscribeSettings();
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const reportSize = () => {
      const rect = el.getBoundingClientRect();
      ipcSend(IPC.TRAY_MENU_RESIZE, { width: rect.width, height: rect.height });
    };
    const observer = new ResizeObserver(reportSize);
    observer.observe(el);
    reportSize();
    return () => observer.disconnect();
  }, []);

  const closeTrayMenu = () => ipcSend(IPC.TRAY_MENU_CLOSE);

  const handleShowWindow = () => {
    ipcSend(IPC.WINDOW_SHOW);
    closeTrayMenu();
  };

  const handleSettings = () => {
    ipcSend(IPC.WINDOW_OPEN_SETTINGS);
    closeTrayMenu();
  };

  // Copy the most recent completed transcription to the clipboard. Reads the
  // history DB directly (no STT server needed), so it stays enabled offline.
  const handleCopyLastTranscript = async () => {
    await copyLastTranscript();
    closeTrayMenu();
  };

  const handleModeChange = async (mode: RecordingMode) => {
    dispatch({ type: "set-recording-mode", value: mode });
    const settings = await settingsLoad();
    await settingsSave({
      ...settings,
      general: { ...settings.general, recordingMode: mode },
    });
  };

  // Open the detached device picker anchored to this row. Sending the row's
  // viewport rect (the main process converts it to screen space via the
  // tray-menu window bounds) keeps the popup glued above the row instead of
  // expanding inline and ballooning the tiny tray window off-screen.
  const handleOpenDevicePicker = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    ipcSend(IPC.DEVICE_PICKER_OPEN, {
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height,
    });
  };

  const handleTranscribeFile = async () => {
    await fileQueuePickAndEnqueue();
    closeTrayMenu();
  };

  const handleCheckForUpdates = async () => {
    closeTrayMenu();
    await updaterCheckNow();
  };

  const handleQuit = () => {
    ipcSend(IPC.WINDOW_QUIT);
  };

  const handleOpenLogsFolder = async () => {
    await diagOpenLogsFolder();
    closeTrayMenu();
  };

  const handleSaveDiagBundle = async () => {
    closeTrayMenu();
    await diagSaveBundle();
  };

  // DEBUG-ONLY: open the context-awareness playground. Hidden from end users —
  // the whole branch is compiled out when CONTEXT_PLAYGROUND_ENABLED is false.
  const handleOpenContextPlayground = () => {
    ipcSend(IPC.CONTEXT_PLAYGROUND_OPEN);
    closeTrayMenu();
  };

  const recordingModeOptions: ReadonlyArray<{
    value: RecordingMode;
    label: string;
  }> = [
    { value: "ptt", label: t("modePtt") },
    { value: "toggle", label: t("modeToggle") },
    { value: "listen", label: t("modeListen") },
    { value: "wakeword", label: t("modeWakeWord") },
  ];

  const defaultLabel = defaultDevice
    ? `${tAudio("systemDefault")} (${defaultDevice.name})`
    : tAudio("systemDefault");
  const { currentDeviceLabel } = buildInputDeviceOptions(
    devices,
    inputDeviceIndex,
    defaultLabel,
  );

  // Match the settings window's panel treatment. The settings content card sits
  // at surface-3 with a `ring-1 ring-divider-strong` outline and `rounded-xl`
  // corners; the tray menu used a much-lighter surface-5 box with no ring, so it
  // read as a different app. Pin the menu to that same dark surface-3 base (items
  // lift on hover/active from there) and mirror the ring + rounding below.
  const menuLevel = 3;
  const hoverLevel = Math.min(menuLevel + 1, 8);
  const activeLevel = Math.min(menuLevel + 2, 8);
  const hoverBg = surfaceHoverBg(hoverLevel);
  const activeBg = surfaceActivePseudoBg(activeLevel);
  return (
    <SurfaceProvider value={menuLevel}>
      <div
        // `w-max` (max-content), NOT `w-fit`: `fit-content` is capped by the
        // containing block's available width, and the window's `body` has no
        // explicit width (so available width == the window's CURRENT width).
        // A menu that starts in a 280px window therefore caps itself at 280px,
        // clips wider content (the mode switcher / shortcut column) off the
        // right, and reports the capped 280px back via the ResizeObserver — so
        // the resize-to-fit loop can never grow it. In dev the timing happens
        // to dodge the cap; a packaged build (React in production mode) gets
        // stuck on it. `max-content` is the true content width, unbounded by
        // the window, so the menu always measures — and resizes — to fit.
        className={cn(
          "w-max rounded-xl p-1 ring-1 ring-divider-strong",
          surfaceClasses(menuLevel, Math.max(menuLevel, 7)),
          "font-sans text-body-sm text-foreground",
        )}
        ref={containerRef}
      >
        <MenuItem
          activeBg={activeBg}
          hoverBg={hoverBg}
          onClick={handleShowWindow}
          shortcut="Ctrl+Shift+W"
        >
          {t("showWindow")}
        </MenuItem>
        <MenuItem
          activeBg={activeBg}
          hoverBg={hoverBg}
          onClick={handleSettings}
          shortcut="Ctrl+,"
        >
          {t("openSettings")}
        </MenuItem>
        <MenuItem
          activeBg={activeBg}
          hoverBg={hoverBg}
          onClick={handleCopyLastTranscript}
        >
          {t("copyLastTranscript")}
        </MenuItem>

        <MenuSeparator />

        <div className="p-1">
          <Switcher
            fullWidth
            onChange={handleModeChange}
            options={recordingModeOptions}
            value={recordingMode}
          />
        </div>

        <MenuSeparator />

        <Button
          className={cn(
            "w-full justify-between gap-3 rounded px-3 py-1.5 text-left transition-colors",
            hoverBg,
            "hover:text-foreground",
            activeBg,
          )}
          onClick={handleOpenDevicePicker}
        >
          <span className="flex min-w-0 items-center gap-2">
            <HugeiconsIcon
              aria-hidden="true"
              className="shrink-0 text-foreground-dim"
              icon={Mic01Icon}
              size={13}
            />
            {/* Cap the device name so a long label (e.g. "System Default
						    (Microphone (Realtek(R) Audio))") truncates here instead of
						    driving the now-`max-content` menu absurdly wide. */}
            <span className="max-w-[15rem] truncate">{currentDeviceLabel}</span>
          </span>
          <HugeiconsIcon
            aria-hidden="true"
            className="shrink-0 text-foreground-muted"
            icon={ArrowRight01Icon}
            size={11}
          />
        </Button>

        <MenuSeparator />

        <MenuItem
          activeBg={activeBg}
          disabled={!isConnected}
          hoverBg={hoverBg}
          onClick={handleTranscribeFile}
          shortcut="Ctrl+Shift+T"
        >
          {t("transcribeFile")}
        </MenuItem>
        <MenuItem
          activeBg={activeBg}
          hoverBg={hoverBg}
          onClick={handleCheckForUpdates}
        >
          {t("checkForUpdates")}
        </MenuItem>

        <MenuSeparator />

        <MenuItem
          activeBg={activeBg}
          hoverBg={hoverBg}
          icon={Folder01Icon}
          onClick={handleOpenLogsFolder}
        >
          {t("openLogsFolder")}
        </MenuItem>
        <MenuItem
          activeBg={activeBg}
          hoverBg={hoverBg}
          icon={Bug01Icon}
          onClick={handleSaveDiagBundle}
        >
          {t("saveDiagnosticBundle")}
        </MenuItem>

        {CONTEXT_PLAYGROUND_ENABLED && (
          <>
            <MenuSeparator />
            {/* eslint-disable i18next/no-literal-string -- debug-only menu item, gated off in release */}
            <MenuItem
              activeBg={activeBg}
              hoverBg={hoverBg}
              icon={Bug01Icon}
              onClick={handleOpenContextPlayground}
            >
              Context Playground (debug)
            </MenuItem>
            {/* eslint-enable i18next/no-literal-string */}
          </>
        )}

        <MenuSeparator />

        <MenuItem
          activeBg={activeBg}
          hoverBg={hoverBg}
          onClick={handleQuit}
          shortcut="Ctrl+Q"
        >
          {t("quit")}
        </MenuItem>
      </div>
    </SurfaceProvider>
  );
}

interface MenuItemProps {
  activeBg: string;
  children: React.ReactNode;
  disabled?: boolean;
  hoverBg: string;
  icon?: IconSvgElement;
  onClick?: () => void;
  shortcut?: string;
}

function MenuItem({
  children,
  onClick,
  disabled,
  shortcut,
  hoverBg,
  activeBg,
  icon,
}: MenuItemProps) {
  return (
    <Button
      className={cn(
        "w-full justify-between gap-3 rounded px-3 py-1.5 text-left transition-colors",
        disabled
          ? "text-foreground-dim"
          : `${hoverBg} ${activeBg} hover:text-foreground`,
      )}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="flex min-w-0 items-center gap-2">
        {icon && (
          <HugeiconsIcon
            aria-hidden="true"
            className="shrink-0 text-foreground-dim"
            icon={icon}
            size={13}
          />
        )}
        <span className="truncate">{children}</span>
      </span>
      {shortcut && (
        <span className="text-[10px] text-foreground-muted">{shortcut}</span>
      )}
    </Button>
  );
}

function MenuSeparator() {
  return <Separator className="my-1 h-px bg-border" />;
}
