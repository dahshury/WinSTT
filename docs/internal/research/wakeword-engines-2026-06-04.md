# Wakeword Engine Research - 2026-06-04

## Scope

This note compares open-source/free wakeword and audio-front-end options for
WinSTT's Rust/Tauri wakeword mode. It also records what was learned from
cloning and inspecting KoljaB/RealtimeSTT under:

`<repo>\examples\RealtimeSTT`

The constraint is important: options must be practical for an open-source,
redistributable desktop app. Engines with vendor access keys, cloud training
lock-in, or commercial-only redistribution are excluded from the default path.

## Current WinSTT Pipeline

Relevant local files:

- `src-tauri/src/winstt/wakeword.rs`
- `src-tauri/src/winstt/managers/wakeword_manager.rs`
- `src-tauri/src/managers/audio.rs`
- `src-tauri/src/audio_toolkit/audio/recorder.rs`
- `src-tauri/src/actions.rs`
- `src-tauri/src/lib.rs`

Current behavior after the wakeword fixes:

- Wakeword mode arms a live sherpa-onnx KWS detector.
- Startup arming is scheduled in the background so the UI can paint.
- The microphone stream is opened through `ensure_wakeword_listening_stream`.
- The recorder's raw 16 kHz mono frame tap feeds `WakeWordManager::feed_chunk`
  before the `recording` gate, so the detector listens while idle.
- On a hit, `wake_word_detected` starts one dictation cycle through the normal
  `TranscriptionCoordinator`.
- The KWS detector now uses the bundled `bpe.model` through `sentencepiece-rs`
  for exact keyword tokenization, with a `tokens.txt` vocabulary fallback.
- Multi-word wakeword labels are encoded as single sherpa labels
  (`hey_google`, `ok_google`, etc.) and mapped back to display phrases on hits.
- Runtime KWS now prefers the upstream int8 ONNX files when the bundle contains
  them.
- KWS is forced to CPU, avoiding misleading DirectML probe warnings and keeping
  continuous wakeword inference off the STT accelerator path.

Assessment: this is a good open-vocabulary baseline. It is not obviously wrong
or obsolete. The main missing pieces are real-microphone false accept/reject
measurement, pre-roll, and an optional trained-wakeword backend for users who
want maximum accuracy on one phrase.

## Local Benchmarks Run

Generated fixtures/results live under:

- `tools/bench/wakeword-fixtures/`
- `tools/bench/wakeword-results/`
- `src-tauri/examples/wakeword_bench.rs`
- `tools/bench/wakeword_porcupine195_bench.py`

Benchmark caveats:

- SAPI fixtures are synthetic, not a substitute for noisy/far-field mic data.
- sherpa numbers were collected with the Rust example in a debug build.
- rustpotter numbers were collected through `rustpotter-cli`, so each row
  includes CLI/model startup overhead.
- Porcupine 1.9.5 numbers were collected through the Python API and are only a
  reference target, not a redistributable default decision.

### sherpa-onnx after exact SentencePiece tokenization

Results file: `tools/bench/wakeword-results/sherpa_sapi_sentencepiece_matrix.csv`

| Phrase | fp32 hits | int8 hits | Notes |
| --- | ---: | ---: | --- |
| alexa | 8/8 | 8/8 | Good synthetic recall. |
| computer | 0/8 | 0/8 | Still weak on this SAPI voice. |
| hey google | 6/8 | 6/8 | Better than char/vocab fallback, not perfect. |
| hey siri | 5/8 | 5/8 | Improved from 0/8 before exact BPE. |
| hey winstt | 0/8 | 0/8 | Needs another backend or real enrollment data. |
| jarvis | 8/8 | 8/8 | Good synthetic recall. |
| ok google | 8/8 | 8/8 | Good synthetic recall. |

Upstream sherpa test WAVs validate that exact tokenization matters:

