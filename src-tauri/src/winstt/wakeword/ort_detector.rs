// ═════════════════════════════════════════════════════════════════════════════
// 5. The detector — native ORT keyword spotter (replaces the sherpa-onnx FFI).
//
//    Same `WakeWordDetector` surface as the sherpa detector it replaces
//    (`new(&WakeWordConfig)` / `detect(chunk) -> WakeWordResult` / `reset()`),
//    but the streaming zipformer2 transducer runs on the app's own ONNX Runtime,
//    so the build no longer links sherpa-onnx-c-api.dll (which carried a SECOND
//    onnxruntime.dll into every install just for wake-word).
//
//    Algorithm parity target: sherpa-onnx `keyword-spotter-transducer-impl.h` +
//    `transducer-keyword-decoder.cc` + `context-graph.cc` (see the port spec in
//    the session notes): modified beam search (max_active_paths=4) over per-frame
//    log_softmax(joiner logits), an Aho-Corasick keyword trie applying per-token
//    boosts with implicit rollback on fail transitions, and a fire check on the
//    best hypothesis (matched node + trailing blanks + mean acoustic posterior
//    >= per-keyword threshold). Feature front-end and chunk cursor reuse the
//    decode-validated zipformer fbank from `stt::families::frontend`.
// ═════════════════════════════════════════════════════════════════════════════

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::Path;

use ndarray::Array2;
use ort::session::Session;
use ort::value::DynValue;

use super::config::WakeWordConfig;
use super::{WakeWordResult, normalize_keyword_label, path_string};
use crate::winstt::stt::families::frontend::{
    KALDI_HOP, build_zipformer_mel_filterbank, compute_kaldi_fbank,
};

/// Blank token id — hardcoded 0 in sherpa's transducer keyword decoder.
const BLANK_ID: i64 = 0;
/// Beam width (sherpa `max_active_paths` default).
const MAX_ACTIVE_PATHS: usize = 4;
/// A keyword fires only when the best hyp has STRICTLY more trailing blank frames
/// than this (sherpa `num_trailing_blanks` default 1 ⇒ ≥ 2 blanks ≈ 80 ms).
const NUM_TRAILING_BLANKS: i32 = 1;
/// Full neural reset after this much trailing silence (sherpa `DecodeStreams`:
/// `num_trailing_blanks * 4 * 0.01 > 1.5`).
const AUTO_RESET_TRAILING_SILENCE_S: f32 = 1.5;
/// Feature frames of pre-context kept when trimming consumed PCM (mirrors
/// `stt::families::streaming::STREAM_FEATURE_PRE_CONTEXT_FRAMES`).
const PRE_CONTEXT_FRAMES: usize = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Context graph — keyword trie with Aho-Corasick fail/output links
// (port of sherpa-onnx context-graph.cc, arena-indexed instead of pointers).
// ─────────────────────────────────────────────────────────────────────────────

struct GraphNode {
    token: i64,
    /// Boost carried by this single arc (max over keywords sharing it).
    token_score: f32,
    /// Sum of token_scores from root.
    node_score: f32,
    /// `node_score` when `is_end`, plus the output link's output_score (BFS pass).
    output_score: f32,
    /// Depth = number of tokens from root.
    level: usize,
    /// Per-keyword acoustic threshold (end nodes only).
    ac_threshold: f32,
    is_end: bool,
    /// Keyword label (end nodes only).
    phrase: String,
    next: BTreeMap<i64, usize>,
    fail: usize,
    output: Option<usize>,
}

struct ContextGraph {
    nodes: Vec<GraphNode>,
}

const ROOT: usize = 0;

struct KeywordEntry {
    ids: Vec<i64>,
    boost: f32,
    threshold: f32,
    phrase: String,
}

