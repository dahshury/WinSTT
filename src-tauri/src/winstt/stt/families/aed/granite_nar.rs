// Granite-Speech NAR engine (non-autoregressive: CTC draft + insertion-slot editor pass).
//
// Encoder → BPE CTC logits + audio embeds; greedy-collapse a CTC draft, expand it into
// insertion-slot ids, splice audio+text embeds, and run the `editor` graph once to produce the final
// token sequence (no token-by-token loop). Mirrors onnx-asr's Granite NAR decode.

use ndarray::{ArrayD, Axis};
use ort::session::Session;
use ort::value::Tensor;

use super::*;

/// `encode_audio` output: (encoder hidden states, attention mask, audio
/// embeddings, audio frame length).
type GraniteNarEncoded = (ArrayD<f32>, ArrayD<f32>, ndarray::Array3<f32>, usize);

pub(in crate::winstt::stt::families) struct GraniteNarEngine {
    encoder: Session,
    embed_tokens: Session,
    editor: Session,
    tokenizer: tokenizers::Tokenizer,
    blank_token_id: i64,
    embedding_multiplier: f32,
    model_name: String,
    providers: Vec<String>,
}

impl GraniteNarEngine {
    pub(in crate::winstt::stt::families) fn load(
        cfg: &EngineConfig,
    ) -> SttResult<GraniteNarEngine> {
        let encoder = build_session(file(&cfg.resolved, "encoder")?, &cfg.providers)?;
        let embed_tokens = build_session(file(&cfg.resolved, "embed_tokens")?, &cfg.providers)?;
        let editor = build_session(file(&cfg.resolved, "editor")?, &cfg.providers)?;
        let tokenizer = load_granite_tokenizer(file(&cfg.resolved, "tokenizer")?)?;
        let blank_token_id = tokenizer
            .token_to_id("<|end_of_text|>")
            .map(i64::from)
            .unwrap_or(100257);

        Ok(GraniteNarEngine {
            encoder,
            embed_tokens,
            editor,
            tokenizer,
            blank_token_id,
            embedding_multiplier: 12.0,
            model_name: cfg.model_name.clone(),
            providers: providers_to_strings(&cfg.providers),
        })
    }

