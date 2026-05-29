# WinSTT Hotkeys & Recording Overlay UX Inventory

WinSTT uses **three global hotkeys** registered via uIOhook for push-to-talk, re-paste, and TTS. A fourth hotkey drives LLM transforms. The **recording overlay** displays live transcription, visualizer, and elapsed time during recording.

## Push-to-Talk Hotkey

**What it does:** Primary hotkey for starting/stopping dictation. Behavior depends on active recordingMode.

**Label:** Push-to-Talk Key (Settings > Audio > Hotkey > Configuration)

**Default:** LCtrl+LMeta

**Setting key:** hotkey.pushToTalkKey

**Max keys:** 3 (enforced by MAX_COMBO_KEYS = 3)

**Conditional visibility:** Hidden when recordingMode === listen

**Non-obvious behavior:** Uses uiohook-napi low-level keyboard library. Conflict resolution rejects subset/superset/equal combos. Recording chime plays unless listen/wakeword mode or server not connected. Paste guard suppresses synthetic keystrokes ~50ms. Deferred press/release via evalOnLift() callback. Query via isHotkeyActive() to gate overlays.

## Hotkey Recorder UI

**What it does:** Interactive control for recording/rebinding PTT, re-paste, TTS hotkeys.

**Max combo keys:** 3

**Recording flow:** Record button > capture > live display > stop > validate > persist

**Conflict detection:** Scans forbiddenCombos for subset/superset/equal match. Rejects with inline error.

**Code:**
- UI: frontend/src/features/record-hotkey/ui/HotkeyRecorder.tsx
- Hook: frontend/src/features/record-hotkey/model/use-key-recorder.ts

## Re-paste Hotkey (Exclusive Global Shortcut)

**What it does:** Global shortcut re-injecting last transcribed text via Electron's exclusive globalShortcut.

**Default:** LCtrl+LShift+V

**Setting key:** general.repasteHotkey

**Non-obvious behavior:** Exclusive binding swallows combo system-wide. Empty string disables. Mirrors dictation paste delivery. Silent if no transcription recorded. Unregistered during hotkey recording. Conflicts reset to default at startup.

**Code:** frontend/electron/ipc/repaste-hotkey.ts

## TTS (Text-to-Speech) Hotkey

**What it does:** Captures active selection and dispatches TTS synthesis. Held with Backspace cancels playback.

**Default:** LMeta+LShift+E

**Setting key:** tts.hotkey

**Activation gate:** tts.enabled === true AND non-empty selection

**Stop gesture:** Hold TTS hotkey + Backspace to cancel immediately

**Code:** frontend/electron/ipc/tts-hotkey.ts

## Hotkey Combo Actions (While Held)

**Hotkey + ArrowUp:** Cycle next recording mode (ptt > toggle > listen > wakeword > ptt)

**Hotkey + Backspace:** Cancel in-flight transcription or LLM pass

## Recording Overlay (Pill)

**Layouts:** floating-bottom (two-piece pill near bottom) or dynamic-island (docked top-center)

**Setting keys:**
- general.overlayMode: floating-bottom or dynamic-island
- general.showRecordingOverlay: boolean (default true)
- general.overlayPosition: auto, none, top, bottom

**Content:** Elapsed timer (mm:ss, 1000ms updates), live transcription, audio visualizer, thinking indicator

**Size presets:** xs (12px), sm (18px), md (27px), lg (40px), xl (60px)

**Platform defaults:** Linux > none (compositor issues), macOS/Windows > bottom

**Code:** frontend/src/views/overlay/ui/OverlayPage.tsx

## Hotkey Shortcuts Legend

**Content:** Cycle mode row, cancel row, TTS read row (enabled), TTS stop row (enabled)

**Code:** frontend/src/widgets/audio-settings/ui/HotkeyShortcutsLegend.tsx

## Cross-Hotkey Conflict Resolution

**Policy:** PTT anchor (never rewritten). Re-paste reset if conflicts with PTT. TTS reset if conflicts with PTT or re-paste.

**Code:** frontend/src/shared/lib/hotkey-conflict.ts

## Recording Mode Color Palette

| Mode | Hex | RGB |
|------|-----|-----|
| PTT | #3b82f6 | [59, 130, 246] |
| Toggle | #facc15 | [250, 204, 21] |
| Listen | #22c55e | [34, 197, 94] |
| Wakeword | #f97316 | [249, 115, 22] |

Centralized in shared/config/recording-mode-color.ts
