# 05 — Wake word · Diarization · Loopback · Word-timestamps

> Slice `wake-diar-loop-wordts`. Status: **wake word = real wiring**
> (`src-tauri/src/winstt/wakeword.rs`, marked DRAFT, compiles the deterministic
> helpers + tests today). **Diarization / loopback / word-timestamps = SPEC +
> trait stubs + acceptance tests** (this doc) — the ML internals are too coupled
> to ort/sherpa-onnx graph behavior to write speculatively before the compile loop.
>
> Grounded in:
> - `onnx-asr/src/onnx_asr/diarization.py` (OnlineSpeakerClustering / Diarizer / SessionDiarizer / assign_speakers_to_words)
> - `onnx-asr/src/onnx_asr/word_timestamps.py` (DTW + median filter + alignment heads + word grouping)
> - `server/src/stt_server/loopback.py` (`LoopbackCapture`, slow-tracking AGC)
> - `server/src/recorder/infrastructure/{porcupine,oww,composite}*` + bootstrap `WAKE_WORD_BACKENDS`
> - `server/src/recorder/application/diarization_stream.py` + `domain/speaker_timeline.py`
> - memory: `project_listen_diarization_architecture`, `project_word_highlight_playback`
> - sherpa-rs 0.6.8 (`keyword_spot`, `speaker_id`/`EmbeddingExtractor`) — verified 2026-05.

---

## Cargo additions (record in `PORT/00_cargo_additions.md`)

```toml
# Unified ONNX speech toolkit (Rust bindings to k2-fsa/sherpa-onnx).
# Provides KWS (keyword_spot), speaker embedding (speaker_id::EmbeddingExtractor),
# and offline diarization scaffolding. `directml` matches the STT engine EP policy.
sherpa-rs = { version = "0.6.8", features = ["directml", "download-binaries"] }

# WASAPI render-endpoint (loopback) capture. cpal cannot capture system output on
# Windows; wasapi-rs wraps IAudioClient in loopback mode.
wasapi = "0.19"   # ⚠️ confirm exact current version in the compile loop

# (already present) anyhow, log, rubato (resampling), ndarray-free numpy ports.
```

`sherpa` is the cfg feature gating the FFI-backed code in `wakeword.rs` (and the
diarization/KWS sessions). The deterministic helpers compile without it so the
unit tests run before the dep is wired.

---

## A. WAKE WORD — implemented in `winstt/wakeword.rs`