    fn encode_audio(&mut self, audio: &[f32]) -> SttResult<GraniteNarEncoded> {
        let features = frontend::granite_nar_features(audio);
        let t = features.nrows();
        if t == 0 {
            return Ok((
                ArrayD::<f32>::zeros(ndarray::IxDyn(&[1, 0, 0])),
                ArrayD::<f32>::zeros(ndarray::IxDyn(&[1, 0])),
                ndarray::Array3::<f32>::zeros((1, 0, 2048)),
                0,
            ));
        }
        let x = features
            .into_shape_with_order((1, t, 160))
            .map_err(|e| SttError::Inference(format!("granite nar feature reshape: {e}")))?;
        let outputs = self
            .encoder
            .run(ort::inputs![
                "input_features" => Tensor::from_array(x)
                    .map_err(|e| SttError::Inference(format!("granite nar feature tensor: {e}")))?,
                "attention_mask" => tensor_i64((1, t), vec![1; t])?
            ])
            .map_err(|e| SttError::Inference(format!("granite nar encoder run: {e}")))?;
        let bpe_logits = out_to_f32(&outputs["bpe_logits_dense"])?;
        let bpe_mask = out_to_mask_f32(&outputs["bpe_mask"])?;
        let mut audio_embeds = out_to_f32(&outputs["audio_embeds"])?
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("granite nar audio embeds dim: {e}")))?;
        if self.embedding_multiplier != 0.0 {
            audio_embeds.mapv_inplace(|v| v / self.embedding_multiplier);
        }
        let audio_lengths = out_to_i64(&outputs["audio_lengths"])?
            .into_dimensionality::<ndarray::Ix1>()
            .map_err(|e| SttError::Inference(format!("granite nar audio lengths dim: {e}")))?;
        let audio_len = audio_lengths
            .get(0)
            .copied()
            .unwrap_or(audio_embeds.shape()[1] as i64)
            .max(0) as usize;
        let audio_len = audio_len.min(audio_embeds.shape()[1]);
        Ok((bpe_logits, bpe_mask, audio_embeds, audio_len))
    }

    fn ctc_draft(&self, logits: &ArrayD<f32>, mask: &ArrayD<f32>) -> SttResult<Vec<i64>> {
        let logits = logits
            .view()
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("granite nar bpe logits dim: {e}")))?;
        let mask = mask
            .view()
            .into_dimensionality::<ndarray::Ix2>()
            .map_err(|e| SttError::Inference(format!("granite nar bpe mask dim: {e}")))?;
        let mut ids = Vec::new();
        for t in 0..logits.shape()[1] {
            if mask[[0, t]] <= 0.0 {
                continue;
            }
            let row = logits
                .index_axis(Axis(0), 0)
                .index_axis(Axis(0), t)
                .to_vec();
            ids.push(argmax_1d(&row).0 as i64);
        }
        Ok(ctc_greedy_collapse(&ids, self.blank_token_id))
    }

    fn add_insertion_slots(&self, ids: &[i64]) -> Vec<i64> {
        let out_len = (2 * ids.len() + 1).max(8);
        let mut out = vec![self.blank_token_id; out_len];
        for (i, &id) in ids.iter().enumerate() {
            out[2 * i + 1] = id;
        }
        out
    }

    fn run_editor(
        &mut self,
        slot_ids: &[i64],
        audio_embeds: &ndarray::Array3<f32>,
        audio_len: usize,
    ) -> SttResult<Vec<i64>> {
        let text_embeds = run_embed_tokens(&mut self.embed_tokens, slot_ids, "granite nar")?;
        let hidden = text_embeds.shape()[2];
        let text_len = slot_ids.len();
        let total_len = audio_len + text_len;
        let mut flat = Vec::with_capacity(total_len * hidden);
        for t in 0..audio_len {
            for h in 0..hidden {
                flat.push(audio_embeds[[0, t, h]]);
            }
        }
        for t in 0..text_len {
            for h in 0..hidden {
                flat.push(text_embeds[[0, t, h]]);
            }
        }
        let inputs_embeds = ndarray::Array3::from_shape_vec((1, total_len, hidden), flat)
            .map_err(|e| SttError::Inference(format!("granite nar flat embeds shape: {e}")))?;
        let outputs = self
            .editor
            .run(ort::inputs![
                "inputs_embeds" => Tensor::from_array(inputs_embeds)
                    .map_err(|e| SttError::Inference(format!("granite nar editor embeds tensor: {e}")))?,
                "position_ids" => tensor_i64((1, total_len), (0..total_len as i64).collect())?,
                "attention_mask" => Tensor::from_array(ndarray::Array4::<f32>::zeros((1, 1, total_len, total_len)))
                    .map_err(|e| SttError::Inference(format!("granite nar editor mask tensor: {e}")))?
            ])
            .map_err(|e| SttError::Inference(format!("granite nar editor run: {e}")))?;
        let logits = out_to_f32(&outputs["logits"])?
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("granite nar editor logits dim: {e}")))?;
        let mut ids = Vec::with_capacity(text_len);
        for t in audio_len..total_len {
            let row = logits
                .index_axis(Axis(0), 0)
                .index_axis(Axis(0), t)
                .to_vec();
            ids.push(argmax_1d(&row).0 as i64);
        }
        Ok(ctc_greedy_collapse(&ids, self.blank_token_id))
    }

    fn decode_text(&self, ids: &[i64]) -> SttResult<String> {
        granite_decode_tokens(&self.tokenizer, ids)
    }
}

impl Transcriber for GraniteNarEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::GraniteSpeechNar
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

    fn transcribe(&mut self, audio: &[f32], _opts: &TranscribeOptions) -> SttResult<Transcription> {
        if audio.is_empty() {
            return Ok(Transcription::default());
        }
        let (bpe_logits, bpe_mask, audio_embeds, audio_len) = self.encode_audio(audio)?;
        if audio_len == 0 {
            return Ok(Transcription::default());
        }
        let draft = self.ctc_draft(&bpe_logits, &bpe_mask)?;
        let slots = self.add_insertion_slots(&draft);
        let final_ids = self.run_editor(&slots, &audio_embeds, audio_len)?;
        let text = self.decode_text(&final_ids)?;
        Ok(Transcription {
            text,
            ..Default::default()
        })
    }
}
