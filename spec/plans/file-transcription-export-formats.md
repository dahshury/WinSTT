# Plan: File Transcription Export Formats (VTT, JSON, CSV + real SRT)

> Generated 2026-07-14 by a Fable planning agent from repository analysis. Status: NOT implemented.

## Investigation Findings (verified against code)

### 1. Where TXT/SRT generation lives, and what timestamp data actually exists

**Serialization is in Rust**, in `src-tauri/src/winstt/managers/transcode.rs` — `format_transcript(format, text, duration_secs)` + `format_srt_timestamp(seconds)` (lines 24–51). Critically, **the current SRT export is degenerate**: it emits a single cue `1\n00:00:00,000 --> <file-duration>\n<entire transcript>`. No real segments flow to the exporter today.

**Why:** the whole pipeline funnels through text-only signatures:
- `FileTranscribeManager::process_file` (`src-tauri/src/winstt/managers/file_transcribe_manager.rs:497`) calls `TranscriptionManager::transcribe(&audio) -> Result<String>`.
- That calls `SttBackend::decode(...) -> Result<String>` (`src-tauri/src/winstt/stt/backend.rs:554`), which does `.map(|t| t.text)` on the engine result — segments/words are dropped at this boundary.
- The engine trait `Transcriber::transcribe` (`src-tauri/src/winstt/stt/mod.rs:261`) **does** return a rich `Transcription { text, segments: Option<Vec<Segment>>, words: Option<Vec<WordResult>> }` with `Segment { start: f32, end: f32, text }` and `WordResult { text, start: f32, end: f32 }` (mod.rs:182–203). There is **no confidence field and no speaker field anywhere**.

**Per-family timestamp granularity (verified by reading every `Ok(Transcription {` construction):**

| Family | Segments | Words |
|---|---|---|
| Whisper (`stt/whisper.rs:1101–1215`) | Yes — `<\|t\|>` token segments via `to_segments`, only when `opts.return_timestamps` | Yes — cross-attention DTW, only when `opts.return_word_timestamps` AND the export has `cross_attentions.*` outputs (`supports_word_timestamps()` = `has_cross_attention`, i.e. `*_timestamped` exports only) |
| CTC (SenseVoice/GigaAM/Dolphin/Kaldi), Transducer RNNT/TDT (Parakeet/Zipformer), NeMo streaming, native streaming, Canary, Cohere, Granite AR/NAR, Qwen3, Tone, Moonshine | **None** — all return `text` + `..Default::default()` | None |
| Cloud (openai:/elevenlabs:) | None — `cloud_transcribe` returns filtered text | None |

**However**, the file path never sets `return_timestamps` — `backend.decode` builds `TranscribeOptions { ..Default::default() }` (backend.rs:628), and long files go through `vad_segment_decode_with_mask` (`src-tauri/src/winstt/stt/vad_segment.rs:525`) which **compacts silences** (warps the timeline) and joins chunk texts into one string.

**The key existing precedent:** `vad_segment_align_words` (vad_segment.rs:767) — used by history "karaoke" playback via `WordAligner` (`src-tauri/src/winstt/managers/word_aligner.rs`) — chunks on the **original timeline without compaction** and offsets each chunk's word timings by the chunk start. This is exactly the pattern the export path needs, and it means the VAD chunk plan can supply **segment-level timestamps for every engine family** (one segment per VAD chunk), with real Whisper sub-segments/words when the engine provides them.

Confidence: Whisper's `token_select.rs` computes softmax probabilities internally but never surfaces them into `WordResult` — so **confidence is unavailable in v1** everywhere.

### 2. How format is chosen and where files are written

- Setting: `general.fileTranscriptionFormats` — a non-empty array of the Rust `FileTranscriptionFormat { Txt, Srt, Vtt, Json, Csv }` enum, defaulting to `[Txt]`; the frontend uses the same five-value array schema.
- UI: a multi-select, per-batch (global) control in `src/widgets/output-settings/ui/OutputSettingsPanel.tsx`. It is not per-file and is persisted through the canonical settings store.
- Writing: `write_transcript_file` (file_transcribe_manager.rs:708) → `resolve_transcript_output_path`:
  - `FileSaveLocation::Auto` → `auto_transcript_output_path` **appends** `.{ext}` to the full source path (`talk.mp4` → `talk.mp4.srt`), then `std::fs::write` — **silent overwrite** is the existing collision rule.
  - `FileSaveLocation::Ask` → one blocking save dialog per file. (No UI currently renders the saveLocation setting; only i18n keys exist.)

