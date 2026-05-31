# WinSTT Quality Settings Panel — Control Inventory

## Overview

The **Processing/Quality settings** panel controls live-preview timing, smart sentence detection, punctuation handling, and file-transcription format. All settings respect recording mode and realtime state.

---

## Context Awareness

**What it does:** Captures focused text/page title/window context before recording starts, passed to Whisper (via `<|startofprev|>` slot) and LLM dictation if enabled.

**Options/range:** Toggle on/off.

**Default:** Off (false).

**Conditional visibility:** Only shown when active model is Whisper OR LLM dictation enabled.

**Setting key:** `general.contextAwareness`

---

## Voice Activity Detection (VAD) Tuning

**What it does:** Tunes Silero + WebRTC detectors that drive endpoint detection in Listen and Wake Word modes.

**Conditional visibility:** Only shown when recording mode is "listen" or "wakeword".

**Setting key group:** `audio.sileroDeactivityDetection`, `audio.sileroSensitivity`, `audio.webrtcSensitivity`, `audio.postSpeechSilenceDuration`

### Silero Sensitivity

**Label:** Silero Sensitivity

**Options/range:** Slider, 0.0–1.0, step 0.05.

**Default:** 0.7 (trip threshold = 0.3, the Silero reference default).

**Setting key:** `audio.sileroSensitivity`

### WebRTC Sensitivity

**Label:** WebRTC Sensitivity

**Options/range:** Slider, 0–3, step 1.

**Default:** 3 (maximum permissiveness).

**Setting key:** `audio.webrtcSensitivity`

### Post-Speech Silence Duration

**Label:** Post-Speech Silence

**Options/range:** NumberStepper, min 0.1s, no hard max.

**Default:** 0.7s.

**Setting key:** `audio.postSpeechSilenceDuration`

---

## Smart Endpoint (DistilBERT Sentence Completion)

**What it does:** AI-powered sentence completion detector using DistilBERT (`KoljaB/SentenceFinishedClassification`). Computes pause: `(model_prob + whisper_heuristic) × smartEndpointSpeed`, clamped to ~1.0s floor.

**Default:** On (true).

**Conditional visibility:** Only shown when BOTH live-transcription is enabled AND recording mode is Toggle or Wake Word.

**Setting key:** `quality.smartEndpoint`

**Mutual exclusivity:** Enabling Smart Endpoint disables LLM dictation cleanup.

### Detection Speed (Pause Multiplier)

**Label:** Detection Speed

**Options/range:** NumberStepper, 0.5–3.0, step 0.1.

**Default:** 2.0.

**Formula:** `pause = (model_prob_pause + whisper_pause) × smartEndpointSpeed` (clamped >= ~1.0s).

**Setting key:** `quality.smartEndpointSpeed`

---

## Sentence Pauses (Manual Silence Timing)

**What it does:** Punctuation-based heuristic for finalization when Smart Endpoint is OFF. Three controls for period-terminated, ellipsis-terminated, and unknown cases.

**Conditional visibility:** Only shown when BOTH recording mode is Toggle/Wake Word AND Smart Endpoint is OFF.

**Setting key group:** `quality.endOfSentenceDetectionPause`, `quality.midSentenceDetectionPause`, `quality.unknownSentenceDetectionPause`

### End-of-Sentence Pause

**Label:** End-of-sentence pause (s)

**Options/range:** NumberStepper, 0.1–5.0s, step 0.05.

**Default:** 0.45s.

**Setting key:** `quality.endOfSentenceDetectionPause`

### Unknown-Sentence Pause

**Label:** Unknown-sentence pause (s)

**Options/range:** NumberStepper, 0.1–5.0s, step 0.05.

**Default:** 1.3s (changed from 0.7s on 2026-05-18 to avoid cutting natural pauses).

**Setting key:** `quality.unknownSentenceDetectionPause`

### Mid-Sentence Pause

**Label:** Mid-sentence pause (s)

**Options/range:** NumberStepper, 0.1–10.0s, step 0.1.

**Default:** 2.0s.

**Gotcha:** Upper bound 10.0s (vs 5.0s for others) because ellipsis signals incompleteness, warranting longer pauses.

**Setting key:** `quality.midSentenceDetectionPause`

---

## Formatting

**What it does:** Automatic text post-processing before paste. Two independent toggles for casing and punctuation.

**Conditional behavior:** DISABLED (grayed out) when LLM dictation cleanup is enabled. LLM rewrites the entire transcript, so per-character fixups are redundant.

### Uppercase First Letter

**Label:** Uppercase First Letter

**Default:** On (true).

**Setting key:** `quality.ensureSentenceStartingUppercase`

### End With Period

**Label:** End with Period

**Default:** On (true).

**Setting key:** `quality.ensureSentenceEndsWithPeriod`

---

## File Transcription

### File Transcription Format

**Label:** File Transcription Format

**Options:** TXT (plaintext) | SRT (SubRip format with timecodes).

**Default:** "txt".

**Setting key:** `general.fileTranscriptionFormat`

---

## Paste Behavior

### Auto Submit

**Label:** Auto Submit

**Default:** Off (false).

**Setting key:** `general.autoSubmit`

**When enabled:** reveals sub-control for choosing the submit key.

### Auto Submit Key

**Label:** Auto Submit Key (visible only when Auto Submit is ON).

**Options:** Enter | Ctrl+Enter.

**Default:** "enter".

**Setting key:** `general.autoSubmitKey`

---

## Schema-Only Settings (Not in UI)

Four additional quality settings in the schema but not exposed in the panel:

- `quality.useMainModelForRealtime` (default false) — force realtime transcriber to use main model instead of fast variant
- `quality.realtimeProcessingPause` (default 0.02s) — interval between realtime transcription runs
- `quality.initRealtimeAfterSeconds` (default 0.2s) — seconds to wait after recording starts before first realtime run
- `quality.earlyTranscriptionOnSilence` (default 0.2s) — seconds of silence detection before triggering early realtime transcription

---

## Summary

Seven user-facing quality controls drive endpoint timing, realtime display, text formatting, and post-processing behavior:

1. **Context Awareness** — optional app context for Whisper/LLM
2. **Voice Activity Detection** — manual Silero + WebRTC sensitivity tuning (Listen/Wake Word only)
3. **Smart Endpoint** — AI-powered sentence completion with speed multiplier (realtime + Toggle/Wake Word)
4. **Sentence Pauses** — punctuation-based fallback timing (Toggle/Wake Word when Smart Endpoint off)
5. **Formatting** — auto-capitalize and auto-punctuate (disabled when LLM cleanup on)
6. **File Transcription** — output format for batch audio files (TXT or SRT)
7. **Paste Behavior** — optional auto-submit after paste (Enter or Ctrl+Enter)
