// Audio8-ASR engine (`arkasr`: Qwen3-ASR audio tower + MLP adapter → 8-layer Qwen-style causal LM).
//
// Source: Audio8/Audio8-ASR-0.1B-onnx-runtime — `asr_onnx_runtime.py::OnnxCacheAsrEngine`
// (the bundle's own reference runtime) + `model_bundle/metadata.json`.
//
// Pipeline:
//   1. 128-mel log-spectrogram over a fixed 3000-frame (30 s) window, with every frame past the
//      real audio ZEROED — the reference extracts features over the unpadded clip and then
//      `np.pad`s the feature matrix with constant 0, which is NOT the log-mel silence floor our
//      `MelExtractor` would leave behind if we let it pad the waveform instead.
//   2. `audio_hidden{,_int8}.onnx`(audios `[1,128,3000]`, audio_feature_lengths `[1]`)
//      → `audio_hidden [390, 1024]` + `audio_valid_mask [390]`. The valid rows are resampled by
//      adaptive average pooling to the prompt's audio-token count (the tower emits a fixed 390-slot
//      grid; the prompt wants `⌊(⌊samples/160⌋+1)/2/4⌋` tokens) and pushed through the MLP adapter
//      (LayerNorm → Linear 1024→512), whose weights live OUTSIDE ONNX in `audio_projector.npz`.
//   3. Prompt: `<|user|><|begin_of_audio|>` + N×`<|audio|>` + `<|end_of_audio|>` +
//      "Please transcribe this audio." + `<|assistant|>`. Token embeddings are looked up host-side
//      from `token_embedding.npy` and the audio placeholders are overwritten with the adapter's
//      output — the LM graphs take `inputs_embeds`, never ids.
//   4. `lm_cache_prefill`(inputs_embeds `[1,L,512]`, cache_position `[L]`) → logits + per-layer
//      `key_delta_i`/`value_delta_i` covering positions `0..L`.
//   5. `lm_cache_decode`(inputs_embeds `[1,1,512]`, attention_mask `[1,512]`, cache_position `[1]`,
//      cache_key_i/cache_value_i `[1,8,512,64]`) → logits + one-position deltas.
//
// KV CACHE: this export is a torch STATIC cache — the decode graph consumes the FULL
// `[1, kv_heads, max_total_len, head_dim]` buffers as inputs and returns only the delta at
// `cache_position`, which the host writes back (`KvCaches::apply_delta`). Same shape as the
// Audio8 TTS engine's slow-AR cache (`tts/audio8.rs`), and the reason this kind is CPU-pinned:
// there is no `present_* → past_*` device handoff to bind the way qwen3.rs does.
//
// The 512-position cache is shared by the prompt AND the transcript, which is what
// `EngineKind::max_chunk_seconds` (24 s for this kind) budgets against.

use std::borrow::Cow;
use std::collections::BTreeSet;
use std::io::Read;
use std::path::Path;

use ndarray::{Array1, Array2, Array3, Array4, ArrayD};
use ort::session::{Session, SessionInputValue};
use ort::value::Tensor;

use super::*;
use crate::winstt::stt::mel::{HOP_LENGTH, MelExtractor, N_FRAMES};

/// LayerNorm epsilon the reference `layer_norm()` helper hardcodes.
const LAYER_NORM_EPS: f32 = 1e-5;
/// Fallback prompt instruction when `metadata.json` carries no override. Verbatim from
/// `OnnxAsrEngine._build_prompt`.
const PROMPT_INSTRUCTION: &str = "Please transcribe this audio.";

// ───────────────────────────────────────────────────────────────────────────
// NumPy weight readers
// ───────────────────────────────────────────────────────────────────────────

/// Parsed `.npy` header: the element count per dimension and the byte offset the raw data starts at.
struct NpyHeader {
    shape: Vec<usize>,
    data_offset: usize,
}

/// Parse a `.npy` v1/v2 header, accepting ONLY little-endian float32 (`<f4`) C-order arrays — the
/// two weight files this bundle ships. Anything else is a bundle we don't understand, and guessing
/// would silently produce garbage embeddings, so it errors instead.
fn parse_npy_header(bytes: &[u8], what: &str) -> SttResult<NpyHeader> {
    let bad = |msg: &str| SttError::Resolve(format!("audio8 {what}: {msg}"));
    if bytes.len() < 10 || &bytes[..6] != b"\x93NUMPY" {
        return Err(bad("not a .npy file"));
    }
    // v1 stores the header length as u16, v2+ as u32; both follow the 2-byte version.
    let (header_len, dict_start) = if bytes[6] == 1 {
        (
            usize::from(u16::from_le_bytes([bytes[8], bytes[9]])),
            10usize,
        )
    } else {
        if bytes.len() < 12 {
            return Err(bad("truncated v2 header"));
        }
        (
            u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize,
            12usize,
        )
    };
    let dict_end = dict_start
        .checked_add(header_len)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| bad("header length past end of file"))?;
    let dict = std::str::from_utf8(&bytes[dict_start..dict_end])
        .map_err(|_| bad("non-utf8 header"))?
        .to_string();

    if !(dict.contains("'descr': '<f4'") || dict.contains("\"descr\": \"<f4\"")) {
        return Err(bad(&format!(
            "expected a little-endian f32 array, got {dict}"
        )));
    }
    if dict.contains("'fortran_order': True") {
        return Err(bad("fortran-order arrays are not supported"));
    }

    let shape_body = dict
        .split_once("'shape':")
        .or_else(|| dict.split_once("\"shape\":"))
        .and_then(|(_, rest)| rest.split_once('('))
        .and_then(|(_, rest)| rest.split_once(')'))
        .map(|(inner, _)| inner)
        .ok_or_else(|| bad("no shape in header"))?;
    let shape: Vec<usize> = shape_body
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<usize>().map_err(|_| bad("non-integer shape")))
        .collect::<SttResult<Vec<usize>>>()?;

    Ok(NpyHeader {
        shape,
        data_offset: dict_end,
    })
}

