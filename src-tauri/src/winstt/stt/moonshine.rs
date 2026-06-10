// Moonshine ASR (Useful Sensors / onnx-community export).
// Reference (decode correctness): onnx-asr fork src/onnx_asr/models/moonshine.py
//   (<onnx-asr>/src/onnx_asr/models/moonshine.py) — the 3-graph structure,
//   greedy KV decode loop, and the SentencePiece byte-fallback `_decode_text`.
//
// Near-clone of `whisper.rs` (same ort host-copy KV-cache decode, present.* → past.* carry,
// the "keep prev when present is 0-length" merge) MINUS the mel front-end (Moonshine takes
// RAW 16 kHz f32 audio) and MINUS Whisper's prompt/timestamps/cross-attention. The tokenizer
// is a DIFFERENT beast (SentencePiece byte-fallback BPE, NOT Whisper's GPT-2 byte-BPE).
//
// Graph layout (verified against the cached onnx-community/moonshine-tiny-ONNX graphs via
// onnx.load; matches moonshine.py's docstring exactly):
//   * encoder_model.onnx          : input `input_values` (1, n_samples) f32 raw PCM →
//                                   `last_hidden_state` (1, enc_T, 288). NO attention_mask.
//   * decoder_model.onnx          : step 0. inputs `input_ids` + `encoder_hidden_states`;
//                                   outputs `logits` + present.{0..L-1}.{decoder,encoder}.{key,value}.
//   * decoder_with_past_model.onnx: cached steps. inputs `input_ids` (1,1) + ALL
//                                   past_key_values.{0..L-1}.{decoder,encoder}.{key,value};
//                                   outputs `logits` + present.{0..L-1}.decoder.{key,value} ONLY
//                                   (encoder K/V are static — fed straight back from step-0 output).
//
// Newer re-exports (moonshine-tiny-{uk,fr}-ONNX, transformers >= 4.57) ADD `attention_mask`
// (encoder), `encoder_attention_mask`, and a recomputed `encoder_hidden_states` on the past-step
// decoder. We gate every one of those on the graph actually declaring the input (session.inputs()
// name probe) so both layouts load through the same code — exactly like moonshine.py.

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::Path;

use ort::session::builder::GraphOptimizationLevel;
use ort::session::{Session, SessionInputValue};
use ort::value::{Tensor, TensorRef};

use super::{
    execution_providers, kv_sort_key, num_cpus_best_effort as num_cpus, provider_label,
    Accelerator, EngineConfig, EngineKind, SttError, SttResult, TranscribeOptions, Transcriber,
    Transcription,
};

/// onnx-asr `_DEFAULT_MAX_LENGTH` — a safety cap on a runaway greedy decode. Moonshine's
/// `max_position_embeddings` is 512; 448 matches Whisper's classic cap and is plenty for
/// short-form ASR.
const MAX_LENGTH: usize = 448;

/// SentencePiece "underscore" — the visible substitute for an ASCII space in a token piece.
const SP_SPACE: char = '\u{2581}';

/// A loaded Moonshine engine (`EngineKind::Moonshine`). Holds the three ORT sessions, the parsed
/// SentencePiece tokenizer, and the per-load capability flags / cached graph layout.
pub struct MoonshineEngine {
    model_name: String,
    encoder: Session,
    decoder: Session,
    decoder_with_past: Session,
    tokenizer: MoonshineTokenizer,
    providers: Vec<String>,
    /// Sorted `past_key_values.*` decoder-with-past input names (canonical layer/sub order).
    past_input_names: Vec<String>,
    /// Sorted `present.*` step-0 decoder output names (24 tensors: decoder + encoder K/V).
    present_output_names: Vec<String>,
    /// Sorted `present.*` past-step decoder output names (12 tensors: decoder K/V only).
    past_present_names: Vec<String>,
    /// Encoder `attention_mask` input name, if the export declares one (newer re-exports).
    encoder_mask_name: Option<String>,
    /// Step-0 decoder `encoder_attention_mask` input name, if declared.
    decoder_enc_mask_name: Option<String>,
    /// Past-step decoder `encoder_attention_mask` input name, if declared.
    past_enc_mask_name: Option<String>,
    /// Past-step decoder `encoder_hidden_states` input name, if declared (re-exports recompute
    /// cross-attention every step instead of caching it).
    past_enc_hidden_name: Option<String>,
    ready: bool,
}

