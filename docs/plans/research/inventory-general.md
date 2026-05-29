# General Settings Tab Inventory

The General Settings tab contains user-facing controls for recording mode, display, startup behavior, and audio output.

## Recording Section

**Recording Mode** (general.recordingMode): ptt | toggle | listen | wakeword. Default: ptt. Four triggering strategies rendered as Switcher.

**Manual Toggle Stop** (general.manualToggleStop): Toggle on/off. Default: false. Shown only in Toggle mode. Disables silence-based auto-stop; runs continuously first-to-second press.

**Loopback Device** (general.loopbackDeviceIndex): Select from available WASAPI devices. Default: null. Shown only in Listen mode. Transcribes audio from speakers.

**Wake Word** (general.wakeWord): Select from 20+ keywords. Default: alexa. Shown only in Wakeword mode. Composite (2x), Porcupine (PVP), openWakeWord (OWW) engines.

**Wake Word Sensitivity** (general.wakeWordSensitivity): Slider 0.0-1.0 (21 steps). Default: 0.6. Shown only in Wakeword mode. Lower=stricter, higher=permissive.

**Wake Word Timeout** (general.wakeWordTimeout): Slider 1-30 seconds. Default: 5. Shown only in Wakeword mode. Gate stays armed after detection.

**Speaker Diarization** (general.speakerDiarization): Toggle on/off. Default: false. Shown only in Listen mode. Colors per-speaker in transcripts; downloads 32MB ONNX on first use.

**System Audio Reduction** (general.systemAudioReductionWhileDictating): Slider 6 steps (0, 20, 40, 60, 80, 100%). Default: 0. Hidden in Listen mode. Reduces speakers while dictating.

**Recording Sound** (general.recordingSound): Toggle on/off. Default: true. Hidden in Listen mode. Plays chime when recording starts.

**Sound Library** (general.recordingSoundPath/Library/outputDeviceId): Multi-control. Default: built-in. Select active chime, add/rename/delete custom .wav/.mp3 (max 3s), manage output device.

## Display Section

**Display Language** (useLocaleStore): 20 locales. Default: system or en. SearchableSelect. Independent from transcription language.

**Visualizer Type** (general.visualizerType): Bar | Grid | Radial | Wave | Aura. Default: bar. Switcher with 5 options.

**Visualizer Bar Count** (general.visualizerBarCount): Slider 3-21 (odd only). Default: 9. Shown only in Bar mode. Higher=denser look.

**Recording Overlay** (general.showRecordingOverlay/visualizerSize): 6-step slider (Off + XS-XL). Default: on, xs. Hidden/greyed in Listen mode. Controls floating pill visibility and size.

**Overlay Mode** (general.overlayMode): Floating bottom | Dynamic island. Default: floating-bottom. Switcher. Greyed if overlay off.

**Live Transcription Display** (general.liveTranscriptionDisplay): none | in-app | in-pill | both. Default: both. Checkbox group. In-overlay disabled if overlay off.

## Startup Section

**Start on Login** (general.autoStart): Toggle. Default: false. Launches WinSTT on Windows signin.

**Start Minimized** (general.startMinimized): Toggle. Default: false. Starts hidden in tray.

**Minimize to Tray** (general.minimizeToTray): Toggle. Default: true. Closing window keeps app running.

**Send Crash Reports** (general.sendCrashReports): Toggle. Default: true. Sentry opt-in/out. Restart required.

## Reset Section

**Reset to Defaults**: Button with confirmation dialog. Restores all settings to factory defaults.

## Summary: 19 Controls Documented

Recording: Recording Mode, Manual Toggle Stop, Loopback Device, Wake Word, Wake Word Sensitivity, Wake Word Timeout, Speaker Diarization, System Audio Reduction, Recording Sound, Sound Library.

Display: Display Language, Visualizer Type, Visualizer Bar Count, Recording Overlay, Overlay Mode, Live Transcription Display.

Startup: Start on Login, Start Minimized, Minimize to Tray, Send Crash Reports, (+ Reset).