### 3. Diarization / speaker labels

**No speaker labels ever reach any transcription output.** The `general.speaker_diarization` setting exists but `request_diarization_toggle` (`src-tauri/src/winstt/commands/dictation.rs:184`) states: "The diarization runtime has been removed... UI-only state until a real engine is wired." Canary/Cohere explicitly pass `<|nodiarize|>` tokens. Therefore VTT `<v Name>` and JSON `speaker` must be designed as **optional, never populated in v1** — carried in the export data model for forward compatibility.

---

## Implementation Plan

### Format decision (recommendation)

Ship: **VTT, word-level JSON, and CSV**. Defer **TSV** (redundant with CSV) and **Markdown** (marginal value over TXT; the serializer registry below makes it a ~30-line follow-up). Also **fix SRT** to emit real per-segment cues as part of this work (its degenerate single-cue output would otherwise contrast embarrassingly with a correct VTT).

UI decision: **multi-select** (a user emits TXT+SRT+JSON in one run; serialization from one document is free). Persist only the canonical non-empty array setting.

### Data structures (new, Rust)

New file `src-tauri/src/winstt/managers/transcript_export.rs` (registered in `winstt/managers/mod.rs`):

```rust
pub struct TranscriptDocument {
    pub schema: &'static str,            // "winstt.transcript.v1"
    pub created_at: String,              // RFC3339 UTC (chrono, already a dep)
    pub model_id: String,                // ws.model.model at decode time
    pub language: Option<String>,        // ws.model.language ("" -> None = auto)
    pub duration_seconds: f64,
    pub source_file: String,             // file_name only, not full path
    pub text: String,                    // postprocessed full transcript
    pub segments: Vec<ExportSegment>,
}
pub struct ExportSegment {
    pub id: u32,                         // 0-based
    pub start: f64, pub end: f64,        // seconds, original timeline
    pub text: String,
    pub speaker: Option<String>,         // always None in v1 (no diarization runtime)
    pub words: Vec<ExportWord>,          // ALWAYS present; empty when engine has no word timings
}
pub struct ExportWord {
    pub text: String,
    pub start: f64, pub end: f64,
    pub confidence: Option<f32>,         // always None in v1; omitted from JSON when None
}
```

Decisions locked in: `words` is an **empty array** (never omitted) so the JSON schema is stable for consumers; `confidence` and `speaker` use `#[serde(skip_serializing_if = "Option::is_none")]`. Derive `Serialize` on all three; JSON export is plain `serde_json::to_string_pretty`.

**Degradation rule (all formats):** when the pipeline yields no segments (silence fallback, engine failure to timestamp), synthesize one segment `0.0 .. duration.max(0.001)` containing the full text — exactly preserving today's SRT fallback semantics.

### Serializer signatures (pure functions, same file)

```rust
pub fn serialize_txt(doc: &TranscriptDocument) -> String;   // trimmed text + '\n' (unchanged behavior)
pub fn serialize_srt(doc: &TranscriptDocument) -> String;   // per-segment cues, comma decimals
pub fn serialize_vtt(doc: &TranscriptDocument) -> String;
pub fn serialize_json(doc: &TranscriptDocument) -> String;
pub fn serialize_csv(doc: &TranscriptDocument) -> String;
fn format_srt_timestamp(seconds: f64) -> String;            // move from transcode.rs: HH:MM:SS,mmm
fn format_vtt_timestamp(seconds: f64) -> String;            // HH:MM:SS.mmm (dot); hours pad to 2, may exceed 99
fn csv_escape(field: &str) -> String;                       // RFC 4180: quote if , " \r \n; double inner quotes
fn vtt_escape(text: &str) -> String;                        // & < > -> &amp; &lt; &gt;
```

**VTT spec:** file starts `WEBVTT\n\n`; each cue = optional numeric id line, `{start} --> {end}` with dot milliseconds, then escaped text, blank line between cues. When `segment.speaker` is `Some(name)`, cue text is `<v {name}>{text}`. Enforce `end > start` (bump end by 1 ms on zero-length segments — VTT requires strictly increasing within a cue). Overlapping cues are legal in VTT/SRT — pass through unmodified.

**SRT spec:** 1-based index, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, text, blank line. Comma decimal separator always (never locale-dependent — Rust `format!` is locale-independent; add a test asserting comma-for-SRT / dot-for-VTT explicitly).