impl MoonshineEngine {
    /// Build the three sessions + tokenizer from a resolved file set.
    pub fn load(cfg: &EngineConfig) -> SttResult<Self> {
        let files = &cfg.resolved.files;
        let get = |k: &str| -> SttResult<&Path> {
            files
                .get(k)
                .map(|p| p.as_path())
                .ok_or_else(|| SttError::Resolve(format!("moonshine: missing resolved file '{k}'")))
        };
        let encoder_path = get("encoder")?;
        let decoder_path = get("decoder")?;
        let decoder_with_past_path = get("decoder_with_past")?;
        let tokenizer_path = get("tokenizer")?;
        let tokenizer_config_path = files.get("tokenizer_config").map(|p| p.as_path());

        let tokenizer = MoonshineTokenizer::load(tokenizer_path, tokenizer_config_path)?;

        // PERFORMANCE — Moonshine is CPU-ONLY. Its autoregressive decode carries the KV cache
        // host-side per token, so on DirectML every step round-trips device↔host; for a model
        // this tiny the GPU launch + transfer overhead LOSES to CPU (benchmarked: moonshine-tiny
        // JFK warm 189ms CPU vs 530ms DML — 2.8×). NOTE this is a SPEED choice, not a correctness
        // gate: Moonshine decodes CORRECTLY on DML, just slower, so we force CPU locally here
        // rather than adding it to the engine-kind incompatibility list for graphs that actually
        // crash on DML.
        // is_gpu=false → ORT gets the full CPU intra-op thread pool, not the GPU's single thread.
        let intra = super::pick_intra_op_threads(false, num_cpus());

        let encoder = build_session(encoder_path, intra)?;
        let decoder = build_session(decoder_path, intra)?;
        let decoder_with_past = build_session(decoder_with_past_path, intra)?;

        // Probe optional mask / re-fed encoder inputs (only the uk/fr re-exports declare them).
        let encoder_mask_name = input_named(&encoder, "attention_mask");
        let decoder_enc_mask_name = input_named(&decoder, "encoder_attention_mask");
        let past_enc_mask_name = input_named(&decoder_with_past, "encoder_attention_mask");
        let past_enc_hidden_name = input_named(&decoder_with_past, "encoder_hidden_states");

        // Cache the past-step KV layout (sorted) so we don't re-query the session per step.
        let mut past_input_names: Vec<String> = decoder_with_past
            .inputs()
            .iter()
            .map(|o| o.name().to_string())
            .filter(|n| n.starts_with("past_key_values."))
            .collect();
        past_input_names.sort_by_key(|n| kv_sort_key(n));

        let mut present_output_names: Vec<String> = decoder
            .outputs()
            .iter()
            .map(|o| o.name().to_string())
            .filter(|n| n.starts_with("present."))
            .collect();
        present_output_names.sort_by_key(|n| kv_sort_key(n));

        let mut past_present_names: Vec<String> = decoder_with_past
            .outputs()
            .iter()
            .map(|o| o.name().to_string())
            .filter(|n| n.starts_with("present."))
            .collect();
        past_present_names.sort_by_key(|n| kv_sort_key(n));

        if std::env::var("WINSTT_STT_DEBUG").is_ok() {
            eprintln!(
                "[moonshine] past_kv={} present0={} present_past={} bos={} eos={} \
				 enc_mask={:?} dec_enc_mask={:?} past_enc_mask={:?} past_enc_hidden={:?}",
                past_input_names.len(),
                present_output_names.len(),
                past_present_names.len(),
                tokenizer.bos_id,
                tokenizer.eos_id,
                encoder_mask_name,
                decoder_enc_mask_name,
                past_enc_mask_name,
                past_enc_hidden_name,
            );
        }

        // CPU-forced (see above) → report CPU as the active provider, not the requested device.
        let providers = [Accelerator::Cpu].iter().map(provider_label).collect();

        Ok(Self {
            model_name: cfg.model_name.clone(),
            encoder,
            decoder,
            decoder_with_past,
            tokenizer,
            providers,
            past_input_names,
            present_output_names,
            past_present_names,
            encoder_mask_name,
            decoder_enc_mask_name,
            past_enc_mask_name,
            past_enc_hidden_name,
            ready: true,
        })
    }

