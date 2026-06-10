// Canary AED (NeMo encoder/decoder with the `decoder_mems` loop).
//
// Static 10-token control prompt; encoder → (encoder_embeddings, encoder_mask); decoder runs with
// growing `decoder_mems` (full input when mems.shape[2]==0 else last-token-only). Stop on all-EOS
// or max_sequence_length=1024. <|...|> stripped on decode. `<|startofcontext|>` is UNTRAINED → no
// prompt injection (enforced by EngineKind::supports_initial_prompt()==false upstream).

use std::collections::BTreeMap;

use ndarray::{Array2, ArrayD};
use ort::session::Session;
use ort::value::{Tensor, TensorRef};

use super::*;

pub struct CanaryEngine {
    encoder: Session,
    decoder: Session,
    vocab: Vocab,
    token_to_id: BTreeMap<String, i64>,
    transcribe_input: Vec<i64>,
    eos_token_id: i64,
    max_sequence_length: usize,
    mel_fb: Array2<f32>,
    model_name: String,
    providers: Vec<String>,
}

fn canary_concrete_language(raw: &str) -> Option<&str> {
    let lang = raw.trim();
    if lang.is_empty() || lang == "auto" {
        None
    } else {
        Some(lang)
    }
}

fn canary_configured_language(opts: &TranscribeOptions) -> Option<&str> {
    opts.language
        .as_deref()
        .and_then(canary_concrete_language)
        .or_else(|| {
            opts.language_candidates
                .iter()
                .map(String::as_str)
                .find_map(canary_concrete_language)
        })
}

pub(in crate::winstt::stt::families) fn canary_prompt_tokens(
    base: &[i64],
    token_to_id: &BTreeMap<String, i64>,
    opts: &TranscribeOptions,
) -> Vec<i64> {
    let mut toks = base.to_vec();
    if toks.len() < 6 {
        return toks;
    }
    if let Some(lang) = canary_configured_language(opts) {
        if let Some(&id) = token_to_id.get(&format!("<|{lang}|>")) {
            toks[4] = id;
            toks[5] = id;
        }
    }
    if opts.translate {
        if let Some(&id) = token_to_id.get("<|en|>") {
            toks[5] = id;
        }
    }
    toks
}

impl CanaryEngine {
    pub fn load(cfg: &EngineConfig) -> SttResult<CanaryEngine> {
        let encoder = build_session(file(&cfg.resolved, "encoder")?, &cfg.providers)?;
        let decoder = build_session(file(&cfg.resolved, "decoder")?, &cfg.providers)?;
        // Canary declares 128-mel `audio_signal`; read it before `encoder` is moved into the struct.
        let mel_fb = frontend::build_nemo_mel_filterbank(feat_dim_of(&encoder, "audio_signal"));
        // Load with `▁→space` (matches `_AsrWithDecoding.__init__`): the prompt's `" "` slot resolves
        // to the `▁`-origin token, and the decode appends already-spaced symbols.
        let vocab = Vocab::load(file(&cfg.resolved, "vocab")?, false, true)?;
        let token_to_id: BTreeMap<String, i64> = vocab
            .id_to_sym
            .iter()
            .map(|(&i, t)| (t.clone(), i))
            .collect();

        let need = |t: &str| -> SttResult<i64> {
            token_to_id
                .get(t)
                .copied()
                .ok_or_else(|| SttError::Tokenizer(format!("canary missing token {t}")))
        };
        let transcribe_input = vec![
            need(" ")?,
            need("<|startofcontext|>")?,
            need("<|startoftranscript|>")?,
            need("<|emo:undefined|>")?,
            need("<|en|>")?,
            need("<|en|>")?,
            need("<|pnc|>")?,
            need("<|noitn|>")?,
            need("<|notimestamp|>")?,
            need("<|nodiarize|>")?,
        ];
        let eos_token_id = need("<|endoftext|>")?;

        Ok(CanaryEngine {
            encoder,
            decoder,
            vocab,
            token_to_id,
            transcribe_input,
            eos_token_id,
            max_sequence_length: 1024,
            mel_fb,
            model_name: cfg.model_name.clone(),
            providers: providers_to_strings(&cfg.providers),
        })
    }

    fn prompt_for(&self, opts: &TranscribeOptions) -> Vec<i64> {
        canary_prompt_tokens(&self.transcribe_input, &self.token_to_id, opts)
    }
}