**CSV spec:** header `segment,start,end,speaker,text`; `start`/`end` as seconds with 3 decimals, dot separator; speaker empty when None; RFC 4180 quoting. No new crate (hand-rolled `csv_escape`; keeps `deny.toml` untouched).

Keep `format_transcript` in `transcode.rs` as a thin shim over `serialize_txt`/`serialize_srt` or delete it and update the one caller — prefer deleting (single call site).

### Timestamped decode plumbing (the real work)

Do **not** touch the hot dictation path (`backend.decode`). Add a parallel file-oriented path:

1. **`src-tauri/src/winstt/stt/vad_segment.rs`** — add `vad_segment_decode_segments(engine, audio, max_chunk_s, vad, opts, request_id) -> SttResult<Vec<Segment>>`, modeled line-for-line on `vad_segment_align_words` (lines 767–830): chunk plan on the **original timeline, no silence compaction**; per chunk, call `engine.transcribe(&audio[s..e], &opts_with_return_timestamps)`; if the result has `segments` (Whisper), offset each by `s as f32 / SR as f32` and extend; else push one `Segment { start: s/SR, end: e/SR, text }`. Short clips (`<= max_chunk`) take a single transcribe with the same segments-or-single-chunk rule. Do the same for `words` — return `(Vec<Segment>, Vec<WordResult>)` (set `opts.return_word_timestamps = engine.supports_word_timestamps()`).
2. **`src-tauri/src/winstt/stt/backend.rs`** — add trait method `decode_file(&self, app, engine, audio, request_id) -> Result<Transcription>` on `SttBackend` (default impl may wrap `decode` into a single segment). The `WinsttSttBackend` impl mirrors `decode`'s settings/opts construction (language, translate, initial prompt) but sets `return_timestamps: true`, `return_word_timestamps: engine.supports_word_timestamps()`, and routes through the new `vad_segment_decode_segments`. Apply `winstt_postprocess` to the joined full text; apply the same custom-words correction to each segment/word text (or accept minor divergence and document — recommend applying to segment text, leaving word text raw since word tokens must match audio timings).
3. **`src-tauri/src/managers/transcription/decode.rs`** — add `pub fn transcribe_file(&self, audio: &[f32]) -> Result<crate::winstt::stt::Transcription>`. Factor `transcribe_with_selected_model` so the engine-locking/catch_unwind/watchdog block is shared: change the inner closure to return `Transcription` and have the existing `transcribe`/`transcribe_with_mask` map `.text` at the end (behavior-preserving; the cloud route wraps its `String` into `Transcription { text, ..Default::default() }`).
4. **Cheap path preserved:** in `FileTranscribeManager::process_file`, read the selected formats first; if the selection is TXT-only, keep calling `self.transcription.transcribe(&audio)` (compacted, faster). Otherwise call `transcribe_file`.

### Settings & bindings

1. **Rust** `src-tauri/src/winstt/settings_schema.rs`:
   - Extend `FileTranscriptionFormat` with `Vtt, Json, Csv` (serde lowercase).
   - Add to `GeneralSettings`: `pub file_transcription_formats: Vec<FileTranscriptionFormat>` with `[Txt]` as the canonical default. The accessor deduplicates the array and defensively returns `[Txt]` if an internal caller supplies an empty vector.