    /// Run the encoder once over the whole utterance. Moonshine eats the RAW waveform —
    /// `(1, num_samples)` straight through, no mel, no fixed window. Returns the device-host
    /// `last_hidden_state` as `(shape, f32 data)`.
    fn encode(&mut self, audio: &[f32]) -> SttResult<(Vec<i64>, Vec<f32>)> {
        let n = audio.len();
        let input = Tensor::from_array(([1usize, n], audio.to_vec().into_boxed_slice()))
            .map_err(|e| SttError::Inference(format!("encoder input_values: {e}")))?;
        let mut named: Vec<(Cow<'_, str>, SessionInputValue<'_>)> = Vec::with_capacity(2);
        named.push((
            Cow::Borrowed("input_values"),
            SessionInputValue::from(input),
        ));
        if let Some(mask_name) = &self.encoder_mask_name {
            let mask = Tensor::from_array(([1usize, n], vec![1i64; n].into_boxed_slice()))
                .map_err(|e| SttError::Inference(format!("encoder attention_mask: {e}")))?;
            named.push((Cow::Owned(mask_name.clone()), SessionInputValue::from(mask)));
        }
        let outputs = self
            .encoder
            .run(named)
            .map_err(|e| SttError::Inference(format!("encoder run: {e}")))?;
        let hidden = outputs
            .get("last_hidden_state")
            .ok_or_else(|| SttError::Inference("encoder produced no last_hidden_state".into()))?;
        let (shape, data) = hidden
            .try_extract_tensor::<f32>()
            .map_err(|e| SttError::Inference(format!("encoder output extract: {e}")))?;
        Ok((shape.to_vec(), data.to_vec()))
    }

    /// Greedy autoregressive decode for one waveform. Returns the full token sequence
    /// (prompt + generated, INCLUDING the trailing eos). Port of `moonshine.py::_decode_greedy`.
    fn decode_greedy(&mut self, enc_shape: &[i64], enc_data: &[f32]) -> SttResult<Vec<i64>> {
        let bos = self.tokenizer.bos_id;
        let eos = self.tokenizer.eos_id;
        let enc_shape_usize: Vec<usize> = enc_shape.iter().map(|&d| d.max(0) as usize).collect();
        // All-ones cross-attention mask over the encoder time axis — only fed to graphs that
        // declare `encoder_attention_mask`. Built once, reused every step.
        let enc_frames = enc_shape.get(1).copied().unwrap_or(0).max(0) as usize;

        let mut tokens: Vec<i64> = vec![bos];

        // ── step 0: decoder_model.onnx (no past) seeds the KV cache ──
        let (logits0, state) =
            self.first_decode_step(&enc_shape_usize, enc_data, &tokens, enc_frames)?;
        let mut next = argmax_last(&logits0.1, &logits0.0);
        tokens.push(next);
        // Carried KV cache host-side: name → (shape, data). Seeded by step 0's present.* outputs.
        let mut state = state;

        while tokens.len() < MAX_LENGTH && next != eos {
            let (logits, new_state) =
                self.past_decode_step(next, &state, enc_data, &enc_shape_usize, enc_frames)?;
            next = argmax_last(&logits.1, &logits.0);
            // EOS-sticky: once we emitted eos we stop (loop guard), but keep the value consistent.
            tokens.push(next);
            state = new_state;
        }

        Ok(tokens)
    }