### What is real now
- `WakeWordResult` (mirrors WinSTT's `WakeWordResult` dataclass).
- `WAKE_WORD_PRESETS` — the 14 Porcupine 1.9.x built-ins + the OWW `hey_*`
  phrases, `resolve_phrase(name)` (case-insensitive, `_`→space, open-vocabulary
  fallthrough for custom triggers). **Default `general.wakeWord = "alexa"`.**
- `KeywordSpec` + `build_keywords_file` — deterministic `keywords.txt` assembly
  (`<tokens> [:boost] [#threshold] @label`), fully unit-tested.
- `sensitivity_to_threshold` — the **direction-flip** between WinSTT sensitivity
  (higher = looser) and sherpa `#threshold` (higher = stricter).
- `WakeWordDetector` (under `#[cfg(feature = "sherpa")]`) — real
  `KeywordSpot::new(KeywordSpotConfig{…})` + `extract_keyword(chunk, 16000)`
  wiring, fail-soft `detect()` returning `WakeWordResult`.

### sherpa-onnx KWS config (verified, sherpa-rs 0.6.8 `keyword_spot.rs`)
```
KeywordSpotConfig {
  zipformer_encoder, zipformer_decoder, zipformer_joiner,  // 3 ONNX files
  tokens,                                                    // tokens.txt
  keywords,                                                  // keywords.txt (BPE-tokenized)
  max_active_path: 4, keywords_threshold: 0.1, keywords_score: 3.0,
  num_trailing_blanks: 1, sample_rate: 16000, feature_dim: 80,
  debug: false, num_threads: None, provider: Some("cpu"),
}
KeywordSpot::new(config) -> Result<Self>
KeywordSpot::extract_keyword(&mut self, Vec<f32>, sample_rate: u32) -> Result<Option<String>>
```

### Model bundle
Download once from the `kws-models` GitHub release (sherpa-onnx). Two choices:
- **English:** `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` (~14 MB).
- **Bilingual zh-en:** `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`.
Each ships `encoder/decoder/joiner.onnx`, `tokens.txt`, `keywords.txt`, `bpe.model`.

### The text2token step (SPEC — NOT in wakeword.rs)
`keywords.txt` lines are **BPE-tokenized**, not raw text:
```
▁HE Y ▁S I RI :2.0 #0.35 @hey siri
```
The token half comes from sherpa's tokenizer (`sherpa-onnx-cli text2token
--tokens tokens.txt --tokens-type bpe --bpe-model bpe.model`). The Rust port must
produce these tokens at keyword-registration time. Two viable paths, decide in
the compile loop:
1. **Subprocess** the bundled `sherpa-onnx-cli` (simplest; matches how Handy
   shells out to helpers). Cache the tokenized line per phrase.
2. **FFI** `SherpaOnnxCreateOnlineRecognizer`-adjacent text2token entry point if
   sherpa-rs re-exports it (it does NOT today at 0.6.8 — so path 1 is the v1).

`build_keywords_file` in `wakeword.rs` takes the already-tokenized `KeywordSpec`
rows, so it is decoupled from whichever tokenization path wins.

### ⚠️ UX CAVEAT — per-keyword threshold vs the engine's GLOBAL threshold
WinSTT/Porcupine took a **per-keyword** sensitivity (`sensitivities=[…]` array,
one float per keyword). openWakeWord likewise scored each model independently.
sherpa-onnx KWS exposes only **one global** `keywords_threshold` in
`KeywordSpotConfig`. The bridge:
- Keep the config global at the **loosest** floor (`THRESHOLD_MIN = 0.10`).
- Emit the REAL per-keyword threshold as a `#threshold` suffix on each
  `keywords.txt` line (sherpa applies it on top of the global; a global stricter
  than a `#t` would mask it — hence the floor).
- `WakeWordConfig::global_threshold()` enforces this invariant; a unit test locks it.

So per-keyword sensitivity IS preserved — just relocated from a config array to
the keywords file. The renderer keeps its single `general.wakeWordSensitivity`
slider for v1 (one active wake word at a time), but the file format already
supports divergent per-keyword thresholds for a future multi-trigger UI.

### ⚠️ SHORT-TRIGGER recall spike
Short triggers (1–2 syllables: "alexa", "computer", "jarvis") have far fewer
BPE tokens, so the transducer reaches the keyword's terminal state on less
evidence → **higher false-accept rate**, and `keywords_score`/`:boost` amplifies
this. Mitigations (document in the wake-word settings UI):
- Default `keywords_score = 3.0` is fine for 3+ token phrases; for ≤2-token
  triggers, lower the per-keyword `:boost` OR raise its `#threshold`.
- Prefer longer triggers ("hey jarvis" > "jarvis") in the preset UI copy.
- This is the same recall/precision tradeoff Porcupine papered over with its
  trained per-keyword models; open-vocab KWS exposes it, so the UI must too.

### Wiring (lib.rs)
- New `WakeWordManager` (in `winstt/`, follows Handy's `managers/` pattern):
  owns the live `WakeWordDetector`, rebuilds it when `general.wakeWord` /
  `wakeWordSensitivity` change (regenerate `keywords.txt` → `WakeWordDetector::new`).
- The audio reader feeds the SAME 16 kHz mono f32 chunk to the detector as the
  recorder consumer (`audio_toolkit/audio/recorder.rs::run_consumer`). On
  `detect().detected`, arm the recorder (transition INACTIVE→LISTENING) and start
  the `wakeWordTimeout` countdown — both live in the recorder state machine, NOT
  this module.
- `wake_word_activation_delay` / `wake_word_buffer_duration` (WinSTT
  `WakeWordConfig`) map to recorder-side timers; carry them in `WakeWordConfig`.

---

## B. DIARIZATION — SPEC + trait stub (port the session-stable clustering)

### Why a port, not "use sherpa-rs diarization directly"
sherpa-rs ships an **offline** AHC diarizer (`diarize` module): given a whole
clip + a speaker count, complete-linkage clustering labels segments. That is the
`Diarizer.diarize()` OFFLINE path in `diarization.py` (`_ahc_complete_linkage`,
`_cosine_distance_matrix`). **It has no session-stable IDs** — re-run it on the
next utterance and "speaker 0" may be a different person. WinSTT's Listen mode
and per-utterance diarization need IDs that PERSIST across calls
(`project_listen_diarization_architecture`: "the offline AHC lacks session-stable
IDs → must port the ~200-LOC clustering"). So:

- **Reuse from sherpa-rs:** the `EmbeddingExtractor` (wespeaker ResNet34 →
  256-d embedding) and the segmentation model session. These are the heavy ML;
  sherpa-rs owns them.
- **Port to Rust (pure arithmetic, deterministic, unit-testable):**
  `OnlineSpeakerClustering`, the activity-interval hysteresis (`_active_intervals`),
  the `SpeakerTimeline`, and `assign_speakers_to_words`. No ML, no torch, no FFI.

### Components & sources

| Rust item (to write) | Python source | Nature |
|---|---|---|
| `SpeakerSegment { start, end, speaker }` | `events.py SpeakerSegment` / `DiarSegment` | data |
| `OnlineSpeakerClustering` | `diarization.py:40-198` | **port (arithmetic)** |
| `active_intervals()` (hysteresis) | `diarization.py:254-294` | **port (state machine)** |
| `cosine_distance_matrix` + `ahc_complete_linkage` | `diarization.py:201-251` | **port (offline path)** |
| `SpeakerTimeline` | `domain/speaker_timeline.py` | **port (arithmetic)** |
| `assign_speakers_to_words()` | `diarization.py:661-708` | **port (arithmetic)** |
| `EmbeddingExtractor` session | sherpa-rs `speaker_id` | **reuse (FFI)** |
| `SegmentationModel` (pyannote-seg-3.0) | sherpa-onnx | **reuse / FFI** |
| `Diarizer` (seg→intervals→embed→cluster) | `diarization.py:297-570` | **wire (orchestration)** |
| `SessionDiarizer` (Diarizer + persistent clustering) | `diarization.py:573-658` | **wire** |

### Trait stub (drop into `winstt/diarization.rs` in the compile loop)
```rust
// DRAFT PORT — not yet compiled. Source: onnx-asr/diarization.py
pub struct SpeakerSegment { pub start: f64, pub end: f64, pub speaker: i64 }

/// Port of diart's OnlineSpeakerClustering (numpy → Rust). PURE ARITHMETIC.
/// State persists across `assign` calls → session-stable global speaker IDs.
pub struct OnlineSpeakerClustering {
    delta_new: f32,    // 0.5  — cosine-dist cutoff to mint a NEW centroid
    rho_update: f32,   // 0.3  — min active_ratio to let an emb update its centroid
    max_speakers: usize, // 8 (WinSTT DiarizationConfig) / 20 (onnx-asr default)
    ema_alpha: f32,    // 0.5  — centroid EMA weight
    centers: Option<Vec<Vec<f32>>>, // (max_speakers, dim), lazily sized
    active: Vec<bool>,
}
impl OnlineSpeakerClustering {
    pub fn new(delta_new: f32, rho_update: f32, max_speakers: usize, ema_alpha: f32) -> Self;
    pub fn reset(&mut self);
    pub fn num_known_speakers(&self) -> usize;
    /// (n, dim) embeddings + optional (n,) active_ratios → (n,) global IDs.
    pub fn assign(&mut self, embeddings: &[Vec<f32>], active_ratios: Option<&[f32]>) -> Vec<i64>;
}

/// Session-global absolute-time speaker spans (thread-safe in practice).
pub struct SpeakerTimeline { /* segments: Vec<SpeakerSegment>, retain_seconds: 600.0 */ }
impl SpeakerTimeline {
    pub fn merge(&mut self, window_segments: &[SpeakerSegment], window_start_s: f64);
    pub fn dominant_speaker(&self, start: f64, end: f64) -> Option<i64>;
    pub fn segments_in_range(&self, start: f64, end: f64) -> Vec<SpeakerSegment>;
    pub fn recent_segments(&self, duration_s: f64) -> Vec<SpeakerSegment>; // rebased to 0
    pub fn reset(&mut self);
}

/// Per-utterance diarizer with session identity. SessionDiarizer in Python.
pub trait SessionDiarizer: Send {
    fn diarize(&mut self, waveform: &[f32], sample_rate: u32) -> Vec<SpeakerSegment>;
    fn reset(&mut self);
    fn num_known_speakers(&self) -> usize;
}

/// (text, start, end) words + segments → (text, start, end, speaker).
/// Overlap-weighted majority vote in a ±0.75s window (smoothing_window_s=1.5).
pub fn assign_speakers_to_words(
    words: &[(String, f64, f64)],
    segments: &[SpeakerSegment],
    smoothing_window_s: f64,
) -> Vec<(String, f64, f64, i64)>;
```

### `OnlineSpeakerClustering::assign` — exact algorithm (port verbatim)
For each input embedding `emb` with `ratio = active_ratio[i]` (default 1.0):
1. If `num_known_speakers == 0`: add a new centroid (slot 0) if a slot is free,
   else label 0. `continue`.
2. Else compute cosine distance `1 - cos(emb, centroid)` to every **active**
   centroid; `closest` = argmin, `closest_dist` = its distance.
3. If `closest_dist <= delta_new`: label = closest global id; **and if
   `ratio >= rho_update`**, update that centroid: `c = alpha*emb + (1-alpha)*c`.
4. Else if a free slot exists: mint a new centroid.
5. Else (no room): forced reuse of `closest` (label aliasing — acceptable cap).
Normalize embeddings with `1e-12` floor before cosine (matches Python).

### Activity-interval hysteresis (`active_intervals`) — port verbatim
Two-threshold state machine over a 1-D per-local-speaker probability track:
- enter active when `p >= onset` (0.5), leave when `p < offset` (0.35);
- merge intervals separated by `< merge_frames` (`merge_gap_duration=0.3s`);
- drop intervals shorter than `min_frames` (`min_segment_duration=0.5s`).
`frame_to_sec = frame_step / 16000` from the segmentation model's frame step.

### `SessionDiarizer::diarize` wiring (orchestration)
1. Segmentation model → `(num_frames, num_local_speakers)` powerset probs +
   `frame_step` (FFI / sherpa-onnx session).
2. `active_intervals` per local speaker → candidate `(local_id, start_f, end_f)`.
3. Drop intervals `< min_embedding_duration` (0.5s); crop the waveform per
   interval; `EmbeddingExtractor::compute_speaker_embedding(crop, 16000)` per crop.
4. `OnlineSpeakerClustering::assign(embeddings, active_ratios)` → global IDs.
   `active_ratio` = mean per-frame prob over the interval.
5. Merge adjacent same-speaker spans (`< 0.05s` gap) → time-ordered `Vec`.

### Phasing (per `project_listen_diarization_architecture`)
- **v1 / per-utterance (ships first):** after `TranscriptionCompleted`, run
  `SessionDiarizer::diarize(utterance_audio)` OFF the recorder thread, emit a
  `speaker_segments` event. No-op when disabled or transcript empty. This is the
  CURRENTLY-WIRED Python path.
- **Continuous listen-timeline (then):** a `DiarizationStreamWorker`-equivalent
  feeds rolling **1.0s windows @ 0.1s stride** (drop-oldest ring buffer, only the
  freshest window taken — self-throttles, never backlogs) through the
  `SessionDiarizer` → `SpeakerTimeline.merge`. Subtitles colored by
  `dominant_speaker` / per-word `assign_speakers_to_words`.
  - CADENCE CAVEAT: WinSTT picked utterr's 1.0s/0.1s, but full seg+emb+cluster
    per 1s window is heavy (~10/s on overlapping 1s windows). Window/stride are
    constructor params + the loop self-throttles → raising the stride is a one-arg
    change if it can't keep up. Listen stays realtime-model-only for transcription
    (OOM avoidance).

### Config (WinSTT `DiarizationConfig`) → carry into Rust
`enabled=false`, `max_speakers=8`, `delta_new=0.5`, `rho_update=0.3`,
`segmentation_model="onnx-community/pyannote-segmentation-3.0"`,
`embedding_model="wespeaker-voxceleb-resnet34-LM"`. First use downloads ~32 MB.
Renderer toggle: `general.speakerDiarization` (toggle-mode UI only; server runs
the pipeline regardless of mode).

### Acceptance tests (write alongside the port, no ML needed)
- `assign` returns SAME id when the same embedding is re-fed across calls
  (session stability). A near-duplicate within `delta_new` reuses; a far one
  (`> delta_new`) mints a new id until `max_speakers`, then forces reuse.
- `ratio < rho_update` labels but does NOT move the centroid (feed a drifting
  low-ratio emb; centroid unchanged).
- `active_intervals`: a `onset`/`offset` hysteresis sequence yields the expected
  half-open intervals; sub-`min_frames` runs dropped; sub-`merge_frames` gaps merged.
- `assign_speakers_to_words`: a word whose midpoint sits in speaker-1's window
  gets speaker 1; the smoothing window resolves a word straddling a boundary by
  total overlap; empty segments → all `-1`.
- `SpeakerTimeline`: window-relative segs shift to absolute by `window_start`;
  `dominant_speaker` picks the max-overlap speaker; prune drops `> 600s`-old spans.
- `ahc_complete_linkage`: N=1 → `[0]`; two tight + one far cluster at a
  threshold → `[0,0,1]`; fixed `num_clusters` overrides the threshold stop.

---

## C. LOOPBACK — SPEC + stub (WASAPI render capture → Handy's mpsc consumer)

### The goal
Listen mode transcribes **system audio** (a video call, a YouTube lecture), not
the mic. WinSTT used `pyaudiowpatch` (patched PyAudio with WASAPI loopback) in
`LoopbackCapture` → `recorder.feed_audio()`. cpal (Handy's capture lib) **cannot**
capture render-endpoint output on Windows, so the Rust port needs `wasapi-rs`
(`wasapi` crate) opening the default render device in **loopback** mode.

### Feed into the EXISTING consumer (no new pipeline)
Handy's `audio_toolkit/audio/recorder.rs::run_consumer` already:
- takes an `mpsc::Receiver<AudioChunk>` of `Vec<f32>` blocks,
- resamples to 16 kHz via `FrameResampler` (rubato — equivalent to scipy
  `resample_poly`),
- runs the VAD and accumulates `processed_samples`.

So the loopback capturer is a SECOND PRODUCER on the same channel shape. It is the
Rust analogue of WinSTT's `FileAudioSource` (the external-feed `IAudioSource`
that accepts fed chunks instead of opening the mic). Two integration options
(decide in the compile loop):
1. **Mirror Handy exactly:** add a `LoopbackRecorder` that owns its own
   `run_consumer` clone fed by the WASAPI thread (cleanest separation;
   recorder.rs unchanged → honors the "don't edit Handy files" rule).
2. Add a `feed_external(samples, sample_rate)` entry on `AudioRecorder` that
   pushes onto the same `sample_tx`. (Edits a Handy file — avoid unless option 1
   is impractical.)
**Choose option 1.** `LoopbackRecorder` lives entirely in `winstt/loopback.rs`.

### Stub (`winstt/loopback.rs`)
```rust
// DRAFT PORT — not yet compiled. Source: server/src/stt_server/loopback.py
pub struct LoopbackCapture {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    agc: SlowTrackingAgc,
}
impl LoopbackCapture {
    /// Open the default (or `device_index`) render endpoint in WASAPI loopback,
    /// spawn a capture thread that AGCs each block and pushes 16 kHz-bound f32
    /// chunks onto `sink` (the consumer's `mpsc::Sender<AudioChunk>`).
    pub fn start(&mut self, device_index: Option<usize>, sink: Sender<Vec<f32>>) -> Result<DeviceInfo>;
    pub fn stop(&mut self);
    pub fn is_active(&self) -> bool;
    pub fn list_devices() -> Result<Vec<LoopbackDeviceInfo>>;
}
```

### Slow-tracking AGC — ARITHMETIC, port verbatim + unit-test
From `loopback.py` (constants at top of file). Per captured block (int16-domain
peak; in f32 the constants scale by `/32768`):
```
TARGET_PEAK = 8000.0   MAX_GAIN = 30.0   NOISE_FLOOR = 50.0   GAIN_SMOOTH = 0.05
peak = max(|samples|)
if peak > NOISE_FLOOR:
    desired = min(TARGET_PEAK / peak, MAX_GAIN)
    gain += GAIN_SMOOTH * (desired - gain)        # EMA toward desired
    if gain > 1.0: samples = clip(samples * gain, -32768, 32767)
else:                                              # below noise floor = silence
    gain += GAIN_SMOOTH * (1.0 - gain)            # decay toward unity, pass through
```
**WHY the silence branch matters (load-bearing):** holding the speech-time gain
over trailing silence multiplies residual room noise by up to `MAX_GAIN`, which
pegs the composite VAD at "speech" forever → Listen mode never reaches its
silence endpoint → continuous transcription instead of voice-gated. Decaying gain
toward unity (and NOT amplifying sub-floor audio) is what lets the VAD endpoint.

Rust:
```rust
pub struct SlowTrackingAgc { gain: f32 }
impl SlowTrackingAgc {
    pub fn new() -> Self { Self { gain: 1.0 } }
    pub fn reset(&mut self) { self.gain = 1.0; }
    /// In-place AGC on a 16-bit-domain block (peak measured as |sample| in int16).
    pub fn process(&mut self, samples: &mut [f32]) { /* port the branch above */ }
}
```

### Listen-mode recorder coupling (mirror `loopback.py::start/stop`)
On start: set external-audio mode, mute the mic, raise
`post_speech_silence_duration` (Python set 2.0; later tuned to **0.7** for
streaming — see `project_listen_diarization_architecture` realtime-throughput
fix), clear stale feed buffer. On stop: stop the WASAPI stream FIRST (unblocks the
read), join the thread (≤5s), then close — leave the mic **PAUSED**, restore the
saved silence duration. Serialize start/stop with a mutex (concurrent calls
crash audio backends). These coupling steps live in the Listen-mode manager, not
the AGC.

### Multichannel → mono
WASAPI render is typically 2ch f32 @ 44.1/48 kHz. Average channels to mono
(Handy's `run_consumer` expects mono f32; `FrameResampler` does the rate
conversion). WinSTT did `np.frombuffer(int16).reshape(-1, channels)` then
`feed_audio` averaged + resampled — same outcome.

### Acceptance tests (AGC only — WASAPI needs hardware)
- A loud block (`peak ≈ 20000`) gets attenuated toward `TARGET_PEAK`; gain
  tracks DOWN over several blocks (EMA, not instant).
- A quiet speech block (`peak ≈ 1000`) gets amplified, gain ≤ `MAX_GAIN`.
- A sub-`NOISE_FLOOR` block passes through UNAMPLIFIED and decays gain toward 1.0
  (the VAD-endpoint invariant).
- `clip` prevents int16 overflow on a near-full-scale block × gain.

---

## D. WORD-TIMESTAMPS — SPEC + stub (cross-attention DTW via ort IoBinding)

### Scope (from `project_word_highlight_playback`)
Per-word timestamps power history-playback karaoke highlighting and word-level
SRT. **Torch-free**, via Whisper cross-attention DTW. NATIVE only for
`onnx-community/whisper-*_timestamped` exports (they expose `cross_attentions.*`
decoder outputs). Plain Whisper / Canary / Moonshine / Cohere have NO cross-attn
export → fall back to a lazily-loaded tiny `whisper-tiny_timestamped` aligner
(`WordAligner` in Python). CTC/RNN-T/TDT/GigaAM/Kaldi/T-one models instead group
per-token frame times (`group_tokens_to_words`) — a SEPARATE, simpler path.

This slice specs the **cross-attention DTW** path (the hard one). The token-frame
path is a `03_stt_engine.md` concern (it falls out of those decoders' native
timestamp outputs).

### The two halves

**Half 1 — collect cross-attentions (HEAVY, ort IoBinding, SPEC + stub).**
The `*_timestamped` decoder export adds outputs named `cross_attentions.{layer}`.
Driving them requires hand-running the autoregressive decode loop with ort
`IoBinding` so each step's cross-attention tensors are captured (not just the
logits the fast `WhisperOrt` single-graph path returns). Per memory, the
`*_timestamped` export resolves to the SLOWER split-decoder `WhisperHf` path
(+55.6% vs plain) — acceptable for the on-demand aligner, NOT for dictation.

```rust
// DRAFT PORT — not yet compiled. ort IoBinding cross-attention collection.
pub struct TimestampedDecodeOutput {
    pub text_tokens: Vec<i64>,   // generated tokens incl trailing EOT
    /// (num_layers, num_heads, num_decoder_tokens, num_encoder_frames) f32.
    pub cross_attentions: Array4<f32>,  // or flat Vec<f32> + shape
    pub num_audio_frames: usize, // samples // HOP_LENGTH (pre 2x downsample)
    pub prompt_length: usize,    // [SOT, lang, transcribe, notimestamps] → 4
}
pub trait TimestampedDecoder {
    fn decode_with_cross_attn(&mut self, mel: &MelSpectrogram) -> Result<TimestampedDecodeOutput>;
}
```
The IoBinding mechanics (binding `cross_attentions.*` outputs to pre-allocated
device buffers, copying out per step, KV-cache management) are the risky ML part
left as a stub + acceptance criteria — do NOT write speculative ort glue before
the compile loop confirms the export's exact output names/shapes.

**Half 2 — the DTW alignment pipeline (PURE NUMPY → Rust, port verbatim, testable).**
This is `word_timestamps.py` — entirely arithmetic, no ort:

| Rust item | Python source | Notes |
|---|---|---|
| `TOKENS_PER_SECOND = 50` | const | 50 audio frames/s (20 ms each) |
| `ALIGNMENT_HEADS: &[(&str, &[u8])]` | `_ALIGNMENT_HEADS` dict | **base85-gzip blobs, copy VERBATIM** |
| `MODEL_SIZE_BY_DIMS` | `_MODEL_SIZE_BY_DIMS` | `(layers,heads) → "tiny"/"base"/…` |
| `decode_alignment_heads(blob, L, H) -> Array2<bool>` | `decode_alignment_heads` | base85-decode → gzip-inflate → reshape |
| `lookup_alignment_heads(L, H, vocab) -> Array2<bool>` | `lookup_alignment_heads` | `.en` if vocab==51864; else upper-half fallback |
| `median_filter_1d(x, width=7)` | `median_filter_1d` | reflect-pad, sliding window, pick median |
| `dtw(cost) -> (Vec<i64>, Vec<i64>)` | `dtw` | (N+1,M+1) lattice, diag/down/right, backtrace |
| `split_tokens_into_words(...)` | `split_tokens_into_words` | unicode-boundary + space/punct grouping; CJK stops at boundaries |
| `align_words(...) -> Vec<WordTiming>` | `align_words` | the full pipeline (below) |
| `WordTiming { word, start, end, tokens }` | `WordTiming` | result |

### `align_words` pipeline (port step-for-step)
1. Select heads via `alignment_heads` mask → `(num_selected_heads, tokens, frames)`.
2. Crop encoder dim to `num_audio_frames // 2` (encoder downsamples 2×).
3. Softmax across the time axis (subtract max for stability).
4. Normalize across the token axis: `(w - mean) / max(std, 1e-9)`.
5. `median_filter_1d` width 7 along time.
6. Mean over heads → `(tokens, frames)` 2-D matrix.
7. Slice `matrix[max(0, prompt_length-1) : prompt_length + len(text_tokens) - 1]`
   (the leading `<|notimestamps|>` anchor included; trailing EOT row excluded).
8. `dtw(-matrix)` → monotonic `(text_idx, time_idx)`.
9. `split_tokens_into_words` (byte-decoder via `decode_one` callback).
10. `word_boundaries = cumsum(len(tokens) per word)`; jump positions =
    `diff(text_indices) != 0`; `jump_times_s = time_indices[jumps] / 50`.
11. `start_times = jump_times[boundaries[:-1]]`, `end_times = …[1:]`; skip EOT.

### The alignment-heads tables (copy VERBATIM — do NOT regenerate)
The `_ALIGNMENT_HEADS` base85-gzip blobs are copied from openai-whisper. They are
**load-bearing magic constants** — reproduce them byte-for-byte. Example entries
(full set in `word_timestamps.py:44-58`):
```
tiny    : b"ABzY8bu8Lr0{>%RKn9Fp%m@SkK7Kt=7ytkO"
tiny.en : b"ABzY8J1N>@0{>%R00Bk>$p{7v037`oCl~+#00"
base    : b"ABzY8KQ!870{>%RzyTQH3`Q^yNP!>##QT-<FaQ7m"
…
```
Rust: store as `&[u8]` byte-string literals; `base85` crate (Z85? — **NO**, this
is Python `base64.b85decode`'s ASCII85 variant; use a crate matching
`b85decode`/RFC1924 or hand-port the 5-char→4-byte decode) + `flate2` gzip
inflate. **Acceptance test: decode each blob → assert the bool array reshapes to
exactly `(layers, heads)` for that size and matches a known fixture** (e.g.
tiny → (4,6), specific True positions). Getting the base85 variant wrong silently
yields garbage heads → wrong timings, so this test is mandatory.

### Word grouping caveat
`split_tokens_into_words` needs the model's `decode_one(token_ids) -> String`
(GPT-2 byte decoder). The replacement-char (`�`) boundary logic handles multi-byte
tokens. CJK (`zh/ja/th/lo/my/yue`) stops at unicode boundaries (no space
delimiter). `eot_id` (Whisper `<|endoftext|>`) and `prompt_length` come from the
tokenizer/decoder setup.

### Use-our-words mapping (history path, from `project_word_highlight_playback`)
History highlighting relabels the aligner's TIMED words onto OUR transcript via a
`SequenceMatcher`-style diff (`map_timings_to_text`): `equal`→transfer time,
`replace`/`insert`→time-distribute, monotonic clamp. This avoids re-transcription
drift (the highlight must follow `entry.text`, not the aligner's re-decode). Port
`difflib.SequenceMatcher` opcodes over alphanumeric-normalized words. This is
arithmetic + string — testable without ML.

### Long-audio guard
Never align > 30s at once (Whisper window). History clips are single-window.
Long-file word-SRT reuses the aligner per VAD segment (segment-level SRT already
falls out of the file-transcribe VAD cues).

### Acceptance tests (the numpy pipeline — no ort)
- `decode_alignment_heads`: each `_ALIGNMENT_HEADS` blob inflates to the right
  `(layers, heads)` shape; tiny matches a pinned True-position fixture.
- `lookup_alignment_heads`: vocab 51864 picks `.en`; unknown dims → upper-half
  mask (`mask[L//2:] = true`).
- `median_filter_1d`: width-1 is identity; width-3 on `[1,5,1,5,1]` reflect-padded
  gives the known median sequence; even width errors.
- `dtw`: on a clean diagonal cost matrix returns the diagonal path; a known
  small matrix matches a hand-computed backtrace.
- `split_tokens_into_words`: ` Hello world` → `["Hello", " world"]` grouping;
  punctuation splits; a CJK language code stops at unicode boundaries.
- `align_words`: a synthetic monotonic alignment matrix yields monotonically
  non-decreasing word start/end times; empty `text_tokens` → `[]`; the EOT word
  is skipped.
- `map_timings_to_text`: `"test that"`-timed → known `"test this"` outputs
  `"this"` carrying the original timing (the documented synthetic case).

---

## Invariants honored (PORT/README + HARD RULES)
- New files only under `winstt/` (`wakeword.rs` now; `diarization.rs`,
  `loopback.rs`, `word_timestamps.rs` in the compile loop). No Handy edits —
  loopback rides the EXISTING `run_consumer` channel shape (option 1).
- Fail-soft everywhere a recorder thread runs (KWS `extract_keyword` error,
  diarize error) → return "no detection" / `()`, never panic the thread (mirrors
  `OnnxAsrDiarizer._safe_diarize`).
- `panic = "unwind"` stays load-bearing (transcription `catch_unwind`); none of
  these modules change it.
- Diarization embedding + segmentation reuse sherpa-onnx sessions; only the
  session-stable CLUSTERING / timeline / word-assignment is ported (the ~200 LOC
  with no torch). The offline AHC is ported too (for the non-session path) but is
  NOT the Listen-mode mechanism.
- Word-timestamps are NATIVE only for `*_timestamped` Whisper exports; everything
  else degrades to the tiny fallback aligner or per-token frame grouping. Do NOT
  make the dictation model `*_timestamped` (+55.6% slower).
- Wake-word per-keyword sensitivity is preserved via the keywords-file
  `#threshold` suffix despite sherpa's single global `keywords_threshold`.

## lib.rs wiring summary (for `lib_wiring.md`)
- `WakeWordManager` — owns `WakeWordDetector`, rebuilt on
  `general.wakeWord`/`wakeWordSensitivity` change; armed from the audio reader.
- `DiarizationManager` — owns the `SessionDiarizer`; per-utterance emit after
  transcription; continuous `SpeakerTimeline` for Listen.
- `LoopbackManager` (Listen mode) — owns `LoopbackCapture`; couples to the
  recorder external-audio mode + silence-duration handshake.
- `WordAligner` — lazy tiny `whisper-tiny_timestamped`; serves an `align_words`
  command (off the WS/IPC thread, never inline). Mirrors WinSTT's
  `control_handler.align_words`.
- New events/commands: `wake_word_detected`, `speaker_segments`, `align_words`
  (request/response). Register in the tauri-specta command/event set.