impl ContextGraph {
    fn build(keywords: &[KeywordEntry], default_boost: f32, default_threshold: f32) -> Self {
        let mut nodes = vec![GraphNode {
            token: -1,
            token_score: 0.0,
            node_score: 0.0,
            output_score: 0.0,
            level: 0,
            ac_threshold: 0.0,
            is_end: false,
            phrase: String::new(),
            next: BTreeMap::new(),
            fail: ROOT,
            output: None,
        }];

        for kw in keywords {
            // sherpa: 0 means "use the global default".
            let score = if kw.boost == 0.0 {
                default_boost
            } else {
                kw.boost
            };
            let threshold = if kw.threshold == 0.0 {
                default_threshold
            } else {
                kw.threshold
            };
            let mut cur = ROOT;
            for (j, &tok) in kw.ids.iter().enumerate() {
                let is_end = j == kw.ids.len() - 1;
                if let Some(&existing) = nodes[cur].next.get(&tok) {
                    // Shared prefix: arc boost becomes the max; node_score follows the
                    // (possibly stale for grandchildren — sherpa parity) parent chain.
                    let parent_node_score = nodes[cur].node_score;
                    let node = &mut nodes[existing];
                    node.token_score = node.token_score.max(score);
                    node.node_score = parent_node_score + node.token_score;
                    node.is_end |= is_end;
                    node.output_score = if node.is_end { node.node_score } else { 0.0 };
                    if is_end {
                        node.phrase = kw.phrase.clone();
                        node.ac_threshold = threshold;
                    }
                    cur = existing;
                } else {
                    let parent_node_score = nodes[cur].node_score;
                    let idx = nodes.len();
                    nodes.push(GraphNode {
                        token: tok,
                        token_score: score,
                        node_score: parent_node_score + score,
                        output_score: if is_end {
                            parent_node_score + score
                        } else {
                            0.0
                        },
                        level: j + 1,
                        ac_threshold: if is_end { threshold } else { 0.0 },
                        is_end,
                        phrase: if is_end {
                            kw.phrase.clone()
                        } else {
                            String::new()
                        },
                        next: BTreeMap::new(),
                        fail: ROOT,
                        output: None,
                    });
                    nodes[cur].next.insert(tok, idx);
                    cur = idx;
                }
            }
        }

        // FillFailOutput — standard Aho-Corasick BFS.
        let mut queue: VecDeque<usize> = VecDeque::new();
        let root_children: Vec<usize> = nodes[ROOT].next.values().copied().collect();
        for c in root_children {
            nodes[c].fail = ROOT;
            queue.push_back(c);
        }
        while let Some(n) = queue.pop_front() {
            let children: Vec<(i64, usize)> = nodes[n].next.iter().map(|(&t, &c)| (t, c)).collect();
            for (tok, child) in children {
                let mut fail = nodes[n].fail;
                loop {
                    if let Some(&f) = nodes[fail].next.get(&tok) {
                        fail = f;
                        break;
                    }
                    if nodes[fail].token == -1 {
                        break; // root reached, no arc
                    }
                    fail = nodes[fail].fail;
                }
                nodes[child].fail = fail;
                // Output link: nearest end node up the fail chain.
                let mut output = fail;
                let output = loop {
                    if nodes[output].is_end {
                        break Some(output);
                    }
                    if nodes[output].token == -1 {
                        break None;
                    }
                    output = nodes[output].fail;
                };
                nodes[child].output = output;
                if let Some(o) = output {
                    nodes[child].output_score += nodes[o].output_score;
                }
                queue.push_back(child);
            }
        }

        ContextGraph { nodes }
    }

    /// (score_delta, new_state, matched_end_node) — sherpa `ForwardOneStep` (strict mode).
    fn forward_one_step(&self, state: usize, token: i64) -> (f32, usize) {
        let (node, score) = if let Some(&n) = self.nodes[state].next.get(&token) {
            (n, self.nodes[n].token_score)
        } else {
            let mut node = self.nodes[state].fail;
            loop {
                if self.nodes[node].next.contains_key(&token) {
                    break;
                }
                if self.nodes[node].token == -1 {
                    break;
                }
                node = self.nodes[node].fail;
            }
            if let Some(&n) = self.nodes[node].next.get(&token) {
                node = n;
            }
            // Fail transition: compensate the already-paid partial boost
            // (implicit rollback — can be negative).
            (
                node,
                self.nodes[node].node_score - self.nodes[state].node_score,
            )
        };
        (score + self.nodes[node].output_score, node)
    }

