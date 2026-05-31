# Recording Modes Deep-Dive: Complete Inventory

WinSTT supports four recording modes: **PTT** (push-to-talk), **Toggle** (continuous multi-utterance session), **Listen** (WASAPI loopback with diarized subtitles), and **Wakeword** (voice-activated). All four feed the same server pipeline and share one paste endpoint. The recording state gate and start trigger differ per mode, but finalization logic is unified.

## Recording Mode (Hero Control)

**What it does:** Selects the primary dictation trigger mechanism.

**Options:** ptt, toggle, listen, wakeword

**Default:** ptt

**Setting key:** general.recordingMode

**Behavior:** All modes use the same RecordingPipeline; mode only changes who triggers start/stop. Shared paste endpoint: post_speech_silence_duration (default 0.7s) plus optional smartEndpoint (default ON).

## PTT Mode

**Setting key:** general.recordingMode = "ptt"

### PTT Hotkey

**Default:** LCtrl+LMeta

**Setting key:** hotkey.pushToTalkKey

**Behavior:** One press = one utterance. signaledIntent authorizes ONE recording_start, then clears. Runtime-capable (uiohook).

## Toggle Mode

Hotkey toggles multi-utterance session ON/OFF. Auto-stops on silence, auto-restarts on speech, repeatedly.

**Setting key:** general.recordingMode = "toggle"

### Manual Toggle Stop (Subcontrol)

**Default:** false

**Setting key:** general.manualToggleStop

**Behavior:** When enabled, disables silence-based endpoint detection. Recording runs continuously.

## Listen Mode

Captures system audio (WASAPI loopback) and continuously transcribes as rolling diarized subtitle feed.

**Setting key:** general.recordingMode = "listen"

**Behavior:** Requires WASAPI loopback device. Realtime model ONLY. Hard utterance cap: 15s.

### Loopback Device Picker

**Default:** null

**Setting key:** general.loopbackDeviceIndex

**Behavior:** STARTUP_ONLY.

### Speaker Diarization (Listen Control)

**Default:** false

**Setting key:** general.speakerDiarization

**Behavior:** RUNTIME-toggleable (no restart). Must be in electron/lib/store.ts::STORE_SCHEMA.

## Wakeword Mode

Voice-activated recording. User says wake word → auto-starts; auto-stops on silence.

**Setting key:** general.recordingMode = "wakeword"

### Wake Word Selector

**Default:** "alexa"

**Setting key:** general.wakeWord

**Behavior:** STARTUP_ONLY. Automatic backend selection (composite, pvporcupine, openwakeword).

### Wake Word Sensitivity

**Default:** 0.6

**Setting key:** general.wakeWordSensitivity

**Behavior:** STARTUP_ONLY. Both engines clamp internally.

### Wake Word Timeout

**Default:** 5 seconds

**Setting key:** general.wakeWordTimeout

**Behavior:** STARTUP_ONLY. Independent of utterance silence.

## Shared Audio Settings

### Input Device

**Default:** null (system default)

**Setting key:** audio.inputDeviceIndex

**Conditional:** Hidden in Listen mode.

**Behavior:** STARTUP_ONLY.

### Clamshell Microphone

**Default:** null (disabled)

**Setting key:** audio.clamshellMicrophone

**Behavior:** STARTUP_ONLY. Platform-specific.

### Microphone Release Policy

**Default:** immediate

**Setting key:** audio.microphoneRelease

**Options:** always, immediate, sec30, min1, min5

**Behavior:** STARTUP_ONLY.

### Output Device

**Default:** "" (system default)

**Setting key:** general.outputDeviceId

**Conditional:** Only if recording sound or TTS enabled.

### Post-Speech Silence Duration

**Default:** 0.7

**Setting key:** audio.postSpeechSilenceDuration

**Behavior:** STARTUP_ONLY. Shared across all modes.

## Smart Endpoint & Silence Timing

### Smart Endpoint Toggle

**Default:** true

**Setting key:** quality.smartEndpoint

**Behavior:** Enables DistilBERT classifier.

### Smart Endpoint Speed Multiplier

**Default:** 2.0

**Setting key:** quality.smartEndpointSpeed

**Behavior:** Scales pause-extension multiplier.

### Unknown Sentence Detection Pause

**Default:** 1.3 seconds

**Setting key:** quality.unknownSentenceDetectionPause

**Behavior:** Primary timeout for Toggle mode.

## Re-Paste Hotkey

**Default:** "LCtrl+LShift+V"

**Setting key:** general.repasteHotkey

**Behavior:** EXCLUSIVE global shortcut. RUNTIME-capable.

---

**Documented 15 controls:** Recording Mode, PTT Hotkey, Toggle Manual Stop, Loopback Device, Speaker Diarization, Wake Word, Wake Word Sensitivity, Wake Word Timeout, Input Device, Clamshell Microphone, Microphone Release, Output Device, Post-Speech Silence, Smart Endpoint, Smart Endpoint Speed, Unknown Sentence Pause, Re-Paste Hotkey.