| Phrase | Before exact BPE | After exact BPE |
| --- | ---: | ---: |
| light up | 0/8 | 8/8 |
| lovely child | 5/8 fp32, 4/8 int8 | 5/8 fp32, 4/8 int8 |
| for ever | 7/8 | 7/8 |

Decision: keep sherpa as the default because it is open-vocabulary and already
integrated, but the app must use exact `bpe.model` tokenization. The runtime now
prefers int8 models when present; real release-build CPU/power measurement is
still needed before claiming an idle-power win.

### Legacy Porcupine 1.9.5 reference

Results file: `tools/bench/wakeword-results/porcupine195_sapi.csv`

Tested with `pvporcupine==1.9.5`, the old keyless SDK path. On the same SAPI
fixtures, built-in phrases were strong:

| Keyword | Hits | First sensitivity that hit | First hit |
| --- | ---: | ---: | ---: |
| alexa | 4/4 | 0.35 | 0.864 s |
| computer | 4/4 | 0.35 | 0.864 s |
| hey google | 4/4 | 0.35 | 0.896 s |
| hey siri | 4/4 | 0.35 | 0.896 s |
| jarvis | 4/4 | 0.35 | 0.832 s |
| ok google | 4/4 | 0.35 | 1.056 s |

Decision: Porcupine is the quality/latency reference for built-ins, and old
Porcupine confirms that the app can do better than sherpa for fixed phrases.
Do not make it the default unless licensing/redistribution is explicitly
accepted; current Picovoice SDKs require an AccessKey.

### rustpotter reference mode

Results files:

- `tools/bench/wakeword-results/rustpotter_sapi_t060_a037_m6.csv`
- `tools/bench/wakeword-results/rustpotter_hey_winstt_avg_threshold.csv`
- `tools/bench/wakeword-results/rustpotter_sapi_threshold_models.csv`

Reference models were built from synthetic enrollment WAVs for `alexa`,
`computer`, and `hey_winstt`. The best tested setting was:

- build threshold: `0.60`
- build averaged threshold: `0.37`
- detector min scores: `6`

With that setting, the held-out SAPI matrix was:

| Metric | Result |
| --- | ---: |
| True positives | 3/3 |
| False negatives | 0/3 |
| False positives across nonmatching fixtures | 0 |
| Average CLI row runtime | 58.7 ms |

Decision: rustpotter is not a zero-enrollment replacement for sherpa, but it is
the strongest open-source/free candidate for a "train my wake phrase" backend.
It handled synthetic `hey winstt`, which sherpa missed. The tuning knobs must be
stored in the built reference model; CLI detector thresholds did not override
model-embedded thresholds.

## Engine Comparison

### 1. sherpa-onnx KWS

Sources:

- https://k2-fsa.github.io/sherpa/onnx/kws/index.html
- https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html
- https://github.com/k2-fsa/sherpa-onnx

Fit for WinSTT:

- Best default when users can type arbitrary phrases.
- Offline, no account key, already integrated in the Rust app.
- Open-vocabulary KWS works like a tiny constrained ASR: it decodes only the
  configured keywords and balances hits with per-keyword boost/threshold.
- The English GigaSpeech bundle includes int8 ONNX files. WinSTT currently uses
  fp32 names, so an int8 option is a likely low-risk CPU optimization.

Tradeoffs:

- Heavier than a fixed wakeword classifier because it is beam-search KWS.
- Accuracy is sensitive to tokenization, threshold, boost, phrase length, and
  mic conditions.
- Better for flexibility than for lowest possible idle power.

Recommendation:

- Keep as the default backend.
- Keep exact SentencePiece tokenization in the runtime path; do not regress to
  char-only or greedy vocabulary tokenization for `bpe.model` bundles.
- Prefer int8 model files when present, then verify release-build idle CPU and
  battery impact on real devices.
- Add empirical threshold/boost presets only after collecting real mic data.

### 2. rustpotter

Source:

- https://github.com/GiviMAD/rustpotter

Fit for WinSTT:

- Native Rust, Apache-2.0, redistributable.
- Very attractive for a "personal wakeword" mode.
- Reference mode can be built from 3 to 8 user WAV recordings using MFCC/DTW.
- Model mode can use a trained classifier when enough tagged audio exists.

Tradeoffs:

- Reference mode is convenient but less accurate than trained model mode.
- It is not a great zero-setup default for all built-in wakewords because users
  would need enrollment samples or shipped reference/model files.

Recommendation:

- Prototype as an optional backend, not as an immediate replacement for sherpa.
- Best product shape: "Train my wake phrase" with 3 to 8 samples, then compare
  rustpotter against sherpa for that phrase.
- Initial tuned reference-mode candidate: build threshold `0.60`, averaged
  threshold `0.37`, detector min scores `6`. Treat this as a starting point, not
  a universal default.

### 3. openWakeWord / LiveKit WakeWord

Sources:

- https://github.com/dscripka/openWakeWord
- https://github.com/livekit/livekit-wakeword
- https://docs.livekit.io/agents/multimodality/audio/wakeword

Fit for WinSTT:

- Strong candidate for high-accuracy fixed wake phrases.
- openWakeWord code is Apache-2.0.
- LiveKit WakeWord adds a Rust crate and a streamlined training/export flow.
- Rust path loads a wakeword classifier ONNX file; the audio front-end models
  are compiled into the library.

Licensing caveat:

- openWakeWord's included pretrained models are CC BY-NC-SA 4.0 in the upstream
  repo, so they are not acceptable as bundled commercial redistributable assets.
- A WinSTT default would need models trained from commercially clean data, or
  user-provided models.

Tradeoffs:

- Better suited to trained/custom wake phrases than arbitrary typed phrases.
- Training/data/model licensing becomes part of the product surface.

Recommendation:

- Do not ship upstream openWakeWord pretrained models by default.
- Consider LiveKit/openWakeWord for a future "high accuracy trained wake phrase"
  backend once model licensing is clean.

### 4. WebRTC VAD / Earshot / fast-vad / Silero

Sources:

- https://github.com/kaegi/webrtc-vad
- https://github.com/pykeio/earshot
- https://docs.rs/fast-vad/latest/fast_vad/
- https://github.com/snakers4/silero-vad

Fit for WinSTT:

- These are VAD/front-end pieces, not wakeword engines.
- WebRTC VAD is extremely cheap and useful as a first-stage speech gate.
- Earshot is a new pure-Rust VAD with a tiny footprint and very low claimed RTF.
- fast-vad is another Rust VAD option with 32 ms frames.
- Silero is robust, MIT, and already conceptually close to WinSTT's current
  recorder endpointing path.

Recommendation:

- Do not hard-gate KWS behind VAD initially. Hard gating can cause missed quiet
  or far-field wake phrases.
- Use VAD as a soft gate only after measurement:
  - skip KWS on obvious sustained silence,
  - periodically force KWS through even during silence,
  - always run KWS when audio energy rises quickly,
  - log when VAD would have suppressed a later wake hit.

### 5. Porcupine

Sources:

- https://github.com/Picovoice/porcupine
- https://picovoice.ai/docs/quick-start/porcupine-c/

Fit for WinSTT:

- Likely excellent latency, CPU, and production accuracy.
- Current SDK examples require a Picovoice AccessKey.

Recommendation:

- Do not use as the default because it does not satisfy the open/free
  redistributable requirement.
- It is acceptable as a benchmark target or optional bring-your-own-key backend,
  but that is a different product/maintenance decision.

### 6. Vosk Grammar / PocketSphinx / Snowboy

Sources:

- https://github.com/alphacep/vosk-api
- https://github.com/cmusphinx/pocketsphinx
- https://github.com/Kitt-AI/snowboy

Assessment:

- Vosk grammar mode is redistributable and useful if Vosk is already in the app,
  but it is heavier than a wakeword-specific engine.