    /// Run `decoder_model.onnx` (step 0, no past). Returns `((logits_shape, logits_data), state)`
    /// where `state` maps each `past_key_values.*` name → its (shape, data) carried-forward cache.
    #[expect(
        clippy::type_complexity,
        reason = "logits tuple + KV-cache state map mirror the ONNX decoder I/O shape"
    )]
    fn first_decode_step(
        &mut self,
        enc_shape_usize: &[usize],
        enc_data: &[f32],
        prompt: &[i64],
        enc_frames: usize,
    ) -> SttResult<((Vec<i64>, Vec<f32>), HashMap<String, (Vec<i64>, Vec<f32>)>)> {
        let input_ids =
            Tensor::from_array(([1usize, prompt.len()], prompt.to_vec().into_boxed_slice()))
                .map_err(|e| SttError::Inference(format!("decoder input_ids: {e}")))?;
        let enc_hidden = TensorRef::from_array_view((enc_shape_usize.to_vec(), enc_data))
            .map_err(|e| SttError::Inference(format!("decoder enc_hidden: {e}")))?;

        let mut named: Vec<(Cow<'_, str>, SessionInputValue<'_>)> = Vec::with_capacity(3);
        named.push((
            Cow::Borrowed("input_ids"),
            SessionInputValue::from(input_ids),
        ));
        named.push((
            Cow::Borrowed("encoder_hidden_states"),
            SessionInputValue::from(enc_hidden),
        ));
        if let Some(mask_name) = &self.decoder_enc_mask_name {
            let mask = Tensor::from_array((
                [1usize, enc_frames],
                vec![1i64; enc_frames].into_boxed_slice(),
            ))
            .map_err(|e| SttError::Inference(format!("decoder enc mask: {e}")))?;
            named.push((Cow::Owned(mask_name.clone()), SessionInputValue::from(mask)));
        }

        let outputs = self
            .decoder
            .run(named)
            .map_err(|e| SttError::Inference(format!("decoder run (step 0): {e}")))?;

        let logits = {
            let v = outputs
                .get("logits")
                .ok_or_else(|| SttError::Inference("decoder produced no logits".into()))?;
            let (s, d) = v
                .try_extract_tensor::<f32>()
                .map_err(|e| SttError::Inference(format!("logits extract: {e}")))?;
            (s.to_vec(), d.to_vec())
        };

        // present.{layer}.{decoder|encoder}.{key|value} → past_key_values.<same suffix>.
        let mut state: HashMap<String, (Vec<i64>, Vec<f32>)> =
            HashMap::with_capacity(self.present_output_names.len());
        for present_name in &self.present_output_names {
            let v = outputs.get(present_name.as_str()).ok_or_else(|| {
                SttError::Inference(format!("decoder produced no {present_name}"))
            })?;
            let (s, d) = v
                .try_extract_tensor::<f32>()
                .map_err(|e| SttError::Inference(format!("{present_name} extract: {e}")))?;
            let past_name = present_name.replacen("present.", "past_key_values.", 1);
            state.insert(past_name, (s.to_vec(), d.to_vec()));
        }

        Ok((logits, state))
    }

    /// Run `decoder_with_past_model.onnx` for one autoregressive step. Feeds the last token + the
    /// full KV state; carries the new decoder-self-attn present.* back, KEEPS the static encoder
    /// K/V from `state`. Returns `((logits_shape, logits_data), new_state)`.
    #[expect(
        clippy::type_complexity,
        reason = "logits tuple + KV-cache state map mirror the ONNX decoder I/O shape"
    )]
    fn past_decode_step(
        &mut self,
        next_token: i64,
        state: &HashMap<String, (Vec<i64>, Vec<f32>)>,
        enc_data: &[f32],
        enc_shape_usize: &[usize],
        enc_frames: usize,
    ) -> SttResult<((Vec<i64>, Vec<f32>), HashMap<String, (Vec<i64>, Vec<f32>)>)> {
        let input_ids = Tensor::from_array(([1usize, 1usize], vec![next_token].into_boxed_slice()))
            .map_err(|e| SttError::Inference(format!("past input_ids: {e}")))?;

        let mut named: Vec<(Cow<'_, str>, SessionInputValue<'_>)> =
            Vec::with_capacity(self.past_input_names.len() + 3);
        named.push((
            Cow::Borrowed("input_ids"),
            SessionInputValue::from(input_ids),
        ));
        // Only fed when the re-export declares them.
        if let Some(mask_name) = &self.past_enc_mask_name {
            let mask = Tensor::from_array((
                [1usize, enc_frames],
                vec![1i64; enc_frames].into_boxed_slice(),
            ))
            .map_err(|e| SttError::Inference(format!("past enc mask: {e}")))?;
            named.push((Cow::Owned(mask_name.clone()), SessionInputValue::from(mask)));
        }
        if let Some(hidden_name) = &self.past_enc_hidden_name {
            let enc_hidden = TensorRef::from_array_view((enc_shape_usize.to_vec(), enc_data))
                .map_err(|e| SttError::Inference(format!("past enc_hidden: {e}")))?;
            named.push((
                Cow::Owned(hidden_name.clone()),
                SessionInputValue::from(enc_hidden),
            ));
        }
        // Build owned past_key_values.* tensors from the carried state.
        for name in &self.past_input_names {
            let (shape, data) = state
                .get(name)
                .ok_or_else(|| SttError::Inference(format!("missing carried KV {name}")))?;
            let usize_shape: Vec<usize> = shape.iter().map(|&x| x.max(0) as usize).collect();
            let t = Tensor::from_array((usize_shape, data.clone().into_boxed_slice()))
                .map_err(|e| SttError::Inference(format!("past kv {name}: {e}")))?;
            named.push((Cow::Owned(name.clone()), SessionInputValue::from(t)));
        }

        let outputs = self
            .decoder_with_past
            .run(named)
            .map_err(|e| SttError::Inference(format!("decoder_with_past run: {e}")))?;

        let logits = {
            let v = outputs
                .get("logits")
                .ok_or_else(|| SttError::Inference("past decoder produced no logits".into()))?;
            let (s, d) = v
                .try_extract_tensor::<f32>()
                .map_err(|e| SttError::Inference(format!("past logits extract: {e}")))?;
            (s.to_vec(), d.to_vec())
        };

        // Carry over: start from the previous state (keeps the static encoder K/V) and overwrite
        // only the decoder-self-attn present.* the past-step graph re-emits.
        let mut new_state = state.clone();
        for present_name in &self.past_present_names {
            let v = outputs.get(present_name.as_str()).ok_or_else(|| {
                SttError::Inference(format!("past decoder produced no {present_name}"))
            })?;
            let (s, d) = v
                .try_extract_tensor::<f32>()
                .map_err(|e| SttError::Inference(format!("{present_name} extract: {e}")))?;
            let past_name = present_name.replacen("present.", "past_key_values.", 1);
            new_state.insert(past_name, (s.to_vec(), d.to_vec()));
        }

        Ok((logits, new_state))
    }
}

