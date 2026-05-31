# WinSTT Text-to-Speech (Kokoro) Settings Inventory

## Overview

WinSTT Text-to-Speech feature uses Kokoro-82M, a lightweight ONNX-based voice synthesis engine. The implementation spans frontend React settings panels, Electron IPC bridges, and a Python synthesizer server with on-demand asset download/management. All code follows a lazy-load on first use pattern.

The voice catalog covers 54 voices across 9 languages. Download size is ~190 MB total (engine pack + model + voicepacks), downloaded once on first enable and cached indefinitely.

---

## Master Enable Toggle

**Control:** Text-to-Speech section toggle
- **What it does:** Master on/off gate for TTS
- **Options:** Off (default) or On
- **Default:** false
- **Setting key:** tts.enabled
- **UI location:** Settings > Desktop tab
- **Behavior:** Toggling on probes download size via IPC; skips dialog if cached; toggle disabled during download

---

## Voice Picker

**Control:** Voice searchable dropdown
- **What it does:** Select which voice reads text (54 voices, 9 languages)
- **Default:** "af_heart" (Heart, US female)
- **Setting key:** tts.voice
- **UI location:** Settings > Desktop tab, within TTS section
- **Features:** Per-row preview buttons; region badges (US, UK, JP, ZH); auto-updates language on selection
- **Catalog:** 11 US female, 9 US male, 4 UK female, 4 UK male, 5 Japanese, 8 Mandarin, 3 Spanish, 1 French, 4 Hindi, 2 Italian, 3 Portuguese BR
- **Gotcha:** Catalog fetched every time TTS enabled; auto-swaps to first voice if persisted ID not in catalog

---

## Speed Control

**Control:** Speed slider
- **What it does:** Multiplier for synthesis playback speed
- **Range:** 0.5 to 2.0 (0.1 increments)
- **Default:** 1.0 (normal speed)
- **Setting key:** tts.speed
- **Display format:** {value.toFixed(1)}x
- **Reset button:** Yes, when non-default
- **Applied:** Client-side by Kokoro ONNX session (not post-processing)

---

## Test Voice Button

**Control:** Preview button (in voice picker rows and selected voice trigger)
- **What it does:** Speaks fixed sample sentence to audition voice
- **Sample:** "The quick brown fox jumps over the lazy dog."
- **Playback states:** Idle (play icon), Loading (spinner), Speaking (stop icon)
- **Behavior:** Cancels in-flight preview on new click; uses current speed setting
- **Events:** onTtsStarted > onTtsPlaybackStarted > onTtsPlaybackEnded; onTtsFailed on error

---

## Download Management

**Control:** Install banner (below voice/speed, when download active or error showing)
- **What it does:** Shows progress, pause/resume/cancel buttons, and error states
- **Components:** Engine pack (~50 MB), Kokoro model (~100 MB), Voicepacks (~40 MB)
- **Progress display:** Bar label: "{phase} · {percent}