    /// sherpa `IsMatched`: the state itself if it is an end node, else its output link.
    fn matched_end(&self, state: usize) -> Option<usize> {
        if self.nodes[state].is_end {
            Some(state)
        } else {
            self.nodes[state].output
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Beam decoder (port of transducer-keyword-decoder.cc, batch = 1)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct Hypothesis {
    ys: Vec<i64>,
    timestamps: Vec<i32>,
    /// Per emitted token: acoustic posterior exp(log_softmax logit).
    ys_probs: Vec<f32>,
    log_prob: f64,
    context_state: usize,
    num_trailing_blanks: i32,
}

/// log(x) + log(y) in log space, double precision (sherpa `LogAdd`).
fn log_add(x: f64, y: f64) -> f64 {
    let (max, min) = if x >= y { (x, y) } else { (y, x) };
    let diff = min - max;
    if diff < (f64::EPSILON).ln() {
        max
    } else {
        max + diff.exp().ln_1p()
    }
}

fn log_softmax_inplace(row: &mut [f32]) {
    let max = row.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let mut sum = 0.0f32;
    for v in row.iter() {
        sum += (v - max).exp();
    }
    let log_sum = sum.ln() + max;
    for v in row.iter_mut() {
        *v -= log_sum;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyword content parsing (sherpa utils.cc EncodeBase: tokens + :boost #thr @label)
// ─────────────────────────────────────────────────────────────────────────────

fn load_symbol_table(tokens_path: &Path) -> anyhow::Result<HashMap<String, i64>> {
    let text = std::fs::read_to_string(tokens_path)
        .map_err(|e| anyhow::anyhow!("read tokens {}: {e}", tokens_path.display()))?;
    let mut map = HashMap::new();
    for line in text.lines() {
        let mut it = line.split_whitespace();
        if let (Some(sym), Some(id)) = (it.next(), it.next())
            && let Ok(id) = id.parse::<i64>()
        {
            map.insert(sym.to_string(), id);
        }
    }
    if map.is_empty() {
        anyhow::bail!("empty token table: {}", tokens_path.display());
    }
    Ok(map)
}

fn parse_keywords_content(
    content: &str,
    symbols: &HashMap<String, i64>,
) -> anyhow::Result<Vec<KeywordEntry>> {
    let mut out = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut entry = KeywordEntry {
            ids: Vec::new(),
            boost: 0.0,
            threshold: 0.0,
            phrase: String::new(),
        };
        for item in line.split_whitespace() {
            if let Some(&id) = symbols.get(item) {
                entry.ids.push(id);
            } else if let Some(rest) = item.strip_prefix(':') {
                entry.boost = rest.parse().unwrap_or(0.0);
            } else if let Some(rest) = item.strip_prefix('#') {
                entry.threshold = rest.parse().unwrap_or(0.0);
            } else if let Some(rest) = item.strip_prefix('@') {
                entry.phrase = rest.to_string();
            } else {
                anyhow::bail!("keyword token not in vocabulary: '{item}' (line: '{line}')");
            }
        }
        if !entry.ids.is_empty() {
            out.push(entry);
        }
    }
    if out.is_empty() {
        anyhow::bail!("no usable keywords in keyword content");
    }
    Ok(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// The detector
// ─────────────────────────────────────────────────────────────────────────────

pub struct WakeWordDetector {
    encoder: Session,
    decoder: Session,
    joiner: Session,
    /// Feature frames per encoder call (`T` metadata, 45).
    chunk_t: usize,
    /// Feature frames consumed per call (`decode_chunk_len` metadata, 32).
    chunk_shift: usize,
    context_size: usize,
    vocab_size: usize,
    unk_id: i64,
    /// Encoder state tensor names, graph order (inputs skip `x`; outputs skip `encoder_out`).
    state_in: Vec<String>,
    state_out: Vec<String>,
    /// Zero-init shapes (dynamic N → 1) + dtype, resolved once at load.
    state_shapes: Vec<Vec<usize>>,
    state_is_i64: Vec<bool>,
    /// Carried encoder states; `None` → seed zeros (fresh stream / after full reset).
    states: Vec<Option<DynValue>>,
    mel_fb: Array2<f32>,
    graph: ContextGraph,
    /// Live beam, keyed by `ys` (log-sum-exp merge on identical token histories).
    beam: Vec<Hypothesis>,
    /// Subsampled (40 ms) frames decoded since the last full reset.
    frame_offset: i32,
    /// decoder_out cache keyed by the decoder context tokens (bit-identical, saves
    /// most decoder runs at beam 4 — sherpa re-runs the decoder every frame).
    decoder_cache: HashMap<Vec<i64>, Vec<f32>>,
    /// PCM cursor (mirrors stt::families::streaming::StreamCursor, kaldi hop).
    pcm: Vec<f32>,
    base_frame: usize,
    next_chunk_frame: usize,
    /// Active phrase list (display words), label → index mapping.
    keywords: Vec<String>,
}

impl WakeWordDetector {
    pub fn new(config: &WakeWordConfig) -> anyhow::Result<Self> {
        let threads = config.num_threads.unwrap_or(1).max(1) as usize;
        let encoder = build_cpu_session(&config.model.encoder, threads)?;
        let decoder = build_cpu_session(&config.model.decoder, threads)?;
        let joiner = build_cpu_session(&config.model.joiner, threads)?;

        let meta = session_custom_meta(&encoder)?;
        let model_type = meta.get("model_type").cloned().unwrap_or_default();
        if model_type != "zipformer2" {
            anyhow::bail!("KWS model_type '{model_type}' unsupported (expected zipformer2)");
        }
        let chunk_t = meta_usize(&meta, "T")?;
        let chunk_shift = meta_usize(&meta, "decode_chunk_len")?;
        let dec_meta = session_custom_meta(&decoder)?;
        let context_size = dec_meta
            .get("context_size")
            .and_then(|s| s.parse().ok())
            .unwrap_or(2);
        let vocab_size = dec_meta
            .get("vocab_size")
            .and_then(|s| s.parse().ok())
            .unwrap_or(500);

        let in_names: Vec<String> = encoder
            .inputs()
            .iter()
            .map(|i| i.name().to_string())
            .collect();
        let out_names: Vec<String> = encoder
            .outputs()
            .iter()
            .map(|o| o.name().to_string())
            .collect();
        let state_in: Vec<String> = in_names.iter().skip(1).cloned().collect();
        let state_out: Vec<String> = out_names.iter().skip(1).cloned().collect();
        if state_in.len() != state_out.len() {
            anyhow::bail!(
                "KWS encoder state mismatch: {} inputs vs {} outputs",
                state_in.len(),
                state_out.len()
            );
        }
        let mut state_shapes = Vec::with_capacity(state_in.len());
        let mut state_is_i64 = Vec::with_capacity(state_in.len());
        for name in &state_in {
            let input = encoder
                .inputs()
                .iter()
                .find(|i| i.name() == name.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing KWS state input {name}"))?;
            let shape: Vec<usize> = input
                .dtype()
                .tensor_shape()
                .ok_or_else(|| anyhow::anyhow!("KWS state {name} is not a tensor"))?
                .iter()
                .map(|&d| if d > 0 { d as usize } else { 1 })
                .collect();
            let is_i64 = input
                .dtype()
                .tensor_type()
                .is_some_and(|t| matches!(t, ort::value::TensorElementType::Int64));
            state_shapes.push(shape);
            state_is_i64.push(is_i64);
        }
        let n_states = state_in.len();

        // Keyword set: inline content (preferred — carries per-keyword #threshold from
        // the sensitivity mapping) or the on-disk keywords file.
        let content = match config.keywords_inline() {
            Some(c) if !c.trim().is_empty() => c.to_string(),
            _ => match &config.keywords_file {
                Some(path) => std::fs::read_to_string(path)
                    .map_err(|e| anyhow::anyhow!("read keywords file: {e}"))?,
                None => anyhow::bail!("no keyword content configured"),
            },
        };
        let symbols = load_symbol_table(&config.model.tokens)?;
        let unk_id = symbols.get("<unk>").copied().unwrap_or(2);
        let entries = parse_keywords_content(&content, &symbols)?;
        let graph =
            ContextGraph::build(&entries, config.default_boost(), config.global_threshold());

        // The encoder/decoder/joiner paths must exist (parity with sherpa's create()).
        for p in [
            &config.model.encoder,
            &config.model.decoder,
            &config.model.joiner,
        ] {
            path_string(p)?;
        }

        let mut det = WakeWordDetector {
            encoder,
            decoder,
            joiner,
            chunk_t,
            chunk_shift,
            context_size,
            vocab_size,
            unk_id,
            state_in,
            state_out,
            state_shapes,
            state_is_i64,
            states: (0..n_states).map(|_| None).collect(),
            mel_fb: build_zipformer_mel_filterbank(),
            graph,
            beam: Vec::new(),
            frame_offset: 0,
            decoder_cache: HashMap::new(),
            pcm: Vec::new(),
            base_frame: 0,
            next_chunk_frame: 0,
            keywords: config.keywords.clone(),
        };
        det.reset_beam();
        Ok(det)
    }

    /// Sentinel-context beam: one blank hypothesis `ys = [-1, 0]` at the graph root.
    fn reset_beam(&mut self) {
        let mut blanks = vec![-1i64; self.context_size];
        *blanks.last_mut().expect("context_size >= 1") = BLANK_ID;
        self.beam = vec![Hypothesis {
            ys: blanks,
            timestamps: Vec::new(),
            ys_probs: Vec::new(),
            log_prob: 0.0,
            context_state: ROOT,
            num_trailing_blanks: 0,
        }];
    }

    /// Full neural reset: fresh zero encoder states + sentinel beam + frame offset.
    /// The PCM cursor position is NOT touched (sherpa `Reset` parity).
    fn full_reset(&mut self) {
        for s in &mut self.states {
            *s = None;
        }
        self.reset_beam();
        self.frame_offset = 0;
    }

    /// Feed one 16 kHz mono f32 chunk; report any detection (at most one per call).
    pub fn detect(&mut self, chunk: &[f32]) -> WakeWordResult {
        if chunk.is_empty() {
            return WakeWordResult::none();
        }
        self.pcm.extend_from_slice(chunk);

        let mut hit = WakeWordResult::none();
        loop {
            let features = compute_kaldi_fbank(&self.pcm, &self.mel_fb);
            let rel_start = self.next_chunk_frame.saturating_sub(self.base_frame);
            // sherpa IsReady: processed + T < frames_ready (strict — the tail frames of
            // a symmetric-pad fbank change as more audio arrives, so never decode them).
            if rel_start + self.chunk_t >= features.nrows() {
                break;
            }
            let window = features
                .slice(ndarray::s![rel_start..rel_start + self.chunk_t, ..])
                .to_owned();
            self.next_chunk_frame += self.chunk_shift;
            self.trim_pcm();

            match self.decode_chunk(&window) {
                Ok(Some(word_label)) => {
                    let idx = self.index_of(&word_label);
                    let word = self.display_word_for_label(&word_label, idx);
                    // Re-arm exactly like the sherpa detector did on a hit: full reset.
                    self.full_reset();
                    hit = WakeWordResult::hit(idx, word);
                }
                Ok(None) => {}
                Err(err) => {
                    log::warn!("[wakeword] ort kws decode failed: {err}");
                    self.full_reset();
                    return WakeWordResult::none();
                }
            }

            // Silence auto-reset (sherpa DecodeStreams): > 1.5 s of trailing blanks
            // → fresh neural state, so long non-speech stretches can't degrade detection.
            if let Some(best) = self.best_hyp_index() {
                let trailing_s = self.beam[best].num_trailing_blanks as f32 * 4.0 * 0.01;
                if trailing_s > AUTO_RESET_TRAILING_SILENCE_S {
                    self.full_reset();
                }
            }
        }
        hit
    }

    /// Reset the streaming state (drop any partial decode). Fail-soft.
    pub fn reset(&mut self) {
        self.full_reset();
    }

    /// Drop consumed PCM, keeping `PRE_CONTEXT_FRAMES` of feature pre-context
    /// (mirrors `StreamCursor::trim_pcm` with the kaldi hop).
    fn trim_pcm(&mut self) {
        let keep_from_frame = self.next_chunk_frame.saturating_sub(PRE_CONTEXT_FRAMES);
        if keep_from_frame <= self.base_frame {
            return;
        }
        let drop_frames = keep_from_frame - self.base_frame;
        let drop_samples = (drop_frames * KALDI_HOP).min(self.pcm.len());
        if drop_samples == 0 {
            return;
        }
        self.pcm.drain(..drop_samples);
        self.base_frame += drop_samples / KALDI_HOP;
    }

    fn best_hyp_index(&self) -> Option<usize> {
        self.beam
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.log_prob.total_cmp(&b.log_prob))
            .map(|(i, _)| i)
    }

    /// Run one 45-frame feature window through the encoder and the keyword beam
    /// decoder. Returns the fired keyword label (or synthesized phrase), if any.
    fn decode_chunk(&mut self, window: &Array2<f32>) -> anyhow::Result<Option<String>> {
        let encoder_out = self.run_encoder(window)?;
        let num_frames = encoder_out.nrows();
        let mut fired: Option<String> = None;

        for t in 0..num_frames {
            let enc_frame: Vec<f32> = encoder_out.row(t).to_vec();

            // Per-hyp joint logits → log_softmax → combined score rows.
            let mut logprob_rows: Vec<Vec<f32>> = Vec::with_capacity(self.beam.len());
            for hyp in &self.beam {
                let ctx: Vec<i64> = hyp.ys[hyp.ys.len() - self.context_size..].to_vec();
                let dec_out = match self.decoder_cache.get(&ctx) {
                    Some(v) => v.clone(),
                    None => {
                        let v = run_decoder(&mut self.decoder, self.context_size, &hyp.ys)?;
                        self.decoder_cache.insert(ctx, v.clone());
                        v
                    }
                };
                let mut logits = run_joiner(&mut self.joiner, &enc_frame, &dec_out)?;
                if logits.len() != self.vocab_size {
                    anyhow::bail!(
                        "joiner produced {} logits (vocab {})",
                        logits.len(),
                        self.vocab_size
                    );
                }
                log_softmax_inplace(&mut logits);
                logprob_rows.push(logits);
            }

            // Top-k over (hyp × vocab) combined scores (acoustic + accumulated path).
            let mut flat: Vec<(usize, f64)> = Vec::with_capacity(self.beam.len() * self.vocab_size);
            for (h, row) in logprob_rows.iter().enumerate() {
                let base = self.beam[h].log_prob;
                for (v, &lp) in row.iter().enumerate() {
                    flat.push((h * self.vocab_size + v, base + lp as f64));
                }
            }
            let k = MAX_ACTIVE_PATHS.min(flat.len());
            flat.select_nth_unstable_by(k - 1, |a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
            flat.truncate(k);

            // Expand into the next beam (log-sum-exp merge on identical ys).
            let mut next: HashMap<Vec<i64>, Hypothesis> = HashMap::with_capacity(k);
            for &(flat_idx, combined) in &flat {
                let h = flat_idx / self.vocab_size;
                let new_token = (flat_idx % self.vocab_size) as i64;
                let mut hyp = self.beam[h].clone();
                let mut context_score = 0.0f32;
                if new_token != BLANK_ID && new_token != self.unk_id {
                    hyp.ys.push(new_token);
                    hyp.timestamps.push(t as i32 + self.frame_offset);
                    hyp.ys_probs.push(logprob_rows[h][new_token as usize].exp());
                    hyp.num_trailing_blanks = 0;
                    let (score, new_state) =
                        self.graph.forward_one_step(hyp.context_state, new_token);
                    context_score = score;
                    hyp.context_state = new_state;
                    if self.graph.nodes[new_state].token == -1 {
                        // Fell back to ROOT: no keyword prefix alive — forget history.
                        let mut blanks = vec![-1i64; self.context_size];
                        *blanks.last_mut().expect("context_size >= 1") = BLANK_ID;
                        hyp.ys = blanks;
                        hyp.timestamps.clear();
                        hyp.ys_probs.clear();
                    }
                } else {
                    hyp.num_trailing_blanks += 1;
                }
                hyp.log_prob = combined + context_score as f64;
                match next.entry(hyp.ys.clone()) {
                    std::collections::hash_map::Entry::Occupied(mut e) => {
                        let existing = e.get_mut();
                        existing.log_prob = log_add(existing.log_prob, hyp.log_prob);
                    }
                    std::collections::hash_map::Entry::Vacant(e) => {
                        e.insert(hyp);
                    }
                }
            }
            self.beam = next.into_values().collect();

            // Fire check — best hypothesis only.
            if let Some(best_idx) = self.best_hyp_index() {
                let (matched, trailing) = {
                    let best = &self.beam[best_idx];
                    (
                        self.graph.matched_end(best.context_state),
                        best.num_trailing_blanks,
                    )
                };
                if let Some(end_node) = matched {
                    let level = self.graph.nodes[end_node].level.max(1);
                    let best = &self.beam[best_idx];
                    let mut mean = 0.0f32;
                    for i in 0..level {
                        mean += best.ys_probs.get(i).copied().unwrap_or(0.0);
                    }
                    mean /= level as f32;
                    if trailing > NUM_TRAILING_BLANKS
                        && mean >= self.graph.nodes[end_node].ac_threshold
                    {
                        let phrase = self.graph.nodes[end_node].phrase.clone();
                        let label = if phrase.is_empty() {
                            // Fallback: synthesize from the matched token ids (sherpa
                            // builds it from symbols; our labels are always set by the
                            // tokenize builder, so this is a defensive path).
                            format!("keyword_{end_node}")
                        } else {
                            phrase
                        };
                        fired = Some(label);
                        self.reset_beam();
                    }
                }
            }
        }

        self.frame_offset += num_frames as i32;
        Ok(fired)
    }

    /// One encoder call: x `[1, T, 80]` + carried states → encoder_out `(frames, joiner_dim)`.
    fn run_encoder(&mut self, window: &Array2<f32>) -> anyhow::Result<Array2<f32>> {
        // Seed zero states on a fresh stream / after a full reset.
        for (i, slot) in self.states.iter_mut().enumerate() {
            if slot.is_none() {
                let shape = &self.state_shapes[i];
                let value: DynValue = if self.state_is_i64[i] {
                    ort::value::Tensor::<i64>::from_array((
                        shape.clone(),
                        vec![0i64; shape.iter().product()],
                    ))
                    .map_err(ort_err("kws zero state (i64)"))?
                    .into_dyn()
                } else {
                    ort::value::Tensor::<f32>::from_array((
                        shape.clone(),
                        vec![0f32; shape.iter().product()],
                    ))
                    .map_err(ort_err("kws zero state (f32)"))?
                    .into_dyn()
                };
                *slot = Some(value);
            }
        }

        let x = ort::value::Tensor::<f32>::from_array((
            vec![1usize, window.nrows(), window.ncols()],
            window.iter().copied().collect::<Vec<f32>>(),
        ))
        .map_err(ort_err("kws x tensor"))?;

        let mut inputs: Vec<(&str, ort::session::SessionInputValue<'_>)> =
            Vec::with_capacity(1 + self.state_in.len());
        inputs.push(("x", ort::session::SessionInputValue::from(x)));
        for (name, state) in self.state_in.iter().zip(self.states.iter()) {
            let v = state.as_ref().expect("state seeded above");
            inputs.push((name.as_str(), ort::session::SessionInputValue::from(v)));
        }

        let mut outputs = self
            .encoder
            .run(inputs)
            .map_err(ort_err("kws encoder run"))?;

        let encoder_out = {
            let v = outputs
                .remove("encoder_out")
                .ok_or_else(|| anyhow::anyhow!("encoder produced no encoder_out"))?;
            let arr = v
                .try_extract_array::<f32>()
                .map_err(ort_err("kws encoder_out extract"))?
                .to_owned();
            let dims = arr.shape().to_vec();
            if dims.len() != 3 || dims[0] != 1 {
                anyhow::bail!("unexpected encoder_out shape {dims:?}");
            }
            arr.into_shape_with_order((dims[1], dims[2]))?
        };

        // Carry every state output as the next call's matching input.
        for (i, out_name) in self.state_out.iter().enumerate() {
            let v = outputs
                .remove(out_name.as_str())
                .ok_or_else(|| anyhow::anyhow!("encoder missing state output {out_name}"))?;
            self.states[i] = Some(v);
        }

        Ok(encoder_out)
    }

    /// Map a detected label back to its position in the active keyword list.
    fn index_of(&self, label: &str) -> i32 {
        let needle = normalize_keyword_label(label);
        self.keywords
            .iter()
            .position(|k| normalize_keyword_label(k) == needle)
            .map_or(-1, |p| p as i32)
    }

    fn display_word_for_label(&self, label: &str, index: i32) -> String {
        if index >= 0
            && let Some(keyword) = self.keywords.get(index as usize)
        {
            return keyword.clone();
        }
        label.trim().replace('_', " ")
    }
}

/// `ort::Error` is not Send+Sync, so `?`-into-anyhow does not convert — stringify
/// at the boundary (same policy as the STT engines' SttError mapping).
fn ort_err(ctx: &'static str) -> impl FnOnce(ort::Error) -> anyhow::Error {
    move |e| anyhow::anyhow!("{ctx}: {e}")
}

/// CPU-only session (KWS is tiny; the DirectML EP is never worth the probe warnings —
/// same invariant the sherpa detector enforced via provider="cpu").
fn build_cpu_session(path: &Path, threads: usize) -> anyhow::Result<Session> {
    // NB: builder-stage errors are `ort::Error<SessionBuilder>` (generic carrier),
    // so these use inline closures instead of the shared `ort_err` helper.
    Session::builder()
        .map_err(|e| anyhow::anyhow!("kws session builder: {e}"))?
        .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
        .map_err(|e| anyhow::anyhow!("kws opt level: {e}"))?
        .with_intra_threads(threads)
        .map_err(|e| anyhow::anyhow!("kws intra threads: {e}"))?
        .commit_from_file(path)
        .map_err(|e| anyhow::anyhow!("kws session load {}: {e}", path.display()))
}

fn session_custom_meta(session: &Session) -> anyhow::Result<BTreeMap<String, String>> {
    let meta = session.metadata().map_err(ort_err("kws metadata"))?;
    let mut out = BTreeMap::new();
    if let Ok(keys) = meta.custom_keys() {
        for k in keys {
            if let Some(v) = meta.custom(&k) {
                out.insert(k, v);
            }
        }
    }
    Ok(out)
}

fn meta_usize(meta: &BTreeMap<String, String>, key: &str) -> anyhow::Result<usize> {
    meta.get(key)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| anyhow::anyhow!("KWS encoder metadata missing '{key}'"))
}

/// Decoder: last `context_size` tokens of `ys` (int64 `[1, ctx]`) → `decoder_out` `[1, 320]`.
fn run_decoder(decoder: &mut Session, context_size: usize, ys: &[i64]) -> anyhow::Result<Vec<f32>> {
    let ctx: Vec<i64> = ys[ys.len() - context_size..].to_vec();
    let y = ort::value::Tensor::<i64>::from_array((vec![1usize, context_size], ctx))
        .map_err(ort_err("kws decoder y"))?;
    let outputs = decoder
        .run(ort::inputs!["y" => y])
        .map_err(ort_err("kws decoder run"))?;
    let arr = outputs["decoder_out"]
        .try_extract_array::<f32>()
        .map_err(ort_err("kws decoder_out extract"))?;
    Ok(arr.iter().copied().collect())
}

/// Joiner: (encoder frame `[1, 320]`, decoder_out `[1, 320]`) → raw logits `[vocab]`.
fn run_joiner(joiner: &mut Session, enc: &[f32], dec: &[f32]) -> anyhow::Result<Vec<f32>> {
    let e = ort::value::Tensor::<f32>::from_array((vec![1usize, enc.len()], enc.to_vec()))
        .map_err(ort_err("kws joiner enc"))?;
    let d = ort::value::Tensor::<f32>::from_array((vec![1usize, dec.len()], dec.to_vec()))
        .map_err(ort_err("kws joiner dec"))?;
    let outputs = joiner
        .run(ort::inputs!["encoder_out" => e, "decoder_out" => d])
        .map_err(ort_err("kws joiner run"))?;
    let arr = outputs["logit"]
        .try_extract_array::<f32>()
        .map_err(ort_err("kws logit extract"))?;
    Ok(arr.iter().copied().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(ids: &[i64], boost: f32, thr: f32, phrase: &str) -> KeywordEntry {
        KeywordEntry {
            ids: ids.to_vec(),
            boost,
            threshold: thr,
            phrase: phrase.to_string(),
        }
    }

    #[test]
    fn context_graph_builds_trie_with_defaults() {
        let g = ContextGraph::build(&[entry(&[5, 6, 7], 0.0, 0.0, "kw")], 3.0, 0.25);
        // root -> 5 -> 6 -> 7(end)
        let n1 = g.nodes[ROOT].next[&5];
        let n2 = g.nodes[n1].next[&6];
        let n3 = g.nodes[n2].next[&7];
        assert_eq!(g.nodes[n1].node_score, 3.0);
        assert_eq!(g.nodes[n3].node_score, 9.0);
        assert!(g.nodes[n3].is_end);
        assert_eq!(g.nodes[n3].ac_threshold, 0.25);
        assert_eq!(g.nodes[n3].level, 3);
        assert_eq!(g.nodes[n3].phrase, "kw");
    }

    #[test]
    fn forward_one_step_boosts_and_rolls_back() {
        let g = ContextGraph::build(&[entry(&[5, 6], 0.0, 0.0, "kw")], 2.0, 0.25);
        let (s1, n1) = g.forward_one_step(ROOT, 5);
        assert_eq!(s1, 2.0);
        // Diverge: token 9 falls back to root — rollback of the partial boost.
        let (s2, n2) = g.forward_one_step(n1, 9);
        assert_eq!(n2, ROOT);
        assert_eq!(s2, -2.0);
        // Complete: end node adds output_score on arrival.
        let (s3, n3) = g.forward_one_step(n1, 6);
        assert!(g.nodes[n3].is_end);
        assert_eq!(s3, 2.0 + 4.0); // token_score + output_score(=node_score at end)
    }

    #[test]
    fn fail_links_follow_shared_suffixes() {
        // keywords: [1,2,3] and [2,3] — after matching 1,2 the fail chain must know
        // that "2" is also a keyword prefix.
        let g = ContextGraph::build(
            &[
                entry(&[1, 2, 3], 0.0, 0.0, "a"),
                entry(&[2, 3], 0.0, 0.0, "b"),
            ],
            1.0,
            0.25,
        );
        let n1 = g.nodes[ROOT].next[&1];
        let n12 = g.nodes[n1].next[&2];
        let n2 = g.nodes[ROOT].next[&2];
        assert_eq!(g.nodes[n12].fail, n2);
        // Ending [1,2,3] also completes [2,3] via the output link of the deep 3-node.
        let n123 = g.nodes[n12].next[&3];
        let n23 = g.nodes[n2].next[&3];
        assert_eq!(g.nodes[n123].output, Some(n23));
    }

    #[test]
    fn keyword_parsing_reads_modifiers() {
        let mut symbols = HashMap::new();
        symbols.insert("▁HE".to_string(), 10i64);
        symbols.insert("Y".to_string(), 11i64);
        let kws = parse_keywords_content("▁HE Y :2.5 #0.35 @hey_test\n", &symbols).expect("parses");
        assert_eq!(kws.len(), 1);
        assert_eq!(kws[0].ids, vec![10, 11]);
        assert_eq!(kws[0].boost, 2.5);
        assert_eq!(kws[0].threshold, 0.35);
        assert_eq!(kws[0].phrase, "hey_test");
    }

    #[test]
    fn keyword_parsing_rejects_oov() {
        let symbols = HashMap::new();
        assert!(parse_keywords_content("NOPE @x\n", &symbols).is_err());
    }

    #[test]
    fn log_add_matches_manual() {
        let a = (0.6f64).ln();
        let b = (0.4f64).ln();
        assert!((log_add(a, b) - 0.0f64).abs() < 1e-9); // ln(1.0)
    }
}