/// Read a whole little-endian f32 `.npy` from memory.
fn npy_f32(bytes: &[u8], what: &str) -> SttResult<(Vec<usize>, Vec<f32>)> {
    let header = parse_npy_header(bytes, what)?;
    let body = &bytes[header.data_offset..];
    let count: usize = header.shape.iter().product();
    if body.len() < count * 4 {
        return Err(SttError::Resolve(format!(
            "audio8 {what}: truncated data ({} bytes for {count} floats)",
            body.len()
        )));
    }
    let values = body[..count * 4]
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    Ok((header.shape, values))
}

/// Stream the `[vocab, hidden]` token-embedding table off disk as f16.
///
/// The bundle ships it as fp32 (≈311 MB for 151936×512). The checkpoint itself is bf16, so f16
/// storage is a precision *gain* over the original weights while halving resident memory — the same
/// trade `qwen3.rs` makes with its raw `embed_tokens.bin`. Read in chunks so the fp32 source is
/// never fully resident alongside the f16 copy.
fn read_embedding_table(path: &Path) -> SttResult<(usize, usize, Vec<F16>)> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| SttError::Resolve(format!("audio8 token_embedding open: {e}")))?;
    // 4 KiB comfortably covers a v1/v2 header (numpy pads it to a 64-byte boundary under 128 bytes
    // for these shapes) without reading the 311 MB body.
    let mut head = vec![0u8; 4096];
    let read = file
        .read(&mut head)
        .map_err(|e| SttError::Resolve(format!("audio8 token_embedding read: {e}")))?;
    head.truncate(read);
    let header = parse_npy_header(&head, "token_embedding")?;
    let [vocab, hidden] = header.shape[..] else {
        return Err(SttError::Resolve(format!(
            "audio8 token_embedding: expected a 2-D table, got {:?}",
            header.shape
        )));
    };

    use std::io::Seek;
    file.seek(std::io::SeekFrom::Start(header.data_offset as u64))
        .map_err(|e| SttError::Resolve(format!("audio8 token_embedding seek: {e}")))?;
    let mut reader = std::io::BufReader::with_capacity(1 << 20, file);
    let mut table = Vec::with_capacity(vocab * hidden);
    let mut chunk = vec![0u8; 1 << 20];
    let mut remaining = vocab * hidden * 4;
    while remaining > 0 {
        let want = remaining.min(chunk.len());
        reader
            .read_exact(&mut chunk[..want])
            .map_err(|e| SttError::Resolve(format!("audio8 token_embedding body: {e}")))?;
        table.extend(
            chunk[..want]
                .chunks_exact(4)
                .map(|c| F16::from_f32(f32::from_le_bytes([c[0], c[1], c[2], c[3]]))),
        );
        remaining -= want;
    }
    Ok((vocab, hidden, table))
}

/// The MLP adapter between the audio tower's 1024-d hidden states and the LM's 512-d embeddings.
struct Projector {
    norm_weight: Vec<f32>,
    norm_bias: Vec<f32>,
    /// `[out, in]` row-major, matching numpy's `x @ linear_weight.T`.
    linear_weight: Vec<f32>,
    linear_bias: Vec<f32>,
    in_dim: usize,
    out_dim: usize,
}