impl Transcriber for MoonshineEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::Moonshine
    }

    fn model_name(&self) -> &str {
        &self.model_name
    }

    fn is_ready(&self) -> bool {
        self.ready
    }

    fn active_providers(&self) -> &[String] {
        &self.providers
    }

    fn transcribe(&mut self, audio: &[f32], _opts: &TranscribeOptions) -> SttResult<Transcription> {
        if audio.is_empty() {
            return Ok(Transcription::default());
        }
        let (enc_shape, enc_data) = self.encode(audio)?;
        let tokens = self.decode_greedy(&enc_shape, &enc_data)?;
        // Strip the leading bos before rendering (moonshine.py: `tokens[0, 1:]`).
        let body: &[i64] = if tokens.first().copied() == Some(self.tokenizer.bos_id) {
            &tokens[1..]
        } else {
            &tokens
        };
        let text = self.tokenizer.decode_text(body);
        Ok(Transcription {
            text,
            segments: None,
            words: None,
        })
    }

    fn shutdown(&mut self) {
        self.ready = false;
    }
}

// ---------------------------------------------------------------------------
// Tokenizer (SentencePiece byte-fallback BPE parsed from tokenizer.json)
// ---------------------------------------------------------------------------

/// Moonshine's SentencePiece byte-fallback tokenizer, parsed straight from `tokenizer.json`
/// (no `tokenizers`/`sentencepiece` dependency — we only need id → text). Port of
/// `moonshine.py::_load_tokenizer` + `_decode_text`.
struct MoonshineTokenizer {
    id_to_token: HashMap<i64, String>,
    special_token_ids: std::collections::HashSet<i64>,
    bos_id: i64,
    eos_id: i64,
}