impl Transcriber for CanaryEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::NemoAed
    }
    fn model_name(&self) -> &str {
        &self.model_name
    }
    fn is_ready(&self) -> bool {
        true
    }
    fn active_providers(&self) -> &[String] {
        &self.providers
    }

    fn transcribe(&mut self, audio: &[f32], opts: &TranscribeOptions) -> SttResult<Transcription> {
        if audio.is_empty() {
            return Ok(Transcription::default());
        }
        // Encode (audio_signal=(1,feat,T), length=[T]) → (encoder_embeddings, encoder_mask).
        // NeMo 128-mel featurizer (per-feature normalized) — NOT the 80-mel kaldi fbank.
        let fbank = frontend::nemo_features(audio, &self.mel_fb);
        let t = fbank.nrows();
        if t == 0 {
            return Ok(Transcription::default());
        }
        let feat_dim = fbank.ncols();
        // `.t()` is an F-order view; force a C-contiguous owned copy before reshaping
        // (into_shape_with_order rejects the transposed layout — was "incompatible memory layout").
        let x = fbank
            .t()
            .as_standard_layout()
            .into_owned()
            .into_shape_with_order((1, feat_dim, t))
            .map_err(|e| SttError::Inference(format!("canary enc reshape: {e}")))?;
        let x_tensor = Tensor::from_array(x)
            .map_err(|e| SttError::Inference(format!("canary enc tensor: {e}")))?;
        let len_tensor = tensor_i64_1d(vec![t as i64])?;

        let enc_out = self
            .encoder
            .run(ort::inputs![ "audio_signal" => x_tensor, "length" => len_tensor ])
            .map_err(|e| SttError::Inference(format!("canary encoder run: {e}")))?;
        let encoder_embeddings = out_to_f32(&enc_out["encoder_embeddings"])?;
        let encoder_mask = out_to_i64(&enc_out["encoder_mask"])?;
        drop(enc_out); // release &mut self.encoder (SessionOutputs holds it via Drop) before &self use

        let prompt = self.prompt_for(opts);
        let prefix_len = prompt.len();
        let mut batch_tokens: Vec<i64> = prompt;

        // Greedy AED decode with the NeMo `decoder_mems` cache. The decoder returns
        // `decoder_hidden_states`, which becomes the NEXT step's `decoder_mems` (port of
        // nemo.py `NemoConformerAED._decode`/`_decoding`). input_ids = full prompt while the mems
        // are empty (shape[2]==0), then only the last token. EOS breaks BEFORE it's appended.
        // (The prior code re-fed zero mems every step → no context after token 0 → output "And".)
        let enc_shape = encoder_embeddings.shape().to_vec();
        let mask_shape = encoder_mask.shape().to_vec();
        // Initial decoder_mems: (num_layers, 1, 0, hidden) — dms_shape declares mem_len(dim 2)=0.
        let mut decoder_mems: ArrayD<f32> =
            ArrayD::<f32>::zeros(ndarray::IxDyn(&dms_shape(&self.decoder)));

        while batch_tokens.len() < self.max_sequence_length {
            let mem_len = decoder_mems.shape().get(2).copied().unwrap_or(0);
            let (input_len, input_ids_data): (usize, Vec<i64>) = if mem_len == 0 {
                (batch_tokens.len(), batch_tokens.clone())
            } else {
                (1, vec![*batch_tokens.last().unwrap()])
            };
            let input_ids = tensor_i64((1, input_len), input_ids_data)?;

            // Zero-copy: BORROW the static encoder outputs + the current mems as TensorRefs rather
            // than re-cloning them onto the host EVERY token. `clone_f32_arrayd`/`Tensor::from_array`
            // were O(tokens) host re-uploads of the UNCHANGING encoder_embeddings/encoder_mask plus
            // the growing decoder_mems — the dominant cost vs the reference's by-reference numpy onnx-asr
            // path (Rust was far slower than the reference's ~1.8s on canary-1b-int8 purely from this).
            // The borrows live only inside `named`, released when `run` consumes it; decoder_mems is
            // then reassigned from next_mems below.
            let enc_emb = TensorRef::from_array_view((
                enc_shape.as_slice(),
                encoder_embeddings.as_slice().ok_or_else(|| {
                    SttError::Inference("encoder_embeddings not contiguous".into())
                })?,
            ))
            .map_err(|e| SttError::Inference(format!("canary enc_emb view: {e}")))?;
            let enc_mask = TensorRef::from_array_view((
                mask_shape.as_slice(),
                encoder_mask
                    .as_slice()
                    .ok_or_else(|| SttError::Inference("encoder_mask not contiguous".into()))?,
            ))
            .map_err(|e| SttError::Inference(format!("canary enc_mask view: {e}")))?;
            // decoder_mems is 0-length on the FIRST step (mem_len dim = 0). TensorRef's raw-data
            // path rejects 0-sized dims (allocator-backed `Tensor::from_array` accepts them — same
            // gotcha as whisper.rs's empty KV); this carry is small vs the encoder outputs borrowed
            // above, so keep it as an allocator-backed clone.
            let mems_tensor = Tensor::from_array(decoder_mems.clone())
                .map_err(|e| SttError::Inference(format!("canary mems: {e}")))?;

            let named: Vec<(
                std::borrow::Cow<'_, str>,
                ort::session::SessionInputValue<'_>,
            )> = vec![
                (
                    std::borrow::Cow::Borrowed("input_ids"),
                    ort::session::SessionInputValue::from(input_ids),
                ),
                (
                    std::borrow::Cow::Borrowed("encoder_embeddings"),
                    ort::session::SessionInputValue::from(enc_emb),
                ),
                (
                    std::borrow::Cow::Borrowed("encoder_mask"),
                    ort::session::SessionInputValue::from(enc_mask),
                ),
                (
                    std::borrow::Cow::Borrowed("decoder_mems"),
                    ort::session::SessionInputValue::from(mems_tensor),
                ),
            ];
            let outputs = self
                .decoder
                .run(named)
                .map_err(|e| SttError::Inference(format!("canary decoder run: {e}")))?;

            let logits = out_to_f32(&outputs["logits"])?;
            let next_mems = out_to_f32(&outputs["decoder_hidden_states"])?;
            drop(outputs);

            let last = last_step_row(&logits)?;
            let (best, _) = argmax_1d(&last);
            let next = best as i64;
            if next == self.eos_token_id {
                break;
            }
            batch_tokens.push(next);
            decoder_mems = next_mems; // carry decoder_hidden_states → decoder_mems
        }

        // Decode: strip <|...|> tokens.
        let out_tokens = &batch_tokens[prefix_len..];
        let mut text = String::new();
        for &tid in out_tokens {
            if let Some(sym) = self.vocab.get(tid) {
                if !sym.starts_with("<|") {
                    text.push_str(sym);
                }
            }
        }
        let text = join_and_normalize(&[text.as_str()], false);
        Ok(Transcription {
            text,
            ..Default::default()
        })
    }
}