2. **Frontend Zod** `src/shared/config/settings-schema/general.ts`: extend the enum to `["txt","srt","vtt","json","csv"]`; add `fileTranscriptionFormats: z.array(z.enum([...])).default([]).catch([])`.
3. **Contract** `src/shared/config/settings-contract.ts`: add `"general.fileTranscriptionFormats"` next to the existing two entries (line ~156).
4. **Bindings**: run `cargo test export_bindings` in `src-tauri` to regenerate `src/bindings.ts` (CI asserts it's checked in).

### Writer changes (`file_transcribe_manager.rs`)

- `write_transcript_file` → build one `TranscriptDocument` (model_id/language from the same `read_settings_raw` snapshot; `created_at` via chrono UTC now; `source_file` = `file_name`), then loop `for format in settings.general.effective_file_transcription_formats()` and write each serialization.
- Extend `transcript_extension` (`vtt`/`json`/`csv`) and `transcript_filter_name` ("WebVTT subtitles", "JSON transcript", "CSV table").
- Naming/collision: unchanged — Auto appends `.{ext}` to the full source path (`talk.mp4.vtt`, `talk.mp4.json`; formats can never collide with each other), silent overwrite.
- `Ask` mode + multi-format: show **one** dialog per file (default name `{file_name}.{first_format_ext}`, filter of the first selected format); derive sibling outputs by replacing the extension of the chosen path for the remaining formats. A per-format dialog storm would regress UX.
- `finish(...)` signature grows nothing; it already passes `duration_secs`. Change its `text: Option<&str>` flow to carry the `Transcription` (or pass segments/words alongside) from `process_file`.

### UI changes

`src/widgets/output-settings/ui/OutputSettingsPanel.tsx`:
- Render the five formats as a multi-select control backed directly by the non-empty `fileTranscriptionFormats` array.
- Toggling writes `updateGeneral({ fileTranscriptionFormats: next })`; forbid deselecting the last item.
- Capability honesty: update the tooltip copy (`fileTranscriptionFormatTooltip` in `messages/en.json` + the other 20 locale files) to state that VTT/SRT/CSV timestamps are segment-level from voice-activity boundaries, and JSON word-level timings are included only for Whisper "timestamped" model exports (otherwise `words` is empty). No per-model UI gating needed since every format always produces valid output.
- `src/views/settings/lib/settings-search.ts` line ~104: extend keywords with `vtt json csv webvtt subtitles`.
- Docs: `docs/content/docs/file-transcription.mdx` format table.

### Step ordering

1. `transcript_export.rs`: types + 5 serializers + timestamp/escape helpers + full unit-test suite (pure, no app deps) — compiles and tests green independently.
2. `vad_segment_decode_segments` (+ words) in `vad_segment.rs` with unit tests on the chunk-plan helpers.
3. `SttBackend::decode_file` + `TranscriptionManager::transcribe_file` refactor (behavior-preserving for existing callers; run existing `cargo test`).
4. Settings schema (Rust enum + vec + accessor), Zod schema, contract entry; `cargo test export_bindings` to regenerate bindings.
5. `FileTranscribeManager` writer loop + Ask-mode single-dialog rule + TXT-only fast path.
6. UI multi-select + helper + i18n keys + settings-search + docs.
7. `bun run typecheck:all`, `bun run test`, `cargo test` in `src-tauri`, Biome (`bun run check` per repo scripts).

### Test list

Rust (`transcript_export.rs` tests module, fixture: 3 segments incl. words on segment 1):
- `srt_emits_per_segment_cues_with_comma_millis`
- `vtt_starts_with_webvtt_header_and_dot_millis`
- `vtt_and_srt_format_timestamps_over_one_hour` (e.g. 3661.5 s → `01:01:01,500` / `01:01:01.500`)
- `vtt_escapes_angle_brackets_and_ampersand`
- `vtt_emits_voice_tag_when_speaker_present` / `omits_when_none`
- `vtt_bumps_zero_length_segment_end_by_1ms`
- `overlapping_segments_pass_through_srt_and_vtt`
- `rtl_arabic_text_survives_all_serializers_byte_identically` (use an Arabic fixture string)
- `json_schema_v1_golden` (exact golden string: schema tag, words empty array present, confidence/speaker omitted)
- `json_words_empty_array_when_no_word_timings`
- `csv_quotes_commas_quotes_and_newlines_rfc4180`
- `decimal_separator_is_dot_in_vtt_csv_and_comma_in_srt_regardless_of_env`
- `no_segments_degrades_to_single_full_duration_segment` (all formats)
- vad_segment: `decode_segments_offsets_chunk_times_into_original_timeline`, `non_whisper_engine_yields_one_segment_per_chunk` (use a stub `Transcriber`)
- settings_schema: canonical default and deduplication tests

Frontend (bun test):
- `settings-schema.test.ts`: enum accepts `vtt|json|csv`; rejects `pdf` still; `fileTranscriptionFormats` defaults `[]`, catches garbage to `[]`.
- New `resolve-selected-formats.test.ts`: empty array → `["txt"]`; non-empty wins; last-item cannot be removed (helper-level rule).
- `emit-coverage`/contract tests will fail until `settings-contract.ts` is updated — that's the guard working.

### Critical Files for Implementation
- `src-tauri/src/winstt/managers/file_transcribe_manager.rs`
- `src-tauri/src/winstt/managers/transcode.rs` (serializers move out to new sibling `transcript_export.rs`)
- `src-tauri/src/winstt/stt/vad_segment.rs`
- `src-tauri/src/winstt/settings_schema.rs` (+ `src/shared/config/settings-schema/general.ts`)
- `src/widgets/output-settings/ui/OutputSettingsPanel.tsx`