impl MoonshineTokenizer {
    fn load(tokenizer_path: &Path, tokenizer_config_path: Option<&Path>) -> SttResult<Self> {
        let raw = std::fs::read_to_string(tokenizer_path)
            .map_err(|e| SttError::Tokenizer(format!("read {}: {e}", tokenizer_path.display())))?;
        let tok: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| SttError::Tokenizer(format!("parse tokenizer.json: {e}")))?;

        let mut id_to_token: HashMap<i64, String> = HashMap::new();
        let mut special_token_ids: std::collections::HashSet<i64> =
            std::collections::HashSet::new();
        let mut bos_id: Option<i64> = None;
        let mut eos_id: Option<i64> = None;

        // model.vocab is `{piece: id}` for a BPE model (rust-tokenizers canonical layout).
        if let Some(vocab) = tok.get("model").and_then(|m| m.get("vocab")) {
            if let Some(map) = vocab.as_object() {
                for (piece, idx) in map {
                    if let Some(id) = idx.as_i64() {
                        id_to_token.insert(id, piece.clone());
                    }
                }
            } else if let Some(list) = vocab.as_array() {
                // SentencePiece-unigram fallback: a list of [piece, score] (or bare pieces).
                for (i, entry) in list.iter().enumerate() {
                    let piece = entry
                        .as_array()
                        .and_then(|a| a.first())
                        .and_then(|p| p.as_str())
                        .or_else(|| entry.as_str())
                        .unwrap_or("");
                    id_to_token.insert(i as i64, piece.to_string());
                }
            }
        }

        // added_tokens (specials + the <<ST_*>> timestamp markers) live OUTSIDE model.vocab.
        if let Some(added) = tok.get("added_tokens").and_then(|a| a.as_array()) {
            for entry in added {
                let Some(tid) = entry.get("id").and_then(|x| x.as_i64()) else {
                    continue;
                };
                let content = entry
                    .get("content")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                let special = entry
                    .get("special")
                    .and_then(|s| s.as_bool())
                    .unwrap_or(false);
                if content == "<s>" {
                    bos_id = Some(tid);
                } else if content == "</s>" {
                    eos_id = Some(tid);
                }
                id_to_token.insert(tid, content);
                if special {
                    special_token_ids.insert(tid);
                }
            }
        }