impl Projector {
    /// Load the four arrays out of `audio_projector.npz` (a zip of `<name>.npy` members).
    fn load(path: &Path) -> SttResult<Projector> {
        let file = std::fs::File::open(path)
            .map_err(|e| SttError::Resolve(format!("audio8 audio_projector open: {e}")))?;
        let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file))
            .map_err(|e| SttError::Resolve(format!("audio8 audio_projector zip: {e}")))?;

        let mut take = |name: &str| -> SttResult<(Vec<usize>, Vec<f32>)> {
            let mut member = zip
                .by_name(&format!("{name}.npy"))
                .map_err(|e| SttError::Resolve(format!("audio8 audio_projector {name}: {e}")))?;
            let mut bytes = Vec::new();
            member
                .read_to_end(&mut bytes)
                .map_err(|e| SttError::Resolve(format!("audio8 audio_projector {name}: {e}")))?;
            npy_f32(&bytes, name)
        };

        let (nw_shape, norm_weight) = take("norm_weight")?;
        let (_, norm_bias) = take("norm_bias")?;
        let (lw_shape, linear_weight) = take("linear_weight")?;
        let (_, linear_bias) = take("linear_bias")?;

        let in_dim = *nw_shape
            .first()
            .ok_or_else(|| SttError::Resolve("audio8 projector: scalar norm_weight".into()))?;
        let [out_dim, weight_in] = lw_shape[..] else {
            return Err(SttError::Resolve(format!(
                "audio8 projector: expected a 2-D linear_weight, got {lw_shape:?}"
            )));
        };
        if weight_in != in_dim
            || norm_bias.len() != in_dim
            || linear_bias.len() != out_dim
            || linear_weight.len() != out_dim * in_dim
        {
            return Err(SttError::Resolve(
                "audio8 projector: weight shapes disagree".into(),
            ));
        }

        Ok(Projector {
            norm_weight,
            norm_bias,
            linear_weight,
            linear_bias,
            in_dim,
            out_dim,
        })
    }

    /// LayerNorm over the last axis, then `x @ W.T + b`. `rows` is `[n, in_dim]` row-major;
    /// returns `[n, out_dim]` row-major.
    fn apply(&self, rows: &[f32], n: usize) -> SttResult<Vec<f32>> {
        if rows.len() != n * self.in_dim {
            return Err(SttError::Inference(format!(
                "audio8 projector: got {} values for {n}×{}",
                rows.len(),
                self.in_dim
            )));
        }
        let mut out = vec![0.0f32; n * self.out_dim];
        let mut normed = vec![0.0f32; self.in_dim];
        for i in 0..n {
            let row = &rows[i * self.in_dim..(i + 1) * self.in_dim];
            let mean = row.iter().sum::<f32>() / self.in_dim as f32;
            let var = row.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / self.in_dim as f32;
            let inv = 1.0 / (var + LAYER_NORM_EPS).sqrt();
            for k in 0..self.in_dim {
                normed[k] = (row[k] - mean) * inv * self.norm_weight[k] + self.norm_bias[k];
            }
            for o in 0..self.out_dim {
                let w = &self.linear_weight[o * self.in_dim..(o + 1) * self.in_dim];
                let mut acc = self.linear_bias[o];
                for k in 0..self.in_dim {
                    acc += normed[k] * w[k];
                }
                out[i * self.out_dim + o] = acc;
            }
        }
        Ok(out)
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Static KV cache
// ───────────────────────────────────────────────────────────────────────────

/// Host-side static KV cache: one `[1, kv_heads, max_total_len, head_dim]` f32 buffer per key/value
/// per layer in `[k0, v0, k1, v1, …]` order — the order the graphs emit their deltas in, so the
/// writeback is a straight `zip`. Mirrors `tts/audio8.rs::KvCaches` (same torch-static-cache export
/// family), in f32 here because these graphs declare f32 cache tensors.
struct KvCaches {
    buffers: Vec<Array4<f32>>,
    max_total_len: usize,
}

impl KvCaches {
    fn new(layers: usize, kv_heads: usize, max_total_len: usize, head_dim: usize) -> Self {
        Self {
            buffers: (0..2 * layers)
                .map(|_| Array4::<f32>::zeros((1, kv_heads, max_total_len, head_dim)))
                .collect(),
            max_total_len,
        }
    }

    /// Write one graph delta `[1, kv_heads, P, head_dim]` back at `pos_start..pos_start + P`
    /// (positions are always one contiguous run: `0..L` for prefill, one slot per decode step).
    fn apply_delta(
        &mut self,
        index: usize,
        delta: &ArrayD<f32>,
        pos_start: usize,
    ) -> SttResult<()> {
        let buffer = self
            .buffers
            .get_mut(index)
            .ok_or_else(|| SttError::Inference(format!("audio8 kv delta {index} out of range")))?;
        let dims = delta.shape();
        let want = buffer.shape().to_vec();
        if dims.len() != 4 || dims[1] != want[1] || dims[3] != want[3] {
            return Err(SttError::Inference(format!(
                "audio8 unexpected kv delta shape {dims:?} (cache {want:?})"
            )));
        }
        let p = dims[2];
        if pos_start + p > self.max_total_len {
            return Err(SttError::Inference(format!(
                "audio8 kv delta writes past the cache: {pos_start}+{p} > {}",
                self.max_total_len
            )));
        }
        let delta4 = delta
            .view()
            .into_dimensionality::<ndarray::Ix4>()
            .map_err(|e| SttError::Inference(format!("audio8 kv delta ix4: {e}")))?;
        buffer
            .slice_mut(ndarray::s![.., .., pos_start..pos_start + p, ..])
            .assign(&delta4);
        Ok(())
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Prompt scaffold + bundle metadata
// ───────────────────────────────────────────────────────────────────────────

/// The prompt token ids either side of the `<|audio|>` placeholder run.
///
/// Encoding the two halves SEPARATELY (instead of building one giant string with N repeated
/// `<|audio|>` markers) is exact, not an approximation: `<|begin_of_audio|>` / `<|end_of_audio|>`
/// are ADDED tokens, and the tokenizer splits on added tokens before running BPE, so no merge can
/// ever cross those boundaries. It also keeps prompt construction O(N) instead of re-tokenizing an
/// ~8 KB string on every utterance.
struct PromptScaffold {
    prefix: Vec<i64>,
    suffix: Vec<i64>,
}

/// The slice of `model_bundle/metadata.json` this engine needs.
struct BundleMeta {
    audio_token_id: i64,
    pad_token_id: i64,
    eos_token_ids: Vec<i64>,
    /// Tokens the reference masks to `-inf` before every argmax (the chat-control markers — the
    /// model must never emit them as transcript text).
    blocked: Vec<i64>,
    /// Every id from `asr_block_token_id_from` upward is masked too, when non-negative.
    block_from: i64,
    merge_factor: usize,
    max_audio_seconds: usize,
    user_token: String,
    bos_audio_token: String,
    audio_token: String,
    eos_audio_token: String,
    assistant_token: String,
    response_prefix: String,
}

impl BundleMeta {
    fn load(path: &Path) -> SttResult<BundleMeta> {
        let raw = std::fs::read(path)
            .map_err(|e| SttError::Resolve(format!("audio8 metadata read: {e}")))?;
        let json: serde_json::Value = serde_json::from_slice(&raw)
            .map_err(|e| SttError::Resolve(format!("audio8 metadata parse: {e}")))?;
        let tokens = &json["tokens"];
        let text = |key: &str, default: &str| -> String {
            tokens[key]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(default)
                .to_string()
        };
        let ids = |key: &str| -> Vec<i64> {
            tokens[key]
                .as_array()
                .map(|a| a.iter().filter_map(serde_json::Value::as_i64).collect())
                .unwrap_or_default()
        };
        let eos_token_ids = {
            let v = ids("eos_token_ids");
            if v.is_empty() { vec![151645] } else { v }
        };
        Ok(BundleMeta {
            audio_token_id: tokens["audio_token_id"].as_i64().unwrap_or(151646),
            pad_token_id: tokens["pad_token_id"].as_i64().unwrap_or(151643),
            eos_token_ids,
            blocked: ids("extra_block_token_ids"),
            block_from: tokens["asr_block_token_id_from"].as_i64().unwrap_or(-1),
            merge_factor: json["prompt_audio"]["merge_factor"]
                .as_u64()
                .filter(|v| *v > 0)
                .unwrap_or(4) as usize,
            max_audio_seconds: json["max_audio_seconds"].as_u64().unwrap_or(30) as usize,
            user_token: text("user_token", "<|user|>"),
            bos_audio_token: text("bos_audio_token", "<|begin_of_audio|>"),
            audio_token: text("audio_token", "<|audio|>"),
            eos_audio_token: text("eos_audio_token", "<|end_of_audio|>"),
            assistant_token: text("assistant_token", "<|assistant|>"),
            response_prefix: json["response_prefix"].as_str().unwrap_or("").to_string(),
        })
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Engine
// ───────────────────────────────────────────────────────────────────────────

pub(in crate::winstt::stt::families) struct Audio8AsrEngine {
    audio_tower: Session,
    lm_prefill: Session,
    lm_decode: Session,
    tokenizer: tokenizers::Tokenizer,
    /// `[vocab, hidden]` token embeddings, f16 (see `read_embedding_table`).
    embed: Vec<F16>,
    vocab: usize,
    hidden: usize,
    projector: Projector,
    prompt: PromptScaffold,
    pad_token_id: i64,
    eos: Vec<i64>,
    /// Sorted, de-duplicated block list applied to every logit row before the argmax.
    blocked: Vec<i64>,
    block_from: i64,
    merge_factor: usize,
    max_audio_samples: usize,
    /// Mel bins + frame count the tower's `audios` input declares (128 × 3000 for this bundle).
    mel_bins: usize,
    tower_frames: usize,
    /// Static-cache geometry read off `lm_cache_decode`'s `cache_key_0` input.
    layers: usize,
    kv_heads: usize,
    head_dim: usize,
    max_total_len: usize,
    tower_inputs: (String, String),
    tower_outputs: (String, String),
    model_name: String,
    providers: Vec<String>,
}

impl Audio8AsrEngine {
    pub(in crate::winstt::stt::families) fn load(cfg: &EngineConfig) -> SttResult<Audio8AsrEngine> {
        let audio_tower = build_session(file(&cfg.resolved, "audio_tower")?, &cfg.providers)?;
        let lm_prefill = build_session(file(&cfg.resolved, "lm_prefill")?, &cfg.providers)?;
        let lm_decode = build_session(file(&cfg.resolved, "lm_decode")?, &cfg.providers)?;
        let tokenizer = tokenizers::Tokenizer::from_file(file(&cfg.resolved, "tokenizer")?)
            .map_err(|e| SttError::Tokenizer(format!("audio8 tokenizer: {e}")))?;
        let meta = BundleMeta::load(file(&cfg.resolved, "bundle_metadata")?)?;
        let projector = Projector::load(file(&cfg.resolved, "audio_projector")?)?;
        let (vocab, hidden, embed) = read_embedding_table(file(&cfg.resolved, "embed_tokens")?)?;

        if projector.out_dim != hidden {
            return Err(SttError::Resolve(format!(
                "audio8: projector emits {} dims but the embedding table is {hidden}-wide",
                projector.out_dim
            )));
        }

        let encode = |text: &str| -> SttResult<Vec<i64>> {
            Ok(tokenizer
                .encode(text, false)
                .map_err(|e| SttError::Tokenizer(format!("audio8 prompt encode {text:?}: {e}")))?
                .get_ids()
                .iter()
                .map(|&i| i64::from(i))
                .collect())
        };
        let prompt = PromptScaffold {
            prefix: encode(&format!("{}{}", meta.user_token, meta.bos_audio_token))?,
            suffix: encode(&format!(
                "{}{PROMPT_INSTRUCTION}{}{}",
                meta.eos_audio_token, meta.assistant_token, meta.response_prefix
            ))?,
        };
        // The placeholder MUST tokenize to exactly one id — the prompt reserves one position per
        // audio embedding, and a multi-piece marker would desynchronize the splice.
        let audio_token_id = match encode(&meta.audio_token)?[..] {
            [id] => id,
            _ => meta.audio_token_id,
        };

        // Static-cache geometry: authoritative from the graph, not from metadata.json. Every axis
        // is fully static in this export (`[1, 8, 512, 64]`), which is what makes the buffers
        // allocatable up front — a dynamic axis would come back as the `0` fallback here and must
        // be rejected rather than turned into an empty cache.
        let cache_shape = input_shape_or(&lm_decode, "cache_key_0", 0).ok_or_else(|| {
            SttError::Resolve("audio8 lm_cache_decode has no cache_key_0 input".into())
        })?;
        let [_, kv_heads, max_total_len, head_dim] = cache_shape[..] else {
            return Err(SttError::Resolve(format!(
                "audio8 lm_cache_decode: unexpected cache_key_0 rank {cache_shape:?}"
            )));
        };
        if kv_heads == 0 || max_total_len == 0 || head_dim == 0 {
            return Err(SttError::Resolve(format!(
                "audio8 lm_cache_decode: cache_key_0 has a dynamic axis {cache_shape:?}; this \
                 engine requires the static-cache export"
            )));
        }
        let layers = filter_sorted_inputs(&lm_decode, "cache_key_").len();
        if layers == 0 {
            return Err(SttError::Resolve(
                "audio8 lm_cache_decode exposes no cache_key_* inputs".into(),
            ));
        }

        let tower_in = node_input_names(&audio_tower);
        let tower_out = node_output_names(&audio_tower);
        let audios = tower_in
            .first()
            .cloned()
            .unwrap_or_else(|| "audios".to_string());
        let feature_lengths = tower_in
            .get(1)
            .cloned()
            .unwrap_or_else(|| "audio_feature_lengths".to_string());
        let hidden_out = tower_out
            .first()
            .cloned()
            .unwrap_or_else(|| "audio_hidden".to_string());
        let mask_out = tower_out
            .get(1)
            .cloned()
            .unwrap_or_else(|| "audio_valid_mask".to_string());
        let mel_bins = static_input_dim(&audio_tower, &audios, 1).unwrap_or(128);
        let tower_frames = static_input_dim(&audio_tower, &audios, 2).unwrap_or(N_FRAMES);

        let mut blocked: BTreeSet<i64> = meta.blocked.into_iter().collect();
        // The placeholder is a prompt-only marker; the reference blocks it too.
        blocked.insert(audio_token_id);

        Ok(Audio8AsrEngine {
            audio_tower,
            lm_prefill,
            lm_decode,
            tokenizer,
            embed,
            vocab,
            hidden,
            projector,
            prompt,
            pad_token_id: meta.pad_token_id,
            eos: meta.eos_token_ids,
            blocked: blocked.into_iter().collect(),
            block_from: meta.block_from,
            merge_factor: meta.merge_factor,
            max_audio_samples: meta.max_audio_seconds * 16_000,
            mel_bins,
            tower_frames,
            layers,
            kv_heads,
            head_dim,
            max_total_len,
            tower_inputs: (audios, feature_lengths),
            tower_outputs: (hidden_out, mask_out),
            model_name: cfg.model_name.clone(),
            providers: providers_to_strings(&cfg.providers),
        })
    }

    /// 128-mel features `[1, mel_bins, tower_frames]` with everything past the real audio zeroed,
    /// plus the `audio_feature_lengths` value. See the module header for why the zeroing matters.
    fn features(&self, audio: &[f32]) -> SttResult<(Array3<f32>, i64)> {
        let mel = MelExtractor::new(self.mel_bins);
        let (mut feats, n_mels, n_frames) = mel.extract_frames(audio, self.tower_frames);
        let valid = (audio.len() / HOP_LENGTH).clamp(1, n_frames);
        for row in 0..n_mels {
            let base = row * n_frames;
            feats[base + valid..base + n_frames].fill(0.0);
        }
        let arr = Array3::from_shape_vec((1, n_mels, n_frames), feats)
            .map_err(|e| SttError::Inference(format!("audio8 mel reshape: {e}")))?;
        Ok((arr, valid as i64))
    }

    /// Number of `<|audio|>` placeholders the prompt carries for `samples` of audio.
    fn audio_token_count(&self, samples: usize) -> usize {
        ark_audio_token_count(samples, self.merge_factor)
    }

    /// Run the audio tower and push its valid rows through the MLP adapter, returning the
    /// `[tokens, hidden]` audio embeddings the prompt splices in.
    fn audio_embeddings(&mut self, audio: &[f32], tokens: usize) -> SttResult<Vec<f32>> {
        let (feats, feature_len) = self.features(audio)?;
        let (audios, lengths) = self.tower_inputs.clone();
        let outputs = {
            let inputs: Vec<(Cow<'_, str>, SessionInputValue<'_>)> = vec![
                (
                    Cow::Owned(audios),
                    Tensor::from_array(feats)
                        .map(SessionInputValue::from)
                        .map_err(|e| SttError::Inference(format!("audio8 mel tensor: {e}")))?,
                ),
                (
                    Cow::Owned(lengths),
                    Tensor::from_array(Array1::from_vec(vec![feature_len]))
                        .map(SessionInputValue::from)
                        .map_err(|e| SttError::Inference(format!("audio8 lengths tensor: {e}")))?,
                ),
            ];
            self.audio_tower
                .run(inputs)
                .map_err(|e| SttError::Inference(format!("audio8 audio tower: {e}")))?
        };

        let hidden = out_to_f32(outputs.get(self.tower_outputs.0.as_str()).ok_or_else(|| {
            SttError::Inference(format!(
                "audio8 audio tower produced no {}",
                self.tower_outputs.0
            ))
        })?)?;
        // The mask is declared INT64 in this export; `out_to_mask_f32` also covers the bool/i32/f32
        // spellings a re-export could use.
        let mask =
            out_to_mask_f32(outputs.get(self.tower_outputs.1.as_str()).ok_or_else(|| {
                SttError::Inference(format!(
                    "audio8 audio tower produced no {}",
                    self.tower_outputs.1
                ))
            })?)?;

        let dim = *hidden
            .shape()
            .last()
            .ok_or_else(|| SttError::Inference("audio8 scalar audio_hidden".into()))?;
        if dim != self.projector.in_dim {
            return Err(SttError::Inference(format!(
                "audio8 audio tower emits {dim} dims, projector expects {}",
                self.projector.in_dim
            )));
        }
        let flat = hidden
            .as_slice()
            .ok_or_else(|| SttError::Inference("audio8 audio_hidden not contiguous".into()))?;
        let slots = flat.len() / dim;

        // Keep the rows the tower marks valid (the graph emits a fixed 390-slot grid).
        let mut valid: Vec<f32> = Vec::with_capacity(slots * dim);
        let mut valid_rows = 0usize;
        for (row, keep) in mask.iter().take(slots).enumerate() {
            if *keep != 0.0 {
                valid.extend_from_slice(&flat[row * dim..(row + 1) * dim]);
                valid_rows += 1;
            }
        }
        if valid_rows == 0 {
            return Err(SttError::Inference(
                "audio8 audio tower marked every frame invalid".into(),
            ));
        }

        let pooled = if valid_rows == tokens {
            valid
        } else {
            adaptive_avg_pool_rows(&valid, valid_rows, dim, tokens)
        };
        self.projector.apply(&pooled, tokens)
    }

    /// One `[hidden]` embedding row, promoted from the f16 table.
    fn embed_row(&self, token: i64) -> SttResult<&[F16]> {
        let index = usize::try_from(token)
            .ok()
            .filter(|i| *i < self.vocab)
            .ok_or_else(|| SttError::Inference(format!("audio8 token id out of range: {token}")))?;
        Ok(&self.embed[index * self.hidden..(index + 1) * self.hidden])
    }

    /// Build the prompt ids and their `[1, L, hidden]` embeddings, with the `<|audio|>` positions
    /// overwritten by `audio` (`[tokens, hidden]` row-major).
    fn prompt_embeddings(&self, audio: &[f32], tokens: usize) -> SttResult<(usize, Array3<f32>)> {
        let len = self.prompt.prefix.len() + tokens + self.prompt.suffix.len();
        let mut embeds = Vec::with_capacity(len * self.hidden);
        for &id in &self.prompt.prefix {
            embeds.extend(self.embed_row(id)?.iter().map(|h| h.to_f32()));
        }
        embeds.extend_from_slice(&audio[..tokens * self.hidden]);
        for &id in &self.prompt.suffix {
            embeds.extend(self.embed_row(id)?.iter().map(|h| h.to_f32()));
        }
        let arr = Array3::from_shape_vec((1, len, self.hidden), embeds)
            .map_err(|e| SttError::Inference(format!("audio8 prompt embeds: {e}")))?;
        Ok((len, arr))
    }

    /// Prefill the whole prompt: returns the last position's logits and fills `caches[0..len]`.
    fn prefill(&mut self, embeds: Array3<f32>, caches: &mut KvCaches) -> SttResult<Vec<f32>> {
        let len = embeds.shape()[1];
        let outputs = {
            let inputs: Vec<(Cow<'_, str>, SessionInputValue<'_>)> = vec![
                (
                    Cow::Borrowed("inputs_embeds"),
                    Tensor::from_array(embeds)
                        .map(SessionInputValue::from)
                        .map_err(|e| SttError::Inference(format!("audio8 prefill embeds: {e}")))?,
                ),
                (
                    Cow::Borrowed("cache_position"),
                    Tensor::from_array(Array1::from_vec((0..len as i64).collect::<Vec<i64>>()))
                        .map(SessionInputValue::from)
                        .map_err(|e| {
                            SttError::Inference(format!("audio8 prefill positions: {e}"))
                        })?,
                ),
            ];
            self.lm_prefill
                .run(inputs)
                .map_err(|e| SttError::Inference(format!("audio8 lm prefill: {e}")))?
        };
        let logits =
            last_step_row(&out_to_f32(outputs.get("logits").ok_or_else(|| {
                SttError::Inference("audio8 prefill produced no logits".into())
            })?)?)?;
        let deltas = collect_deltas(&outputs, self.layers)?;
        drop(outputs);
        for (i, delta) in deltas.iter().enumerate() {
            caches.apply_delta(i, delta, 0)?;
        }
        Ok(logits)
    }

    /// One decode step at `position` (0-based), with `position + 1` cache slots visible.
    fn decode_step(
        &mut self,
        token: i64,
        position: usize,
        caches: &mut KvCaches,
    ) -> SttResult<Vec<f32>> {
        let row: Vec<f32> = self.embed_row(token)?.iter().map(|h| h.to_f32()).collect();
        let embeds = Array3::from_shape_vec((1, 1, self.hidden), row)
            .map_err(|e| SttError::Inference(format!("audio8 step embeds: {e}")))?;
        let mut mask = Array2::<i64>::zeros((1, self.max_total_len));
        let valid = (position + 1).min(self.max_total_len);
        mask.slice_mut(ndarray::s![.., ..valid]).fill(1);

        let outputs = {
            let mut inputs: Vec<(Cow<'_, str>, SessionInputValue<'_>)> =
                Vec::with_capacity(3 + caches.buffers.len());
            inputs.push((
                Cow::Borrowed("inputs_embeds"),
                Tensor::from_array(embeds)
                    .map(SessionInputValue::from)
                    .map_err(|e| SttError::Inference(format!("audio8 step embeds tensor: {e}")))?,
            ));
            inputs.push((
                Cow::Borrowed("attention_mask"),
                Tensor::from_array(mask)
                    .map(SessionInputValue::from)
                    .map_err(|e| SttError::Inference(format!("audio8 step mask: {e}")))?,
            ));
            inputs.push((
                Cow::Borrowed("cache_position"),
                Tensor::from_array(Array1::from_vec(vec![position as i64]))
                    .map(SessionInputValue::from)
                    .map_err(|e| SttError::Inference(format!("audio8 step position: {e}")))?,
            ));
            for (i, buffer) in caches.buffers.iter().enumerate() {
                let name = if i % 2 == 0 {
                    format!("cache_key_{}", i / 2)
                } else {
                    format!("cache_value_{}", i / 2)
                };
                inputs.push((
                    Cow::Owned(name),
                    Tensor::from_array(buffer.clone())
                        .map(SessionInputValue::from)
                        .map_err(|e| SttError::Inference(format!("audio8 kv tensor: {e}")))?,
                ));
            }
            self.lm_decode
                .run(inputs)
                .map_err(|e| SttError::Inference(format!("audio8 lm decode: {e}")))?
        };

        let logits =
            last_step_row(&out_to_f32(outputs.get("logits").ok_or_else(|| {
                SttError::Inference("audio8 decode produced no logits".into())
            })?)?)?;
        let deltas = collect_deltas(&outputs, self.layers)?;
        drop(outputs);
        for (i, delta) in deltas.iter().enumerate() {
            caches.apply_delta(i, delta, position)?;
        }
        Ok(logits)
    }

    /// Mask the chat-control tokens the model must never emit as transcript text, then argmax.
    fn pick_token(&self, logits: &mut [f32]) -> i64 {
        if self.block_from >= 0 {
            let from = self.block_from as usize;
            if from < logits.len() {
                logits[from..].fill(f32::NEG_INFINITY);
            }
        }
        for &id in &self.blocked {
            if let Ok(index) = usize::try_from(id)
                && index < logits.len()
            {
                logits[index] = f32::NEG_INFINITY;
            }
        }
        argmax_1d(logits).0 as i64
    }

    fn decode_text(&self, ids: &[i64]) -> SttResult<String> {
        let ids32: Vec<u32> = ids.iter().filter_map(|&i| u32::try_from(i).ok()).collect();
        let raw = self
            .tokenizer
            .decode(&ids32, true)
            .map_err(|e| SttError::Tokenizer(format!("audio8 decode: {e}")))?;
        Ok(normalize_prediction_text(&raw))
    }
}

impl Transcriber for Audio8AsrEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::Audio8Asr
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
        let audio = &audio[..audio.len().min(self.max_audio_samples)];
        let tokens = self.audio_token_count(audio.len());

        let audio_embeds = self.audio_embeddings(audio, tokens)?;
        let (prompt_len, embeds) = self.prompt_embeddings(&audio_embeds, tokens)?;
        if prompt_len >= self.max_total_len {
            return Err(SttError::Inference(format!(
                "audio8 prompt is {prompt_len} positions, cache holds {} — the caller must \
                 segment to `max_chunk_seconds`",
                self.max_total_len
            )));
        }
        // Everything the prompt does not occupy is the transcript budget.
        let budget = self.max_total_len - prompt_len;

        let mut caches = KvCaches::new(
            self.layers,
            self.kv_heads,
            self.max_total_len,
            self.head_dim,
        );
        let mut logits = self.prefill(embeds, &mut caches)?;

        let mut generated: Vec<i64> = Vec::new();
        for step in 0..budget {
            let next = self.pick_token(&mut logits);
            if self.eos.contains(&next) || next == self.pad_token_id {
                break;
            }
            generated.push(next);
            // Phrase-loop guard shared with the other maskless AED decodes: keep one occurrence of
            // a verbatim-repeated cycle and stop.
            if let Some(keep) = phrase_loop_truncation(&generated) {
                generated.truncate(keep);
                break;
            }
            if step + 1 == budget {
                break;
            }
            logits = self.decode_step(next, prompt_len + step, &mut caches)?;
        }

        Ok(Transcription {
            text: self.decode_text(&generated)?,
            ..Default::default()
        })
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested below)
// ───────────────────────────────────────────────────────────────────────────

/// Pull `key_delta_i` / `value_delta_i` out of a graph run in `[k0, v0, k1, v1, …]` order — the
/// order `KvCaches::buffers` is laid out in, so the writeback is a straight `zip`.
///
/// A free function, not a method: `outputs` borrows the session mutably for its whole lifetime, so
/// an `&self` method here would conflict with the `&mut self` the `run` came from.
fn collect_deltas(
    outputs: &ort::session::SessionOutputs<'_>,
    layers: usize,
) -> SttResult<Vec<ArrayD<f32>>> {
    let mut deltas = Vec::with_capacity(2 * layers);
    for layer in 0..layers {
        for prefix in ["key_delta", "value_delta"] {
            let name = format!("{prefix}_{layer}");
            let value = outputs
                .get(name.as_str())
                .ok_or_else(|| SttError::Inference(format!("audio8 graph produced no {name}")))?;
            deltas.push(out_to_f32(value)?);
        }
    }
    Ok(deltas)
}

/// Number of `<|audio|>` placeholders a prompt carries for `samples` of 16 kHz audio.
///
/// Upstream `ArkasrProcessor.calculate_audio_token_count` (mel frames → 2× conv downsample →
/// `merge_factor` merge), shared verbatim by BOTH `arkasr` exports in the catalog — the Audio8-ASR
/// bundle and the ARK-ASR one — so the two engines must never drift on it.
pub(super) fn ark_audio_token_count(samples: usize, merge_factor: usize) -> usize {
    let frames = samples / HOP_LENGTH;
    (frames.div_ceil(2) / merge_factor.max(1)).max(1)
}

/// Resample `rows` (`[n, dim]` row-major) along the row axis to `out_rows` by averaging each
/// output row's source window — numpy's `adaptive_avg_pool` over the time axis, as the reference
/// uses to reconcile the tower's fixed slot grid with the prompt's audio-token count.
fn adaptive_avg_pool_rows(rows: &[f32], n: usize, dim: usize, out_rows: usize) -> Vec<f32> {
    if n == out_rows || n == 0 || out_rows == 0 {
        return rows.to_vec();
    }
    let mut out = vec![0.0f32; out_rows * dim];
    for o in 0..out_rows {
        let start = o * n / out_rows;
        let end = ((o + 1) * n).div_ceil(out_rows).max(start + 1).min(n);
        let span = (end - start) as f32;
        let target = &mut out[o * dim..(o + 1) * dim];
        for src in start..end {
            let row = &rows[src * dim..(src + 1) * dim];
            for (t, v) in target.iter_mut().zip(row) {
                *t += *v;
            }
        }
        for t in target.iter_mut() {
            *t /= span;
        }
    }
    out
}

/// Clean the raw generation the way the bundle's `normalize_prediction_text` does: cut at a turn
/// marker, drop any `<|text|>` / `<asr_text>` preamble and the `language <Lang>` prefix, strip
/// leftover `<|…|>` control markers, collapse whitespace, trim leading punctuation.
pub(super) fn normalize_prediction_text(text: &str) -> String {
    let mut cut = text.len();
    for marker in ["<|user|>", "<|assistant|>", "<|im_end|>"] {
        if let Some(index) = text.find(marker) {
            cut = cut.min(index);
        }
    }
    let mut body = text[..cut].trim().to_string();

    for marker in ["<|text|>", "<asr_text>"] {
        if let Some((_, rest)) = body.split_once(marker) {
            body = rest.to_string();
        }
    }
    body = strip_language_preamble(&body);
    body = strip_control_markers(&body);

    let collapsed = body.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .trim_start_matches([' ', ',', '.', ';', ':', '!', '?', '-'])
        .trim()
        .to_string()
}

/// The languages this checkpoint is trained on, as the auto-detect preamble spells them.
/// Deliberately a closed list — see `strip_language_preamble`.
const PREAMBLE_LANGUAGES: &[&str] = &[
    "english",
    "chinese",
    "mandarin",
    "cantonese",
    "french",
    "japanese",
    "german",
    "korean",
];

/// Drop a leading `language English ` auto-detect preamble.
///
/// DELIBERATELY NARROWER than the reference regex (`^\s*language\s+[A-Za-z]+\s+`), which matches
/// any word after "language" and so silently eats the first two words of a transcript that simply
/// opens with "language models are useful". This bundle sets `language_hint_enabled: false` and its
/// prompt carries no language slot, so the preamble is defensive cleanup for a shape this model is
/// not expected to emit at all — which makes mangling real speech the far worse failure. Requiring
/// one of the checkpoint's own language names keeps the cleanup and drops the collision.
fn strip_language_preamble(text: &str) -> String {
    let trimmed = text.trim_start();
    let Some(rest) = trimmed.strip_prefix("language") else {
        return text.to_string();
    };
    let after_keyword = rest.trim_start_matches([' ', '\t']);
    if after_keyword.len() == rest.len() {
        // No whitespace followed "language" — it is a longer word, not the keyword.
        return text.to_string();
    }
    let name_len = after_keyword
        .chars()
        .take_while(char::is_ascii_alphabetic)
        .map(char::len_utf8)
        .sum::<usize>();
    let name = &after_keyword[..name_len];
    if !PREAMBLE_LANGUAGES
        .iter()
        .any(|known| known.eq_ignore_ascii_case(name))
    {
        return text.to_string();
    }
    let tail = &after_keyword[name_len..];
    if tail.starts_with([' ', '\t']) {
        tail.trim_start().to_string()
    } else {
        text.to_string()
    }
}

/// Remove `<|…|>` control markers (never legitimate transcript text for this model).
fn strip_control_markers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find("<|") {
        let Some(close) = rest[open..].find("|>") else {
            break;
        };
        out.push_str(&rest[..open]);
        rest = &rest[open + close + 2..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npy_header_parses_v1_f32_c_order() {
        let mut bytes = Vec::new();
        let dict = b"{'descr': '<f4', 'fortran_order': False, 'shape': (2, 3), }";
        bytes.extend_from_slice(b"\x93NUMPY\x01\x00");
        bytes.extend_from_slice(&(dict.len() as u16).to_le_bytes());
        bytes.extend_from_slice(dict);
        let header = parse_npy_header(&bytes, "test").unwrap();
        assert_eq!(header.shape, vec![2, 3]);
        assert_eq!(header.data_offset, 10 + dict.len());
    }

    #[test]
    fn npy_header_rejects_non_f32_and_fortran_order() {
        let build = |dict: &[u8]| {
            let mut bytes = vec![];
            bytes.extend_from_slice(b"\x93NUMPY\x01\x00");
            bytes.extend_from_slice(&(dict.len() as u16).to_le_bytes());
            bytes.extend_from_slice(dict);
            bytes
        };
        let f16 = build(b"{'descr': '<f2', 'fortran_order': False, 'shape': (2,), }");
        assert!(parse_npy_header(&f16, "test").is_err());
        let fortran = build(b"{'descr': '<f4', 'fortran_order': True, 'shape': (2,), }");
        assert!(parse_npy_header(&fortran, "test").is_err());
        assert!(parse_npy_header(b"not-a-npy-file-at-all", "test").is_err());
    }

    #[test]
    fn npy_reads_values_after_the_header() {
        let dict = b"{'descr': '<f4', 'fortran_order': False, 'shape': (3,), }";
        let mut bytes = vec![];
        bytes.extend_from_slice(b"\x93NUMPY\x01\x00");
        bytes.extend_from_slice(&(dict.len() as u16).to_le_bytes());
        bytes.extend_from_slice(dict);
        for v in [1.0f32, -2.5, 3.25] {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        let (shape, values) = npy_f32(&bytes, "test").unwrap();
        assert_eq!(shape, vec![3]);
        assert_eq!(values, vec![1.0, -2.5, 3.25]);
    }

    #[test]
    fn projector_applies_layer_norm_then_affine() {
        // in_dim 2, out_dim 1: identity norm, linear [1, 1] with bias 0 → sum of the normed row.
        let projector = Projector {
            norm_weight: vec![1.0, 1.0],
            norm_bias: vec![0.0, 0.0],
            linear_weight: vec![1.0, 1.0],
            linear_bias: vec![0.0],
            in_dim: 2,
            out_dim: 1,
        };
        // LayerNorm of [a, b] is [-1, +1] (up to eps), so the sum is ~0 for every row.
        let out = projector.apply(&[1.0, 3.0, -5.0, 7.0], 2).unwrap();
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|v| v.abs() < 1e-3), "{out:?}");
    }

    #[test]
    fn projector_rejects_row_count_mismatch() {
        let projector = Projector {
            norm_weight: vec![1.0],
            norm_bias: vec![0.0],
            linear_weight: vec![1.0],
            linear_bias: vec![0.0],
            in_dim: 1,
            out_dim: 1,
        };
        assert!(projector.apply(&[1.0, 2.0], 3).is_err());
    }

    #[test]
    fn adaptive_pool_downsamples_by_window_average() {
        // 4 rows of dim 1 → 2 rows: [1,2] and [3,4] averaged.
        let out = adaptive_avg_pool_rows(&[1.0, 2.0, 3.0, 4.0], 4, 1, 2);
        assert_eq!(out, vec![1.5, 3.5]);
        // Identity when the counts already match.
        assert_eq!(adaptive_avg_pool_rows(&[1.0, 2.0], 2, 1, 2), vec![1.0, 2.0]);
    }

    #[test]
    fn adaptive_pool_upsamples_without_empty_windows() {
        // 2 rows → 3 rows: every output row must average at least one source row (no NaNs).
        let out = adaptive_avg_pool_rows(&[0.0, 4.0], 2, 1, 3);
        assert_eq!(out.len(), 3);
        assert!(out.iter().all(|v| v.is_finite()), "{out:?}");
    }

    #[test]
    fn kv_cache_writes_delta_at_position() {
        let mut caches = KvCaches::new(1, 2, 4, 3);
        let delta = ArrayD::from_elem(ndarray::IxDyn(&[1, 2, 1, 3]), 5.0f32);
        caches.apply_delta(0, &delta, 2).unwrap();
        assert_eq!(caches.buffers[0][[0, 0, 2, 0]], 5.0);
        assert_eq!(caches.buffers[0][[0, 0, 1, 0]], 0.0);
        // Writing past the cache is an error, not a silent truncation.
        assert!(caches.apply_delta(0, &delta, 4).is_err());
        // So is a delta whose head geometry disagrees with the cache.
        let wrong = ArrayD::from_elem(ndarray::IxDyn(&[1, 3, 1, 3]), 1.0f32);
        assert!(caches.apply_delta(0, &wrong, 0).is_err());
    }

    #[test]
    fn normalize_cuts_at_turn_markers_and_strips_controls() {
        assert_eq!(
            normalize_prediction_text("hello world<|im_end|>trailing junk"),
            "hello world"
        );
        assert_eq!(
            normalize_prediction_text("<|text|>the real transcript"),
            "the real transcript"
        );
        assert_eq!(
            normalize_prediction_text("language English hello there"),
            "hello there"
        );
        assert_eq!(
            normalize_prediction_text("  ,  spaced   out  text "),
            "spaced out text"
        );
        assert_eq!(normalize_prediction_text("a <|weird|> marker"), "a marker");
        assert_eq!(normalize_prediction_text(""), "");
    }

    #[test]
    fn normalize_strips_only_a_real_language_preamble() {
        // The preamble shape goes, in any casing…
        assert_eq!(normalize_prediction_text("language Cantonese 你好"), "你好");
        assert_eq!(
            normalize_prediction_text("language english hello there"),
            "hello there"
        );
        // …but "language" followed by anything that is not one of this checkpoint's language names
        // is ordinary speech and must survive intact. The upstream regex eats these.
        assert_eq!(
            normalize_prediction_text("language models are useful"),
            "language models are useful"
        );
        assert_eq!(
            normalize_prediction_text("language barriers are real"),
            "language barriers are real"
        );
        // Mid-sentence occurrences are never a preamble (the regex is anchored).
        assert_eq!(
            normalize_prediction_text("the language is ambiguous"),
            "the language is ambiguous"
        );
        assert_eq!(normalize_prediction_text("language"), "language");
        assert_eq!(
            normalize_prediction_text("languages evolve"),
            "languages evolve"
        );
    }
}