- PocketSphinx is permissive and old, but accuracy is the weak point.
- Snowboy is obsolete, has Windows/support problems, and historical commercial
  terms make it unsuitable for WinSTT's default path.

Recommendation:

- Do not prioritize these unless a specific fallback requirement appears.

## RealtimeSTT Patterns To Borrow

Sources:

- https://github.com/KoljaB/RealtimeSTT
- `<repo>\examples\RealtimeSTT\RealtimeSTT\core\wakeword.py`
- `<repo>\examples\RealtimeSTT\RealtimeSTT\core\voice_activity.py`
- `<repo>\examples\RealtimeSTT\RealtimeSTT\core\recording.py`
- `<repo>\examples\RealtimeSTT\RealtimeSTT\core\preroll.py`

Useful patterns:

- Keep wakeword activation separate from VAD and separate from STT.
- State model: inactive, listening, wakeword, recording, transcribing.
- Wakeword hit does not immediately mean transcription is complete; it opens a
  short window for follow-up speech.
- If no speech follows the wakeword before timeout, return to wakeword mode.
- Maintain pre-recording audio, then prepend selected pre-roll when recording
  starts so first syllables are not clipped.
- Remove/buffer the wakeword phrase itself so ASR does not transcribe "alexa"
  or "hey winstt" into the final dictation.
- Use WebRTC/Silero-style asymmetric VAD: cheap start signal, stronger
  confirmation, candidate silence, then confirmed endpoint.
- Reset recurrent VAD state across warmup, recording start, stop, and mode
  transitions.
- Use bounded queues/backpressure so old audio is dropped before latency grows
  without bound.

## Recommended WinSTT Roadmap

1. Keep sherpa-onnx KWS as the default.

   It is already integrated, open-vocabulary, offline, and avoids access keys.
   For a settings dropdown with built-in and custom phrases, this is the most
   pragmatic default.

2. Keep extending the wakeword benchmark harness before swapping engines.

   Measure:
   - first-hit latency,
   - false accepts per hour,
   - false rejects per phrase,
   - idle CPU,
   - memory,
   - mic device and RMS/peak at detection time.

   Already tested:
   - sherpa fp32/int8,
   - legacy keyless Porcupine 1.9.5 as a reference,
   - rustpotter reference mode.

   Still missing:
   - release-build CPU and memory,
   - real microphone fixtures across users/devices,
   - false accepts per hour,
   - LiveKit/openWakeWord with a clean custom model if available.

3. Implement pre-roll and wakeword-audio trimming.

   Current WinSTT starts recording after the hit. Depending on detector latency,
   Bluetooth buffer size, and how quickly the user speaks after the wake phrase,
   the beginning of the command can be clipped. A 750 ms to 1500 ms ring buffer
   and a configurable wakeword trim would directly address this.

4. Add a trained/personal backend after measurement.

   Best order:
   - rustpotter reference mode for a no-ONNX, pure-Rust personal wake phrase.
   - LiveKit/openWakeWord ONNX for a high-accuracy trained phrase once model
     licensing is clean.

5. Do not replace sherpa with WebRTC.

   WebRTC is VAD, not KWS. It can reduce work or improve endpointing, but it
   cannot recognize a keyword by itself.

6. Keep Porcupine out of the default build.

   It is a good performance benchmark, but current access-key/vendor terms make
   it a poor fit for WinSTT's open/free default.

## Bottom Line

The current WinSTT sherpa-onnx setup is a strong default for open-vocabulary,
offline, redistributable wakeword mode. It is not necessarily the most accurate
or lowest-power engine for one fixed phrase, but it is the best current fit for
the app's flexibility and licensing constraints.

The next high-impact work is not a blind engine swap. It is:

1. Add RealtimeSTT-style pre-roll and wakeword trim.
2. Collect real-mic wakeword fixtures and false-accept logs.
3. Add rustpotter as an optional user-trained wakeword backend if real-mic
   results stay close to the synthetic benchmark.
4. Keep Porcupine as a benchmark/BYOK option only unless licensing changes.