        // tokenizer_config.json's added_tokens_decoder is the same data in a slightly different
        // shape — read as a belt-and-braces fallback (a variant might ship only one file).
        if let Some(cfg_path) = tokenizer_config_path {
            if let Ok(cfg_raw) = std::fs::read_to_string(cfg_path) {
                if let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&cfg_raw) {
                    if let Some(atd) = cfg.get("added_tokens_decoder").and_then(|a| a.as_object()) {
                        for (tid_str, entry) in atd {
                            let Ok(tid) = tid_str.parse::<i64>() else {
                                continue;
                            };
                            let content = entry
                                .get("content")
                                .and_then(|c| c.as_str())
                                .unwrap_or("")
                                .to_string();
                            let special = entry
                                .get("special")
                                .and_then(|s| s.as_bool())
                                .unwrap_or(false);
                            id_to_token.entry(tid).or_insert_with(|| content.clone());
                            if special {
                                special_token_ids.insert(tid);
                            }
                            if content == "<s>" && bos_id.is_none() {
                                bos_id = Some(tid);
                            } else if content == "</s>" && eos_id.is_none() {
                                eos_id = Some(tid);
                            }
                        }
                    }
                }
            }
        }

        Ok(Self {
            id_to_token,
            special_token_ids,
            // Canonical Moonshine ids if the JSON didn't name the tokens (<s>=1, </s>=2).
            bos_id: bos_id.unwrap_or(1),
            eos_id: eos_id.unwrap_or(2),
        })
    }

    /// Render decoder token ids → plain text. Mirrors the JSON `decoder` chain shipped in
    /// `tokenizer.json` (Replace ▁→space, ByteFallback, Fuse, Strip ONE leading space), exactly
    /// like `moonshine.py::_decode_text`:
    ///   1. id → piece (skip ids flagged special — bos/eos/<<ST_*>> contribute no characters);
    ///   2. byte-fallback: pieces `<0xNN>` buffer a raw byte, decoded as UTF-8 when the run breaks;
    ///   3. ▁ (U+2581) → ASCII space;
    ///   4. strip the single SentencePiece-prepended leading space.
    fn decode_text(&self, ids: &[i64]) -> String {
        let mut byte_buf: Vec<u8> = Vec::new();
        let mut out = String::new();

        let flush = |byte_buf: &mut Vec<u8>, out: &mut String| {
            if !byte_buf.is_empty() {
                out.push_str(&String::from_utf8_lossy(byte_buf));
                byte_buf.clear();
            }
        };

        for &tid in ids {
            if self.special_token_ids.contains(&tid) {
                flush(&mut byte_buf, &mut out);
                continue;
            }
            let Some(piece) = self.id_to_token.get(&tid) else {
                flush(&mut byte_buf, &mut out);
                continue;
            };
            // Byte-fallback pieces: `<0xNN>` (exactly 6 chars: `<0x` + 2 hex + `>`).
            let bytes = piece.as_bytes();
            if bytes.len() == 6 && piece.starts_with("<0x") && piece.ends_with('>') {
                if let Ok(b) = u8::from_str_radix(&piece[3..5], 16) {
                    byte_buf.push(b);
                    continue;
                }
            }
            flush(&mut byte_buf, &mut out);
            out.push_str(piece);
        }
        flush(&mut byte_buf, &mut out);

        let text = out.replace(SP_SPACE, " ");
        text.strip_prefix(' ')
            .map(|s| s.to_string())
            .unwrap_or(text)
    }
}

// ---------------------------------------------------------------------------
// Session construction + ORT helpers (provider/argmax/KV helpers are shared in `super`)
// ---------------------------------------------------------------------------

/// Build one ORT session, CPU-ONLY (see `load()`: the host-copy KV decode loses to CPU on DML
/// for this tiny model). Moonshine keeps full optimization (no fp16 EXTENDED downgrade — it isn't
/// in INT8_PREFERRED / DML_INCOMPATIBLE and the default export is fp32).
fn build_session(path: &Path, intra: usize) -> SttResult<Session> {
    let mut builder = Session::builder()
        .map_err(|e| SttError::SessionCreate(format!("session builder: {e}")))?
        .with_execution_providers(execution_providers(&[Accelerator::Cpu]))
        .map_err(|e| SttError::SessionCreate(format!("set providers: {e}")))?
        .with_optimization_level(GraphOptimizationLevel::All)
        .map_err(|e| SttError::SessionCreate(format!("opt level: {e}")))?
        .with_intra_threads(intra)
        .map_err(|e| SttError::SessionCreate(format!("intra threads: {e}")))?;
    builder
        .commit_from_file(path)
        .map_err(|e| SttError::SessionCreate(format!("commit {}: {e}", path.display())))
}

