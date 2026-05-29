# Audio Settings Inventory

## Input Device

**Setting key:** audio.inputDeviceIndex
**Default:** null
**What it does:** Selects microphone for recording
**Options:** System default + enumerated devices
**Conditional visibility:** Hidden in Listen mode
**Gotchas:** Device changes apply on next recording start; enumeration via useInputDevices()

## Output Device

**Setting key:** general.outputDeviceId
**Default:** "" (empty string = system default)
**What it does:** Selects speaker/headphone for chimes and TTS
**Options:** System default + enumerated audio devices
**Conditional visibility:** Shown only when recording sound or TTS enabled
**Gotcha:** Filters Chromium "default" sentinel; empty string passed to setSinkId()

## Silero Sensitivity

**Setting key:** audio.sileroSensitivity
**Range:** 0 to 1 (step 0.05)
**Default:** 0.7
**What it does:** Controls confidence threshold for Silero neural VAD
**Conditional visibility:** Listen or Wakeword mode only
**Non-obvious:** Internal trip threshold is 1 - sileroSensitivity; default 0.7 = trip > 0.3. Previous 0.4 dropped quiet/distant voices. Per-device adaptation in sileroSensitivityByDeviceName.

## Silero Deactivity Detection

**Setting key:** audio.sileroDeactivityDetection
**Default:** true
**What it does:** Toggles Silero VAD on/off as section header
**Conditional visibility:** Listen or Wakeword mode only

## WebRTC Sensitivity

**Setting key:** audio.webrtcSensitivity
**Range:** 0 to 3 (integers)
**Default:** 3
**What it does:** Second-layer voice detection via WebRTC VAD
**Conditional visibility:** Listen or Wakeword mode only
**Gotcha:** Inverse range: higher = LESS sensitive. 0 = most permissive (quiet speech), 3 = strictest (loud/clear). Both Silero and WebRTC must agree (AND logic).

## Post-Speech Silence Duration

**Setting key:** audio.postSpeechSilenceDuration
**Range:** 0.1 to infinity seconds (step 0.1)
**Default:** 0.7
**What it does:** Wait after speech ends before finalizing segment
**Conditional visibility:** Listen or Wakeword mode only
**Gotchas:** Applies ONLY in Listen/Wakeword (VAD-driven modes). PTT ignores this. Toggle with Smart Endpoint uses classifier output.

## Clamshell Microphone

**Setting key:** audio.clamshellMicrophone
**Default:** null (feature off)
**What it does:** Auto-swap to alternate mic when laptop lid closes
**Options:** None (disabled) or any input device index
**Non-obvious:** Platform support: macOS (ioreg) and Linux (/proc/acpi/); Windows deferred. Polls every 5s. Use case: docked laptops with external USB mic.

## Microphone Release Policy

**Setting key:** audio.microphoneRelease
**Default:** "immediate"
**What it does:** When OS audio stream released after recording stops
**Options:** "always" (stream always open), "immediate" (release on key-up, default), "sec30" (30s timeout), "min1" (1m), "min5" (5m)
**Gotcha:** Startup-only setting; PyAudioSource reads at construction. Changes require server restart. Replaced original pair of booleans.

## Extra Recording Buffer (tail capture)

**Setting key:** audio.extraRecordingBufferMs
**Range:** 0 to 2000 ms (integers)
**Default:** 0
**What it does:** Milliseconds to capture after user-driven stop, catching trailing syllables
**Conditional visibility:** Not exposed in UI

## Adaptive VAD Calibration (Per-Device)

**Setting key:** audio.sileroSensitivityByDeviceName
**Default:** {} (empty object)
**Data structure:** Record<string, number> keyed by device name
**What it does:** Stores per-device Silero sensitivity learned from recordings
**Conditional visibility:** Not user-editable; auto-populated from vad_sensitivity_adapted events
**Non-obvious:** Each device boots with own last-known sensitivity. Survives device switching and restarts. Visible only in debug logs.

## Settings NOT Exposed in UI

| Key | Default | Why Not in UI |
|-----|---------|---------------|
| audio.sampleRate | 16,000 Hz | Low-level infrastructure; fixed to Whisper native |
| audio.bufferSize | 512 frames | PyAudio parameter; fixed for stability |
| audio.minGapBetweenRecordings | 0s | Intended for future expansion; never implemented |
| audio.preRecordingBufferDuration | 1.0s | Ring-buffer lookback; not tunable in UI |

## VAD Pipeline (Conceptual)

1. **Silero Neural VAD:** Confidence threshold. Speech = confidence > (1 - sileroSensitivity).
2. **WebRTC VAD:** Energy + spectral features. Both detectors must agree (AND logic).
3. **Endpoint timing:**
   - Listen/Wakeword: VAD triggers start; silence > postSpeechSilenceDuration finalizes
   - Toggle with Smart Endpoint: DistilBERT checks completeness; complete utterances finalize faster
   - Toggle without Smart Endpoint: Sentence-pause heuristics drive timing
   - PTT: Hotkey release is hard boundary; VAD irrelevant

## Restart Requirements

Settings requiring server restart:
- Microphone Release policy (audio.microphoneRelease)
- Sample Rate (audio.sampleRate)
- Buffer Size (audio.bufferSize)
- Loopback Device (general.loopbackDeviceIndex)

Device switching typically does not require restart. Most VAD tunings take effect immediately on next segment.
