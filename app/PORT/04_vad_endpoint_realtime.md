# 04 — VAD, Endpointing & Realtime (slice: `vad-endpoint-realtime`)

> Status: **DRAFT PORT — not yet compiled** (Rust not installed). Pure-logic
> modules are real Rust + `#[cfg(test)]` tests; the heavy DistilBERT classifier
> is a trait + fail-soft `NullClassifier` + a written SPEC + acceptance tests.
>
> Files (all under `src-tauri/src/winstt/`):
> - `vad_calibrator.rs` — adaptive Silero sensitivity (SNR → target, EMA-blend, clamp).
> - `composite_vad.rs` — WebRTC∧Silero AND-gate (parity; optional vs. Handy's SmoothedVad).
> - `endpointing.rs` — dynamic-silence pause formula + `SentenceClassifier` trait + noise-break.
> - `realtime_stabilizer.rs` — commonprefix monotonic safetext + tail-merge + committed-watermark accumulator.

## Reference sources (read these, don't guess)

| WinSTT (Python, the behavioral reference) | What it gives us |
|---|---|
| `server/src/recorder/application/vad_calibrator.py` | calibrator constants + SNR map |
| `server/src/recorder/infrastructure/composite_vad.py` | AND-gate + WebRTC short-circuit + `min` confidence |
| `server/src/recorder/infrastructure/silero_vad.py` | Silero trip rule `prob > (1 - sensitivity)`; **CPU-pinned invariant** |
| `server/src/recorder/infrastructure/webrtc_vad.py` | aggressiveness 0–3; 10 ms framing; `confidence = speech_frames/num_frames` |
| `server/src/stt_server/text_processing.py` | the dynamic-silence formula + noise-break |
| `server/src/stt_server/state.py` | heuristic-pause + noise-break defaults; runtime `detection_speed=2.0` |
| `server/src/recorder/infrastructure/distilbert_classifier.py` | classifier I/O contract |
| `server/src/recorder/application/realtime_stabilizer.py` | stabilizer algorithm |
| `server/src/recorder/application/recorder_service.py` | committed-watermark accumulator |
| `memory/project_ptt_silence_endpoint_sync_race.md` | `silence_endpoint_enabled` gating |
| `memory/project_noise_break.md` | why/when the noise-break fires |
| `memory/project_realtime_stabilizer_port.md`, `project_realtime_architecture.md` | the stabilizer + watermark design |

| Handy (the foundation we extend) | What it already does |
|---|---|
| `src-tauri/src/audio_toolkit/vad/silero.rs` | Silero VAD on `ort` (already CPU). |
| `src-tauri/src/audio_toolkit/vad/smoothed.rs` | `SmoothedVad` — prefill + onset + hangover frame smoothing. |
| `src-tauri/src/managers/audio.rs` (`create_audio_recorder`) | builds `SmoothedVad::new(Box::new(silero), 15, 15, 2)` and the `AudioRecorder`; already honors `extra_recording_buffer_ms`. |

---

## 1. The locked VAD decision and what each module is FOR

**"VAD = lean on Handy."** Handy already ships a Silero VAD wrapped in
`SmoothedVad` (prefill=15, hangover=15, onset=2 frames) and an `AudioRecorder`
that buffers a recording and finalizes on silence. We do **not** replace that.
So:

- **`composite_vad.rs` is PARITY / optional.** WinSTT requires BOTH WebRTC and
  Silero to agree (materially stricter on fan/keyboard transients); Handy uses
  Silero only. We port the combinator so it can be dropped in 1:1 *if*
  `SmoothedVad` proves too permissive in the field. It is trait-based against a
  `ChunkVad` so it composes with either a WebRTC leg (add `webrtc-vad`/`earshot`
  crate later) or a Silero-leg shim. **Do not wire it by default** — it is a
  hedge, not the shipping path.
- **`vad_calibrator.rs` IS shipped.** It mutates the *sensitivity scalar* of the
  live Silero VAD across utterances — orthogonal to Handy's frame smoothing.
- **`endpointing.rs` IS shipped.** Handy's recorder finalizes on a *fixed*
  silence window; WinSTT's value-add is a *dynamic* window driven by the live
  preview text. This is the headline behavior to port.
- **`realtime_stabilizer.rs` IS shipped** — it powers the live preview and feeds
  the endpoint classifier its input text.

### Invariants honored (from the task brief + memory)
- **Silero VAD = CPU-only.** Neither this slice's calibrator nor the composite
  touches the ORT session/device; the calibrator only adjusts a scalar. The
  classifier ONNX session (when it exists) is also CPU (tiny model, dodges the
  DML-incompatible-family list entirely).
- **`panic = "unwind"` is load-bearing** — none of these modules `panic!` on the
  hot path. The classifier is fail-soft (`is_available()==false → 0.0`); the
  accumulator's transcribe closure returns `Option<String>` so a mid-swap
  transcriber skips a tick instead of unwinding.
- **Canary/Cohere context-prompt slot is untrained** — not relevant to this
  slice (endpointing operates on preview *text*, not decoder prompts), but noted
  so the classifier is never confused with an initial-prompt bias source.

---

## 2. Adaptive calibrator — `vad_calibrator.rs`

Pure arithmetic; fully ported + tested. Lifecycle, driven by the recorder:

```
on_recording_started()              // wipe RMS samples, begin collecting
on_chunk(&[i16])  (per audio chunk)  // accumulate sqrt(mean(x^2)) per chunk
on_recording_stopped()              // freeze (noise=p10, peak=p90) if >=20 samples
on_transcription_completed(text, get, set) -> Option<Adaptation>
    // if text non-empty: target = map(SNR); blended = 0.3*target + 0.7*current;
    //   clamped to [0.15, 0.7]; apply via set() unless |Δ| < 1e-4.
```

`SNR_dB = 20*log10(peak/noise)`, linear map `LOW_SNR=10 → 0.15`, `HIGH_SNR=40 →
0.7`. `get`/`set` are closures onto the live Silero sensitivity so the
calibrator never borrows the VAD. **`percentile()` reproduces numpy's "linear"
interpolation** (verified against `np.percentile([10,20,30,40,50], 10)==14`,
`…,90)==46`) so the chosen sensitivity is byte-equal to the Python.

### Wiring into Handy
Handy's `SileroVad::new(vad_path, 0.3)` (audio.rs:124) sets sensitivity at
build. To make it adaptive without editing Handy's struct:
1. Add a `set_threshold(&mut self, f32)` shim to `SileroVad` **via a new wrapper
   type in `winstt/`** that owns the `SileroVad` and exposes get/set of the trip
   threshold (Handy's `SileroVad` stores it privately — wrap, don't edit). OR,
   if Handy's field is already adjustable, just capture get/set closures.
2. Subscribe the calibrator to the recorder lifecycle: call
   `on_recording_started/on_chunk/on_recording_stopped` from
   `AudioRecorder`'s callbacks, and `on_transcription_completed` from the
   transcription manager once the final text is known.
3. On `Some(Adaptation)`, emit a Tauri event (e.g. `vad-sensitivity-adapted`)
   so the renderer persists it **keyed by input-device name**
   (`sileroSensitivityByDeviceName`). The engine stays device-agnostic — on the
   next device switch the renderer sends the persisted value back via a
   set-parameter command. (Same split as WinSTT.)

> Per-chunk RMS uses **raw int16 magnitude** (NOT normalized to [-1,1]); the SNR
> is a ratio so absolute scale cancels — matches `vad_calibrator.py`. Handy
> records f32 internally; convert the recording chunk to i16 (or compute RMS in
> f32 and rely on the ratio — equivalent) before `on_chunk`.

---

## 3. Composite VAD — `composite_vad.rs` (optional parity hedge)

AND-gate: run WebRTC; if it says no-speech, **short-circuit** (skip Silero — the
expensive leg) and return its confidence; else `is_speech = webrtc ∧ silero`,
`confidence = min(webrtc, silero)`. Trait `ChunkVad { detect(&[i16]) ->
VadResult; reset() }`. **Synchronous AND** (NOT the monolith's async-Silero
thread — see WinSTT CLAUDE.md §12).

To wire (only if needed): implement `ChunkVad` for a WebRTC leg (a Rust
`webrtc-vad`/`earshot`-style crate — confirm a current crates.io option during
the compile loop; none is added in `00_cargo_additions.md` yet) and for a
thin shim over Handy's `SileroVad`, then hand a `CompositeVad` to
`AudioRecorder::with_vad` **in place of** `SmoothedVad`. Note the *shape
mismatch*: Handy's `VoiceActivityDetector` trait is a frame-pass-through enum
(`VadFrame::Speech(&[f32]) | Noise`); `ChunkVad` is boolean+confidence. Adapt at
the boundary — wrap `CompositeVad` in a type that implements Handy's trait and
maps `is_speech → VadFrame::Speech(frame) / Noise`.

---

## 4. Dynamic-silence endpoint — `endpointing.rs`

This is the behavioral headline. On every realtime-preview tick, recompute the
post-speech-silence window:

```
compute_pause(cfg, classifier, text, prev_text) -> Option<f32>
  if !cfg.silence_endpoint_enabled        -> None   // PTT/manual-toggle: don't touch it
  else if smart_endpoint && classifier.is_available():
      model_pause   = clamp(1 - classify(text), 0, 1)
      whisper_pause = punctuation_table(text)        // "..."→4.5 "."→0.4 "!"→0.3 "?"→0.2 else 1.8
      pause = (model_pause + whisper_pause) * detection_speed     // detection_speed default 2.0
      Some( max(pause, 0.9) )                         // SMART_ENDPOINT_MIN_PAUSE floor
  else: Some( heuristic_pause(text, prev_text) )      // mid=2.0 / end=0.45 / unknown=1.3
```

`Some(s)` → set `recorder.post_speech_silence_duration = s`. `None` → leave it
alone (the master gate is off; the user's hotkey owns the boundary).

### `detection_speed` default = 2.0, NOT 1.5
The Pydantic `EndpointConfig.detection_speed=1.5`, but the **runtime** value used
in `text_processing.py` is `ServerState.detection_speed = 2.0` (CLI-overridable).
We default to 2.0 to match live behavior and expose it as a settings-driven
field. (Inventory `04_*.md` flags this mismatch explicitly.) Higher = LONGER
pause.

### `silence_endpoint_enabled` gating (the PTT race)
`memory/project_ptt_silence_endpoint_sync_race.md`: this flag defaults **True**
on every server boot and is **not persisted**. PTT and toggle+manualToggleStop
must flip it **False** (only the hotkey release defines the boundary). In the
Rust port there is no WS handshake race to lose — recording mode is known
in-process at press time — but keep the same three-layer discipline:
1. **Master gate (engine):** when `silence_endpoint_enabled == false`,
   `compute_pause` returns `None` (don't shorten the window) AND the noise-break
   is suppressed (`should_fire_noise_break` returns false). Together these mean
   the engine **cannot** auto-stop a PTT recording via either path.
2. **Mode-driven correctness:** set `silence_endpoint_enabled` from the active
   recording mode whenever the mode changes (ptt/manual-toggle → false;
   toggle/listen/wakeword → true). In Rust this is a plain field set on the
   recorder/endpoint state — no async push to drop.
3. **Record-time guarantee:** re-assert `false` at PTT press, immediately before
   capture starts. Cheap and race-free.

`quality.smartEndpoint` only gates the dynamic-pause tuning, **not** whether
auto-stop happens — non-PTT modes still VAD-segment utterances when smart
endpoint is off (they just use the heuristic pauses).

### Noise-break (`should_fire_noise_break`)
Pure decision over pre-computed inputs (the recorder collects the rolling window
of preview texts + recent audio levels; the *trailing-tail* SequenceMatcher
similarity and the audio-level std-dev are computed by the caller). Fires only
when ALL hold: ≥3 texts in a 3 s window, trailing-tail similarity > 0.99, first
text > 15 chars, **`silence_endpoint_enabled`** (master gate), and recent audio
variance ≤ 0.025 (high variance ⇒ user still speaking ⇒ Whisper hallucinating at
low SNR ⇒ suppress, don't truncate real speech). On fire → stop the recorder +
clear its audio queue + reset `prev_text` (caller's job). Constants in
`NoiseBreakConfig::default()` mirror `state.py`.

### The classifier (heavy ML — trait + SPEC, NOT speculatively built)
`SentenceClassifier { classify(&str)->f32; is_available()->bool }`. Ship
`NullClassifier` (always unavailable → smart endpoint falls back to heuristic,
exactly like the Python with `transformers` absent).

**Distribution gap (must resolve before a real classifier ships):**
`KoljaB/SentenceFinishedClassification` ships **only PyTorch weights — no
`model.onnx`.** A pure-Rust `ort` path needs a one-time offline export:
```
optimum-cli export onnx --model KoljaB/SentenceFinishedClassification \
  --task text-classification distilbert-sentence-finished-onnx/
```
then vendor/host `model.onnx` + `tokenizer.json` + `config.json` as a
downloadable asset (mirror the public `dahshury/winstt-assets` pattern — see
`memory/project_private_repo_breaks_pack_distribution.md`; a *private* repo 404s
tokenless downloads). Runtime: `tokenizers` crate (WordPiece, truncation
max_length=128, produce `input_ids`+`attention_mask` i64 — DistilBERT has **no**
`token_type_ids`), `ort` CPU session, output logits `[1,2]` → softmax →
`probs[0][1]` = P[complete]. Pre-strip trailing non-alpha (`[^a-zA-Z]+$`) →
empty ⇒ 0.0. LRU(512) cache. **Fail-soft on any error.** The strip + empty-guard
(`clean_for_classification`) are PURE and already implemented + tested, so two of
the four acceptance items are pre-locked. Crate adds (`tokenizers`, and `ort`
which the STT engine already pulls) go in `00_cargo_additions.md` when the
classifier is built; confirm current crates.io versions then.

---

## 5. Realtime stabilizer + watermark — `realtime_stabilizer.rs`

**`RealtimeStabilizer`** — byte-faithful port of RealtimeSTT
(`audio_recorder.py:2440-2493, 2732-2775`):
- deque(maxlen=2) of the last two transcriptions;
- `stable_safetext` = longest common prefix of the last two, **monotonic** (only
  adopt a prefix ≥ current length → it never shrinks even when Whisper rewrites
  earlier words);
- output = `stable_safetext + fresh[matching_pos..]` where `matching_pos` is
  where the last 10 chars of safetext occur in `fresh`, searched **from the end**
  so the most recent occurrence wins; no overlap → safetext (or fresh on cold
  start).
- **Character (not byte) indexing throughout** (`Vec<char>`) so CJK/emoji behave
  identically to Python `str` slicing.

**`RealtimeAccumulator`** — the committed-watermark design from
`recorder_service.py` (pure text + watermark bookkeeping; the heavy transcribe
+ audio-slice stay in the recorder/transcription manager and are injected as a
closure):
- only audio past a frame watermark is transcribed each tick;
- once the fresh region exceeds `REALTIME_COMMIT_AFTER_SECONDS` the older portion
  is transcribed **once**, appended to `committed_text`, and the watermark
  advances **always** (even on empty/`None` output → never re-process the same
  audio; `None` = transcriber mid-swap → skip);
- assembled text = `committed + " " + fresh` → through the stabilizer → publish.

### Two events per tick (ordering matters)
`publish_fresh` returns `{ stabilized, raw }`. The host emits, in order:
1. **`Stabilized`** — UI-safe monotonic text. Consumed by the live-preview pane
   **and** fed to `endpointing::compute_pause` as the classifier/heuristic input.
2. **`Update`** — raw assembled Whisper output. Consumed by the **noise-break**
   detector (it needs the latest, possibly-regressed tail to detect repetition).

`reset(clear_last=true)` at the **start** of a fresh recording (wipes committed
text, watermark, last-text, AND the stabilizer). `reset(false)` when a recording
ends (keep `last_realtime_text` for the `use_main_model_for_realtime` final-text
reuse path). On model swap/abort, also reset to avoid the stabilizer
mis-anchoring on a prior session's text (the WinSTT abort path does exactly this).

### Wiring into Handy
Handy has no realtime preview today. Add a realtime worker alongside the main
transcription manager:
1. While recording, every `realtime_processing_pause` (~0.1 s), pull the audio
   buffer's frame count + fps, call `acc.commit_if_needed(total, fps, |s,e| …)`
   (the closure runs the *realtime* transcriber on the committed slice — a small
   model, e.g. tiny), then transcribe the fresh slice past the watermark and call
   `acc.publish_fresh(fresh_text)`.
2. Emit `Stabilized`/`Update` Tauri events from the returned payload (§ above).
3. Feed each `Stabilized` text into `endpointing::compute_pause` and apply the
   resulting `Option<f32>` to the recorder's silence window.
4. Feed each `Update` text + recent audio levels into the noise-break window.

---

## 6. lib.rs wiring summary (for `PORT/lib_wiring.md`)

- `mod winstt;` already exposes `vad_calibrator`, `composite_vad`, `endpointing`,
  `realtime_stabilizer` (registered in `winstt/mod.rs`).
- **No new Tauri commands are strictly required by this slice's pure logic** —
  it is consumed in-process by the audio/transcription managers. The host adds:
  - events: `vad-sensitivity-adapted` (calibrator → renderer persistence),
    `realtime-stabilized` + `realtime-update` (preview → renderer).
  - a `set-parameter`-style command path already exists in WinSTT settings; route
    `silence_endpoint_enabled`, `smart_endpoint`, `detection_speed`, and the
    per-device sensitivity through it (see `02_settings.md`).
- The calibrator + accumulator are **per-recording state** — own them in the
  recording manager (one instance, `reset` per recording), not as globals.
- Default ship config: composite VAD **off** (lean on Handy's `SmoothedVad`),
  calibrator **on**, smart endpoint **off** (until the ONNX classifier export
  exists → `NullClassifier`), realtime preview **on**.

## 7. Open items / verify during compile loop
- Confirm `REALTIME_COMMIT_AFTER_SECONDS` against the live module constant in
  `recorder_service.py` (placeholder 2.0 here).
- Pick a current crates.io WebRTC-VAD crate if/when `composite_vad` is wired.
- Produce + host the DistilBERT ONNX export before swapping `NullClassifier` for
  the real `ort` classifier; add `tokenizers` to `00_cargo_additions.md` then.
- Handy's `SileroVad` threshold mutability: confirm whether a wrapper shim is
  needed for the calibrator's get/set, or whether the field is reachable.