/// Return the session input name matching `name` exactly, if the graph declares it.
fn input_named(session: &Session, name: &str) -> Option<String> {
    session
        .inputs()
        .iter()
        .find(|o| o.name() == name)
        .map(|o| o.name().to_string())
}

/// argmax over the LAST decoder position of a `(1, seq, vocab)` logits tensor. Empty → 0.
fn argmax_last(data: &[f32], shape: &[i64]) -> i64 {
    let vocab = shape.last().copied().unwrap_or(0).max(0) as usize;
    if vocab == 0 || data.is_empty() {
        return 0;
    }
    let seq = if shape.len() >= 2 {
        shape[shape.len() - 2].max(1) as usize
    } else {
        1
    };
    let last_off = seq.saturating_sub(1) * vocab;
    let slice = &data[last_off..(last_off + vocab).min(data.len())];
    let mut best = 0usize;
    let mut best_v = f32::NEG_INFINITY;
    for (i, &v) in slice.iter().enumerate() {
        if v > best_v {
            best_v = v;
            best = i;
        }
    }
    best as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tk_with(pairs: &[(i64, &str)], specials: &[i64]) -> MoonshineTokenizer {
        let mut id_to_token = HashMap::new();
        for &(id, p) in pairs {
            id_to_token.insert(id, p.to_string());
        }
        MoonshineTokenizer {
            id_to_token,
            special_token_ids: specials.iter().copied().collect(),
            bos_id: 1,
            eos_id: 2,
        }
    }

    #[test]
    fn decode_maps_underscore_to_space_and_strips_leading() {
        // "▁And ▁so" style: leading ▁ becomes a leading space then is stripped.
        let tk = tk_with(
            &[
                (10, "\u{2581}And"),
                (11, "\u{2581}so"),
                (1, "<s>"),
                (2, "</s>"),
            ],
            &[1, 2],
        );
        assert_eq!(tk.decode_text(&[10, 11]), "And so");
        // bos/eos are special → contribute nothing.
        assert_eq!(tk.decode_text(&[1, 10, 11, 2]), "And so");
    }

    #[test]
    fn decode_byte_fallback_assembles_utf8() {
        // '€' = E2 82 AC in UTF-8 → three <0xNN> byte pieces fused.
        let tk = tk_with(
            &[
                (3, "<0xE2>"),
                (4, "<0x82>"),
                (5, "<0xAC>"),
                (10, "\u{2581}x"),
            ],
            &[],
        );
        // "▁x" then the euro bytes → "x€".
        assert_eq!(tk.decode_text(&[10, 3, 4, 5]), "x€");
    }

    #[test]
    fn argmax_last_picks_last_position() {
        // shape (1, 2, 3): two positions; the LAST one's argmax is index 0 here.
        let data = vec![0.1, 0.9, 0.3, /*pos1:*/ 5.0, 1.0, 2.0];
        assert_eq!(argmax_last(&data, &[1, 2, 3]), 0);
        // single position (1,1,3): argmax index 2.
        assert_eq!(argmax_last(&[0.1, 0.2, 0.9], &[1, 1, 3]), 2);
        // empty / zero-vocab → 0.
        assert_eq!(argmax_last(&[], &[1, 0, 0]), 0);
    }

    #[test]
    fn kv_sort_orders_present_and_past() {
        let mut names = [
            "present.10.encoder.value".to_string(),
            "past_key_values.2.decoder.key".to_string(),
            "present.2.decoder.value".to_string(),
            "past_key_values.2.encoder.key".to_string(),
        ];
        names.sort_by_key(|n| kv_sort_key(n));
        assert_eq!(names[0], "past_key_values.2.decoder.key");
        assert_eq!(names[1], "present.2.decoder.value");
        assert_eq!(names[2], "past_key_values.2.encoder.key");
        assert_eq!(names[3], "present.10.encoder.value");
    }
}
