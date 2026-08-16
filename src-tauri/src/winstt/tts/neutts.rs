// NeuTTS-2e (neuphonic/neutts-2e) — Qwen3 backbone → NeuCodec tokens → 24 kHz audio.
//
// Same shape as `orpheus.rs` (autoregressive KV-cache decode + a separate vocoder session),
// but the conditioning is different in one load-bearing way: NeuTTS-2e is NOT a text-only
// model and NOT a cloning model. Every generation is prefixed with a FIXED, pre-encoded
// speaker reference — the reference clip's NeuCodec codes plus its transcript — and the
// four shipped speakers ARE those four references. They are 175-402 int16 codes each
// (~11 KB total), so they live in this file rather than costing a download (see
// `NEUTTS_SPEAKERS`). Emotion is a single control token spliced between the reference
// transcript and the target text.
//
// Contract derived from the export's own `onnx_infer.py` + the tokenizer's added-token table.
// VERIFIED end-to-end through this engine (examples/tts_engine_bench, int8 + fp32 rungs, 4
// speakers x 7 emotions): 0 NaN everywhere, every render transcribed back word-for-word by
// Whisper base.en, and the emotion token measurably moves the acoustics rather than just
// changing the sampled sequence — on one speaker and one sentence, median F0 and intonation
// range order monotonically by arousal (sad 183 Hz / IQR 27, neutral 202 / 31, fearful 216 /
// 37, disgusted 218 / 51, surprised 249 / 66, angry 255 / 70, happy 289 / 100) with energy
// following (sad −18 % vs neutral, angry +60 %).
//
//   prompt  = [TEXT_PROMPT_START] ++ text_ids ++ [TEXT_PROMPT_END] ++ [SPEECH_GEN_START] ++ ref_code_ids
//     text_ids (neutral) = tok("{ref_text} {target}")
//     text_ids (emotion) = tok(ref_text) ++ [<|EMOTION|>] ++ tok(target)
//     ref_code_ids       = SPEECH_TOKEN_BASE + code, one per reference frame
//   graph   = Qwen3, 28 layers, 4 KV heads, head_dim 128, f32 KV
//             in : input_ids[1,T] i64, attention_mask[1,past+T] i64, position_ids[1,T] i64,
//                  past_key_values.{0..27}.{key,value}[1,4,past,128] f32
//             out: logits[1,T,217232] f32, present.{0..27}.{key,value}
//   sample  = temperature 1.0 → top-k 50 → top-p 0.95 → min-p 0.05; EOS suppressed for the
//             first 50 generated tokens (the reference's `min_new_tokens`, forcing >= 1 s)
//   stop    = SPEECH_GENERATION_END, or the 2048-token total budget (~30 s of audio)
//   codec   = generated id − SPEECH_TOKEN_BASE → NeuCodec decoder `codes[1,1,T]` i32
//             → `audio[1,1,480*(T-1)]` f32 @ 24 kHz (50 frames/s)
//
// CPU-pinned like the other LLM-class engines, but with an EXPLICIT 4-thread intra-op cap:
// the backbone is only 512-wide, so ORT's default (one thread per logical core) loses ~2.8x
// on this box. See `provider::cpu_session_with_intra_threads`.
//
// LICENSING: the backbone weights (and the speaker reference codes below, which come from
// the same release) are under the NeuTTS Open License v1.0 — permissive for redistribution
// and for conversion to other formats, but Commercial Use is licensed only to entities under
// $5M annual revenue. The NeuCodec decoder is Apache-2.0. Both are recorded in
// THIRD_PARTY_NOTICES.md and the catalog row carries the same warning.

use std::borrow::Cow;
use std::path::Path;

use ndarray::{Array2, Array3, Array4, ArrayD, IxDyn};
use ort::session::{Session, SessionInputValue};
use ort::value::Tensor;
use tokenizers::Tokenizer;
use unicode_normalization::UnicodeNormalization;

use super::sampling::{SplitMix64Rng, UniformF64};

pub const NEUTTS_SAMPLE_RATE: u32 = 24_000;

// ── canonical token ids (read off the export's tokenizer.json added-token table) ──
const TEXT_PROMPT_START: i64 = 151_671;
const TEXT_PROMPT_END: i64 = 151_672;
const SPEECH_GENERATION_START: i64 = 151_673;
/// `<|SPEECH_GENERATION_END|>` — the tokenizer's declared `eos_token`.
const SPEECH_GENERATION_END: i64 = 151_674;
/// `<|speech_0|>`. The 65 536 speech tokens are contiguous from here, so a code maps to an
/// id by addition — no per-code tokenizer round-trip through a megabyte-long string.
const SPEECH_TOKEN_BASE: i64 = 151_684;
/// NeuCodec is a SINGLE codebook of 2^16 entries.
const NEUCODEC_CODEBOOK: i64 = 65_536;

// ── sampler (the export's documented defaults; see its README "Generation defaults") ──
const TEMPERATURE: f64 = 1.0;
const TOP_K: usize = 50;
const TOP_P: f64 = 0.95;
const MIN_P: f64 = 0.05;
/// Total token budget (prompt + generated), matching the reference's `--max-length`.
const MAX_TOTAL_TOKENS: usize = 2_048;
/// EOS is suppressed until this many tokens have been emitted (~1 s of audio), so a very
/// short sentence cannot collapse to a click. Mirrors the library's `min_new_tokens`.
const MIN_NEW_TOKENS: usize = 50;
/// Intra-op threads for both sessions — see `provider::cpu_session_with_intra_threads` for the
/// 2.8x measurement behind the cap. Clamped to the machine's parallelism so a 2-core box does
/// not over-subscribe.
const INTRA_OP_THREADS: usize = 4;

/// `INTRA_OP_THREADS`, overridable via `WINSTT_TTS_INTRA_THREADS` so the benchmark can sweep
/// the count on a new box without a rebuild (same knob the STT side exposes as
/// `STT_BENCH_INTRA_THREADS`). Values outside 1..=logical-cores are ignored.
fn intra_op_threads() -> usize {
    let cores = std::thread::available_parallelism().map_or(4, std::num::NonZeroUsize::get);
    std::env::var("WINSTT_TTS_INTRA_THREADS")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n >= 1)
        .unwrap_or(INTRA_OP_THREADS)
        .min(cores)
}

/// One of the four fixed speakers: the pre-encoded reference the backbone is conditioned on.
#[derive(Clone, Copy, Debug)]
pub struct NeuTtsSpeaker {
    /// Speaker id (`emily`), also the first half of a voice id (`emily-happy`).
    pub id: &'static str,
    /// Verbatim transcript of the reference clip — it is part of the prompt, so it must
    /// match the codes exactly (a mismatched transcript truncates generation).
    pub transcript: &'static str,
    /// NeuCodec codes of the reference clip, 50 per second.
    pub codes: &'static [i32],
}

/// The seven supported emotions. `neutral` has NO control token — the reference implementation
/// simply joins the reference transcript and the target with a space — so it is modelled as
/// `None` rather than invented.
pub const NEUTTS_EMOTIONS: &[(&str, Option<i64>)] = &[
    ("neutral", None),
    ("angry", Some(217_220)),
    ("disgusted", Some(217_222)),
    ("fearful", Some(217_224)),
    ("happy", Some(217_221)),
    ("sad", Some(217_223)),
    ("surprised", Some(217_225)),
];

/// Default speaker/emotion for an empty or unrecognized voice id.
pub const NEUTTS_DEFAULT_SPEAKER: &str = "emily";
pub const NEUTTS_DEFAULT_EMOTION: &str = "neutral";

/// `emily.pt` from the `neutts` package (NeuCodec codes, 402 frames = 8.04 s).
const EMILY_CODES: &[i32] = &[
    6247, 10467, 10742, 52467, 20198, 23289, 50728, 3677, 9500, 10488, 23792, 61172, 40953, 2580,
    50106, 22138, 34174, 2787, 48885, 20450, 18855, 51129, 1401, 39803, 34750, 35707, 6841, 51835,
    37305, 43643, 9722, 25783, 8446, 8553, 40950, 51911, 21101, 38737, 22005, 53323, 54516, 23987,
    6641, 54741, 57592, 55426, 41201, 24195, 57589, 27778, 25766, 26982, 6374, 57541, 41036, 34314,
    24136, 20013, 34604, 3901, 19958, 19700, 51330, 8597, 12846, 9913, 20455, 28401, 5907, 18068,
    5919, 7116, 2826, 24102, 17705, 56948, 35313, 22601, 22588, 41314, 5913, 682, 36786, 56711,
    825, 1816, 42634, 22803, 54315, 38667, 1412, 70, 5192, 11561, 10408, 11893, 43161, 2092, 6552,
    52470, 23784, 2465, 33906, 33810, 6784, 14688, 6469, 38955, 10512, 27744, 7460, 9225, 34374,
    50389, 31875, 18826, 37140, 44526, 20068, 23480, 4001, 36082, 3573, 51331, 35758, 2668, 19437,
    20393, 6759, 42263, 42331, 53783, 64482, 28400, 2724, 14825, 13381, 2501, 32585, 24261, 32517,
    19336, 52579, 23009, 3553, 30917, 43337, 58702, 25614, 37926, 58634, 50525, 48853, 7572, 19141,
    15237, 19152, 10133, 53275, 42013, 50452, 41237, 53375, 59063, 25851, 4706, 33643, 56818,
    45270, 8233, 16426, 2753, 14537, 24453, 51427, 2481, 43079, 44254, 11973, 22213, 52067, 17650,
    36953, 63801, 25657, 20589, 61687, 4417, 1218, 2698, 31372, 8138, 49130, 40919, 58566, 29333,
    42164, 47001, 20632, 43074, 31217, 52138, 62964, 18614, 19667, 27180, 11572, 25860, 58596,
    55380, 27043, 6330, 3319, 3319, 19686, 19622, 19622, 19622, 19622, 3307, 3319, 2279, 42198,
    53464, 58772, 59873, 27107, 18659, 60123, 10203, 26846, 16492, 18669, 7992, 11209, 6923, 18746,
    18981, 64864, 1086, 45934, 29580, 32726, 15299, 16362, 55906, 47177, 58524, 60600, 28257,
    15864, 14665, 3017, 1801, 8905, 22722, 51962, 38490, 27382, 39670, 26716, 6188, 33130, 42760,
    6625, 56819, 42322, 4161, 13520, 9025, 24090, 23586, 9304, 21016, 52723, 2482, 35907, 10380,
    55685, 28381, 4566, 6365, 20655, 18653, 474, 23945, 55611, 7456, 25616, 54292, 45960, 43480,
    859, 46921, 47512, 41370, 10692, 46406, 56613, 6160, 23632, 21536, 57605, 54116, 19938, 2215,
    17651, 8693, 25176, 5285, 11538, 26903, 25862, 51553, 56707, 25096, 5208, 12557, 4460, 29881,
    61691, 56951, 17783, 33395, 59035, 36496, 3223, 39250, 55927, 44649, 36708, 39565, 1837, 19801,
    52448, 25731, 25530, 17165, 669, 8268, 22745, 35056, 19696, 12359, 60877, 59528, 56025, 650,
    19677, 431, 19661, 1438, 22857, 56379, 3104, 22560, 62737, 581, 19160, 12998, 19077, 54315,
    23600, 6480, 34861, 36275, 19682, 24696, 8254, 8222, 37097, 29355, 14584, 5499, 2810, 17023,
    30457, 35755, 49145, 60113, 20541, 43, 45805, 17234, 27121, 29013, 62933, 58712, 42385, 63201,
    61011, 60710, 6240, 22544, 43280, 44053, 22576, 14629, 45577, 55524, 24018, 6629,
];

/// `paul.pt` from the `neutts` package (NeuCodec codes, 286 frames = 5.72 s).
const PAUL_CODES: &[i32] = &[
    7331, 7638, 55497, 53322, 53129, 25422, 20249, 4189, 36217, 20144, 23849, 6445, 2750, 30709,
    63478, 48124, 22126, 14166, 28966, 12853, 16698, 29238, 28985, 38755, 36472, 47750, 60905,
    51394, 8232, 50214, 34726, 4616, 45373, 29536, 41005, 708, 7658, 43334, 43038, 51533, 32729,
    27528, 18861, 35554, 36522, 52099, 34133, 4913, 20855, 41377, 61624, 37072, 45805, 29220,
    57982, 16950, 8637, 14054, 59540, 38190, 46, 33883, 29508, 17242, 12882, 63970, 59029, 51442,
    24597, 58490, 53267, 48005, 12889, 43053, 10680, 13372, 12021, 60624, 60456, 34838, 22433,
    4506, 24992, 50642, 52688, 55385, 51242, 55321, 65231, 29096, 30792, 12452, 2124, 26949, 27694,
    3620, 52448, 59429, 43567, 55913, 64763, 51189, 45245, 22132, 29172, 60969, 39230, 3620, 7541,
    3373, 2094, 61031, 13502, 12469, 2805, 14194, 14004, 42940, 9388, 13464, 16458, 28693, 57500,
    8469, 46295, 60066, 58586, 55442, 50401, 38978, 55659, 7536, 10466, 11478, 18775, 54558, 39378,
    26853, 54441, 55493, 58857, 51722, 54489, 54360, 39145, 43095, 3511, 55426, 55402, 51497, 3448,
    2344, 1081, 48555, 1900, 2681, 21493, 10681, 22173, 17478, 277, 8230, 15266, 31705, 60325,
    51409, 8204, 62483, 9730, 2572, 13080, 18972, 30300, 19627, 12246, 64153, 56638, 6525, 4457,
    4250, 50189, 61358, 48780, 30845, 15043, 43454, 55794, 58612, 55780, 38652, 45936, 21796,
    19312, 12402, 15152, 14133, 61170, 43175, 15132, 45693, 35868, 20590, 3212, 24989, 29768,
    12544, 20558, 32212, 2270, 3476, 34189, 46916, 30536, 1601, 61471, 24621, 4250, 20857, 5215,
    4190, 57437, 55882, 53396, 50294, 38107, 9338, 6647, 56771, 57812, 37585, 29197, 21269, 19090,
    64166, 65210, 56007, 17321, 61502, 45490, 45114, 12838, 30822, 10967, 52626, 56373, 2346,
    38737, 61520, 58530, 32917, 41412, 12945, 37132, 20, 25730, 48115, 63635, 29081, 12904, 15566,
    59734, 57691, 23897, 3605, 3376, 2101, 48962, 18280, 19529, 24762, 25692, 21897, 31935, 39638,
    30892, 47500, 39117, 11689, 64968, 60805, 56461, 56532, 60613, 23632, 28135, 7318,
];

/// `sophie.pt` from the `neutts` package (NeuCodec codes, 175 frames = 3.50 s).
const SOPHIE_CODES: &[i32] = &[
    35049, 3316, 52706, 52182, 32290, 19142, 44578, 14806, 19761, 2692, 18014, 11676, 32111, 14477,
    7547, 3804, 4015, 18908, 28015, 30956, 11647, 3549, 27595, 63566, 32022, 11300, 44368, 60418,
    43265, 43301, 56874, 52629, 56449, 39226, 2102, 262, 20630, 55818, 50273, 50273, 50402, 53510,
    40245, 35089, 52512, 49189, 55878, 8265, 12360, 4608, 4030, 32485, 30950, 4305, 383, 10094,
    47323, 55521, 54710, 2107, 17194, 21320, 34380, 42588, 10436, 28939, 29722, 10512, 27648,
    42288, 55316, 52625, 35558, 19170, 37285, 41641, 25982, 20981, 1194, 5785, 43447, 55776, 48530,
    6454, 37, 59025, 27154, 36198, 43943, 31942, 4426, 1497, 12950, 4796, 13220, 42474, 61908,
    54757, 50405, 55682, 836, 15321, 32724, 48826, 44770, 40438, 61409, 65254, 49106, 20338, 65442,
    36470, 19072, 18828, 54153, 1512, 8271, 45228, 45198, 29753, 10529, 27665, 58641, 43028, 25665,
    26937, 55925, 52404, 21821, 8740, 52320, 57558, 8456, 23437, 47762, 62803, 55666, 56450, 260,
    14316, 9554, 59617, 45254, 45246, 57679, 41433, 18071, 20210, 31430, 18132, 46863, 26525, 526,
    12793, 58438, 63209, 53701, 45212, 46367, 6458, 6774, 122, 33835, 47044, 45832, 29000, 28694,
    17554, 32375, 46310, 24135, 25825, 64358, 65254, 56550,
];

/// `steven.pt` from the `neutts` package (NeuCodec codes, 258 frames = 5.16 s).
const STEVEN_CODES: &[i32] = &[
    52451, 30699, 3015, 1499, 12826, 12410, 25959, 1402, 9003, 14191, 16355, 28838, 12626, 17469,
    5675, 31851, 15074, 2986, 57074, 55427, 4932, 1612, 9552, 51401, 52707, 56031, 49147, 38389,
    1709, 30908, 31231, 18824, 9051, 29253, 13761, 24175, 57281, 32474, 10884, 26189, 35490, 45453,
    21772, 33100, 12836, 635, 45987, 57467, 298, 62, 1063, 46839, 24482, 51874, 21819, 1325, 62,
    582, 4701, 12612, 21702, 51680, 19958, 56810, 31465, 25540, 8598, 55766, 52449, 51587, 45746,
    33745, 91, 24964, 35912, 5100, 15977, 60850, 28297, 25252, 58394, 50471, 35122, 52277, 3484,
    25229, 48716, 17039, 5324, 61581, 50393, 35234, 50530, 34342, 127, 46, 45802, 25092, 42202,
    27099, 28135, 49105, 60722, 3381, 39952, 41096, 64904, 42637, 35212, 16584, 11521, 44074,
    39549, 52853, 18913, 53702, 8622, 41690, 26859, 27334, 10731, 61157, 51442, 16546, 8894, 17228,
    30104, 24902, 54292, 52641, 56369, 18721, 53857, 33689, 27839, 13767, 22762, 2501, 47863,
    57062, 18662, 36337, 5834, 12872, 4424, 9102, 34136, 29002, 58476, 52657, 52657, 19762, 52241,
    38528, 13381, 28828, 21644, 172, 14536, 55457, 19680, 50594, 58457, 60171, 58374, 53529, 45082,
    45642, 47631, 63049, 55786, 35233, 18930, 7563, 5468, 13160, 6474, 38053, 55799, 59731, 520,
    12818, 43012, 5505, 31898, 3521, 13658, 913, 13238, 26135, 23867, 3425, 7216, 24161, 23584,
    20006, 52913, 52305, 26434, 9028, 12678, 13217, 32025, 20088, 28922, 15473, 2042, 64948, 60872,
    38524, 5388, 31736, 9675, 60086, 59111, 19454, 9324, 30396, 30904, 27562, 43765, 38562, 35559,
    38626, 39410, 5868, 7324, 20612, 20638, 8933, 45355, 50914, 36065, 36133, 2053, 25474, 12663,
    60034, 51690, 34946, 12378, 584, 17992, 37292, 11400, 24749, 14409, 16788, 5323, 30160, 46295,
    53200, 54763, 56416, 18646, 55944, 2238, 3251,
];

pub const NEUTTS_SPEAKERS: &[NeuTtsSpeaker] = &[
    NeuTtsSpeaker {
        id: "emily",
        transcript: "What we need, helping us to develop the scope of work for a future procurement. Most important to this process is that you look at process changes.",
        codes: EMILY_CODES,
    },
    NeuTtsSpeaker {
        id: "paul",
        transcript: "Halloween came from the ancient Celtic festival Soin. Soin comes from Old Irish and means end of summer.",
        codes: PAUL_CODES,
    },
    NeuTtsSpeaker {
        id: "sophie",
        transcript: "Last. So we just need to make the rest of the connection.",
        codes: SOPHIE_CODES,
    },
    NeuTtsSpeaker {
        id: "steven",
        transcript: "Meaning that my relationship with the other factions has been getting better, but there is still a long way to go.",
        codes: STEVEN_CODES,
    },
];

/// Split a picker voice id into `(speaker, emotion)`.
///
/// The catalog exposes the 4x7 cross product as flat `"{speaker}-{emotion}"` ids so the
/// existing voice dropdown needs no new UI. A bare speaker id (`"emily"`) and an unknown id
/// both resolve to the defaults, so a stale selection still speaks.
pub fn parse_voice(voice: &str) -> (&'static NeuTtsSpeaker, Option<i64>) {
    let voice = voice.trim().to_ascii_lowercase();
    let (spk_id, emo_id) = voice.split_once('-').unwrap_or((voice.as_str(), ""));
    let speaker = NEUTTS_SPEAKERS
        .iter()
        .find(|s| s.id == spk_id)
        .or_else(|| {
            NEUTTS_SPEAKERS
                .iter()
                .find(|s| s.id == NEUTTS_DEFAULT_SPEAKER)
        })
        .unwrap_or(&NEUTTS_SPEAKERS[0]);
    let emotion = NEUTTS_EMOTIONS
        .iter()
        .find(|(name, _)| *name == emo_id)
        .and_then(|(_, id)| *id);
    (speaker, emotion)
}

#[derive(Debug)]
pub enum NeuTtsError {
    Session(String),
    Tokenizer(String),
    Inference(String),
}

impl std::fmt::Display for NeuTtsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NeuTtsError::Session(m) => write!(f, "neutts session: {m}"),
            NeuTtsError::Tokenizer(m) => write!(f, "neutts tokenizer: {m}"),
            NeuTtsError::Inference(m) => write!(f, "neutts inference: {m}"),
        }
    }
}
pub type NeuTtsResult<T> = Result<T, NeuTtsError>;

type NamedInput = (Cow<'static, str>, SessionInputValue<'static>);

pub struct NeuTtsEngine {
    lm: Session,
    codec: Session,
    tokenizer: Tokenizer,
    past_names: Vec<String>,    // sorted `past_key_values.*`
    present_names: Vec<String>, // sorted `present.*` (index-aligned with past)
    kv_heads: usize,
    head_dim: usize,
}

impl NeuTtsEngine {
    pub fn load(lm_path: &Path, codec_path: &Path, tokenizer_path: &Path) -> NeuTtsResult<Self> {
        let lm = cpu_session(lm_path, "NeuTTS")?;
        let codec = cpu_session(codec_path, "NeuTTS NeuCodec")?;
        let tokenizer = Tokenizer::from_file(tokenizer_path).map_err(|e| {
            NeuTtsError::Tokenizer(format!("load {}: {e}", tokenizer_path.display()))
        })?;

        let past_names = sorted_io(&lm, IoKind::Input, "past_key_values.");
        let present_names = sorted_io(&lm, IoKind::Output, "present.");
        if past_names.len() != present_names.len() || past_names.is_empty() {
            return Err(NeuTtsError::Session(format!(
                "neutts KV mismatch: {} past vs {} present",
                past_names.len(),
                present_names.len()
            )));
        }
        let (kv_heads, head_dim) = kv_shape(&lm, &past_names[0])?;

        Ok(Self {
            lm,
            codec,
            tokenizer,
            past_names,
            present_names,
            kv_heads,
            head_dim,
        })
    }

    /// Synthesize `text` in `voice` (`"{speaker}-{emotion}"`) → mono f32 PCM @ 24 kHz.
    pub fn synthesize(&mut self, text: &str, voice: &str) -> NeuTtsResult<Vec<f32>> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let (speaker, emotion) = parse_voice(voice);
        let prompt = self.build_prompt(speaker, emotion, text)?;
        let generated = self.decode(&prompt)?;
        let codes = parse_codes(&generated);
        if codes.is_empty() {
            return Err(NeuTtsError::Inference("no speech codes generated".into()));
        }
        self.codec_decode(&codes)
    }

    /// `[TEXT_PROMPT_START] ++ text ++ [TEXT_PROMPT_END] ++ [SPEECH_GEN_START] ++ ref codes`.
    ///
    /// The two text branches are NOT interchangeable: the neutral path tokenizes the joined
    /// `"{ref} {target}"` (so BPE merges across the join exactly as upstream), while the
    /// emotion path tokenizes each side separately around the control token.
    fn build_prompt(
        &self,
        speaker: &NeuTtsSpeaker,
        emotion: Option<i64>,
        text: &str,
    ) -> NeuTtsResult<Vec<i64>> {
        let ref_text = normalize_text(speaker.transcript);
        let target = normalize_text(text);
        let text_ids: Vec<i64> = match emotion {
            None => self.encode(&format!("{ref_text} {target}"))?,
            Some(emotion_id) => {
                let mut ids = self.encode(&ref_text)?;
                ids.push(emotion_id);
                ids.extend(self.encode(&target)?);
                ids
            }
        };
        let mut prompt = Vec::with_capacity(text_ids.len() + speaker.codes.len() + 3);
        prompt.push(TEXT_PROMPT_START);
        prompt.extend(text_ids);
        prompt.push(TEXT_PROMPT_END);
        prompt.push(SPEECH_GENERATION_START);
        prompt.extend(
            speaker
                .codes
                .iter()
                .map(|&c| SPEECH_TOKEN_BASE + i64::from(c)),
        );
        Ok(prompt)
    }

    fn encode(&self, text: &str) -> NeuTtsResult<Vec<i64>> {
        let enc = self
            .tokenizer
            .encode(text, false)
            .map_err(|e| NeuTtsError::Tokenizer(format!("encode: {e}")))?;
        Ok(enc.get_ids().iter().map(|&id| i64::from(id)).collect())
    }

    /// Autoregressive KV-cache decode → the raw generated token stream (excludes EOS).
    ///
    /// The cache is carried through host `Vec`s (extract `present.N` → build a fresh tensor
    /// for `past_key_values.N`), like every other AR engine in this tree.
    ///
    /// MEASURED, not assumed: the obvious "optimization" of moving the output value straight
    /// back in (`SessionOutputs::remove` → `SessionInputValue::Owned`, avoiding ~67 MB of
    /// memcpy per step) is **2.8x SLOWER here** — warm RTF 9.66 vs 3.39 on the same sentence
    /// and box. Pinning 56 output allocations across the next `run` defeats ORT's arena reuse,
    /// so every step faults in fresh pages instead of rewriting a warm buffer; the copy is
    /// cheaper than the allocation it would save. Do not "fix" this without re-benchmarking.
    fn decode(&mut self, prompt: &[i64]) -> NeuTtsResult<Vec<i64>> {
        let mut past: Vec<Option<Tensor<f32>>> = (0..self.past_names.len()).map(|_| None).collect();
        let mut generated: Vec<i64> = Vec::new();
        let mut next_input: Vec<i64> = prompt.to_vec();
        // Seeded off the prompt so the same (text, voice) renders identically every time —
        // the upstream sampler is stochastic and an unseeded engine would make cold/warm
        // benchmark passes incomparable.
        let mut rng = SplitMix64Rng::new(fnv1a_seed(prompt));
        // Reused scratch for the per-step top-k selection (the vocab is 217 232 wide, so a
        // fresh allocation every step would dominate the sampler's cost).
        let mut candidates: Vec<u32> = Vec::new();
        let budget = MAX_TOTAL_TOKENS.saturating_sub(prompt.len());

        let mut past_len = 0usize;
        for _ in 0..budget {
            let in_len = next_input.len();
            let attn_len = past_len + in_len;
            let mut inputs: Vec<NamedInput> = Vec::with_capacity(3 + self.past_names.len());
            inputs.push((
                Cow::Borrowed("input_ids"),
                tensor_i64((1, in_len), next_input.clone())?,
            ));
            inputs.push((
                Cow::Borrowed("attention_mask"),
                tensor_i64((1, attn_len), vec![1i64; attn_len])?,
            ));
            let pos: Vec<i64> = (past_len as i64..attn_len as i64).collect();
            inputs.push((
                Cow::Borrowed("position_ids"),
                tensor_i64((1, pos.len()), pos)?,
            ));
            for (i, name) in self.past_names.iter().enumerate() {
                // take ownership — past[i] is refilled from `present` after the run.
                let t = match past[i].take() {
                    Some(v) => v,
                    None => empty_kv(self.kv_heads, self.head_dim)?,
                };
                inputs.push((Cow::Owned(name.clone()), SessionInputValue::from(t)));
            }

            let outputs = self
                .lm
                .run(inputs)
                .map_err(|e| NeuTtsError::Inference(format!("lm run: {e}")))?;

            // Sample straight off the borrowed logits row — [1, T, 217232] is 394 MB on the
            // prefill step, so materializing it into an owned array would cost more than the
            // sampler does. Scoped so the borrow ends before the `present` values are moved.
            let next = {
                let (shape, data) = outputs["logits"]
                    .try_extract_tensor::<f32>()
                    .map_err(|e| NeuTtsError::Inference(format!("extract logits: {e}")))?;
                let vocab = shape.last().copied().unwrap_or(0).max(0) as usize;
                let row = data
                    .get(data.len().saturating_sub(vocab)..)
                    .filter(|r| !r.is_empty())
                    .ok_or_else(|| NeuTtsError::Inference("logits row unavailable".into()))?;
                sample_next(row, generated.len(), &mut candidates, &mut rng)
            };
            if next == SPEECH_GENERATION_END {
                break;
            }
            generated.push(next);

            for (i, pname) in self.present_names.iter().enumerate() {
                let (shape, data) = outputs[pname.as_str()]
                    .try_extract_tensor::<f32>()
                    .map_err(|e| NeuTtsError::Inference(format!("extract {pname}: {e}")))?;
                past[i] = Some(
                    Tensor::from_array((shape.to_vec(), data.to_vec()))
                        .map_err(|e| NeuTtsError::Inference(format!("kv tensor: {e}")))?,
                );
            }
            past_len = attn_len;
            next_input = vec![next];
        }
        Ok(generated)
    }

    /// NeuCodec decode: one codebook, `codes[1,1,T]` i32 → `audio[1,1,480*(T-1)]` f32.
    fn codec_decode(&mut self, codes: &[i32]) -> NeuTtsResult<Vec<f32>> {
        let arr = Array3::from_shape_vec((1, 1, codes.len()), codes.to_vec())
            .map_err(|e| NeuTtsError::Inference(format!("codes arr: {e}")))?;
        let tensor = Tensor::from_array(arr)
            .map_err(|e| NeuTtsError::Inference(format!("codes tensor: {e}")))?;
        let outputs = self
            .codec
            .run(ort::inputs! { "codes" => tensor })
            .map_err(|e| NeuTtsError::Inference(format!("neucodec run: {e}")))?;
        let audio = out_f32_named(&outputs, "audio")?; // [1,1,L]
        Ok(peak_normalized(audio.iter().copied().collect()))
    }
}

/// Peak-normalize when NeuCodec runs past [-1, 1] (same guard Chatterbox needs).
///
/// This is NOT hypothetical for this model: the high-arousal emotions overshoot. Measured
/// peaks on one speaker/sentence — neutral 0.851, sad 0.625, but **angry 1.139 and happy
/// 1.118**. The upstream `onnx_infer.py` writes those straight to a float WAV and never
/// notices; our f32 PCM goes to the Web-Audio playback queue and to a 16-bit WAV writer,
/// where anything over 1.0 hard-clips. Scaling to 0.99 preserves the loudness *relationship*
/// between emotions (each render is scaled as a whole) while removing the clipping.
fn peak_normalized(mut samples: Vec<f32>) -> Vec<f32> {
    let peak = samples.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    if peak > 1.0 {
        let gain = 0.99 / peak;
        for s in &mut samples {
            *s *= gain;
        }
    }
    samples
}

fn empty_kv(heads: usize, head_dim: usize) -> NeuTtsResult<Tensor<f32>> {
    let arr = Array4::<f32>::from_shape_vec((1, heads, 0, head_dim), Vec::new())
        .map_err(|e| NeuTtsError::Inference(format!("empty kv arr: {e}")))?;
    Tensor::from_array(arr).map_err(|e| NeuTtsError::Inference(format!("empty kv tensor: {e}")))
}

/// Generated ids → NeuCodec codes. Anything outside the speech-token block (a stray text or
/// control token) is dropped rather than wrapped into a bogus code.
fn parse_codes(generated: &[i64]) -> Vec<i32> {
    generated
        .iter()
        .filter(|&&t| (SPEECH_TOKEN_BASE..SPEECH_TOKEN_BASE + NEUCODEC_CODEBOOK).contains(&t))
        .map(|&t| (t - SPEECH_TOKEN_BASE) as i32)
        .collect()
}

/// NFKC + the reference's curly-quote fold (`onnx_infer.py::normalize_text`). The quote map
/// is NOT redundant with NFKC — NFKC leaves `'`/`"` alone — and the model was trained on the
/// folded form, so skipping it changes the tokenization of any pasted prose.
fn normalize_text(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\u{2018}' | '\u{2019}' => '\'',
            '\u{201C}' | '\u{201D}' => '"',
            other => other,
        })
        .nfkc()
        .collect()
}

// ── ORT helpers (mirror orpheus / qwen3_tts idioms) ────────────────────────────────

fn cpu_session(path: &Path, engine: &str) -> NeuTtsResult<Session> {
    super::provider::cpu_session_with_intra_threads(
        path,
        "NeuTTS-2e is a narrow (512-wide) AR decoder that loses ~2.8x to thread over-subscription",
        engine,
        intra_op_threads(),
    )
    .map_err(NeuTtsError::Session)
}

fn tensor_i64(shape: (usize, usize), data: Vec<i64>) -> NeuTtsResult<SessionInputValue<'static>> {
    let arr = Array2::from_shape_vec(shape, data)
        .map_err(|e| NeuTtsError::Inference(format!("i64 arr: {e}")))?;
    let t =
        Tensor::from_array(arr).map_err(|e| NeuTtsError::Inference(format!("i64 tensor: {e}")))?;
    Ok(SessionInputValue::from(t))
}

fn out_f32_named(
    outputs: &ort::session::SessionOutputs<'_>,
    name: &str,
) -> NeuTtsResult<ArrayD<f32>> {
    let (shape, data) = outputs[name]
        .try_extract_tensor::<f32>()
        .map_err(|e| NeuTtsError::Inference(format!("extract {name}: {e}")))?;
    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    ArrayD::from_shape_vec(IxDyn(&dims), data.to_vec())
        .map_err(|e| NeuTtsError::Inference(format!("shape {name}: {e}")))
}

enum IoKind {
    Input,
    Output,
}

fn sorted_io(sess: &Session, kind: IoKind, prefix: &str) -> Vec<String> {
    let mut names: Vec<String> = match kind {
        IoKind::Input => sess.inputs().iter().map(|i| i.name().to_string()).collect(),
        IoKind::Output => sess
            .outputs()
            .iter()
            .map(|o| o.name().to_string())
            .collect(),
    };
    names.retain(|n| n.starts_with(prefix));
    // `past_key_values.10.key` must not sort before `past_key_values.2.key`: the KV inputs are
    // paired with `present.*` BY INDEX, so a lexicographic sort would silently cross-wire
    // layers 2..9 with 10..27 (28 layers here, so this is not hypothetical).
    names.sort_by_key(|n| (layer_index(n), n.ends_with(".value")));
    names
}

/// The `N` in `past_key_values.N.key` / `present.N.value`; `usize::MAX` when absent so
/// unparsable names sort last deterministically instead of colliding at 0.
fn layer_index(name: &str) -> usize {
    name.split('.')
        .find_map(|part| part.parse::<usize>().ok())
        .unwrap_or(usize::MAX)
}

fn kv_shape(sess: &Session, name: &str) -> NeuTtsResult<(usize, usize)> {
    let inp = sess
        .inputs()
        .iter()
        .find(|i| i.name() == name)
        .ok_or_else(|| NeuTtsError::Session(format!("missing kv input {name}")))?;
    let shape = inp.dtype().tensor_shape();
    // shape (batch, kv_heads, seq, head_dim); dims 1 and 3 are static in this export.
    let heads = shape
        .and_then(|s| s.get(1).copied())
        .filter(|&d| d > 0)
        .unwrap_or(4) as usize;
    let hd = shape
        .and_then(|s| s.get(3).copied())
        .filter(|&d| d > 0)
        .unwrap_or(128) as usize;
    Ok((heads, hd))
}

// ── sampling ───────────────────────────────────────────────────────────────────────

fn fnv1a_seed(prompt: &[i64]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &t in prompt {
        h ^= t as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h | 1
}

/// temperature → top-k → top-p → min-p → categorical draw, over a 217k-wide row.
///
/// Deliberately NOT `sampling::sample`: that helper sorts the WHOLE logit row twice (once
/// for top-k, once for top-p), which is affordable for the Qwen3-TTS talker's 3 072-wide
/// codebook and is not affordable here. This does one O(V) selection into the top
/// [`TOP_K`] and then works over 50 elements, matching the reference's `argpartition` chain.
/// The three filters run in the reference's order and on the reference's quantities: top-p
/// and min-p both read the probabilities normalized over the top-k, and only the survivors
/// are renormalized before the draw.
fn sample_next(
    logits: &[f32],
    generated: usize,
    candidates: &mut Vec<u32>,
    rng: &mut SplitMix64Rng,
) -> i64 {
    let vocab = logits.len();
    if vocab == 0 {
        return SPEECH_GENERATION_END;
    }
    // EOS is masked to -inf for the first MIN_NEW_TOKENS steps BEFORE selection (as upstream
    // does), so the suppressed slot is replaced by the next-best token rather than lost.
    let suppress_eos = generated < MIN_NEW_TOKENS;
    let key = |i: u32| -> f32 {
        if suppress_eos && i64::from(i) == SPEECH_GENERATION_END {
            f32::NEG_INFINITY
        } else {
            logits[i as usize]
        }
    };

    candidates.clear();
    candidates.extend(0..vocab as u32);
    let k = TOP_K.min(vocab);
    let split = vocab - k;
    if split > 0 {
        candidates.select_nth_unstable_by(split, |&a, &b| {
            key(a)
                .partial_cmp(&key(b))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    let mut top: Vec<u32> = candidates[split..].to_vec();
    top.sort_unstable_by(|&a, &b| {
        key(b)
            .partial_cmp(&key(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // probs ∝ exp((logit − logit_max) / T), normalized over the top-k.
    let max = f64::from(key(top[0]));
    let mut probs: Vec<f64> = top
        .iter()
        .map(|&i| ((f64::from(key(i)) - max) / TEMPERATURE).exp())
        .collect();
    let sum: f64 = probs.iter().sum();
    if sum > 0.0 {
        for p in &mut probs {
            *p /= sum;
        }
    }

    // top-p: keep while the EXCLUSIVE cumulative mass is below TOP_P (so the first token
    // always survives, even when it alone exceeds the nucleus).
    let mut keep = probs.len();
    if TOP_P < 1.0 {
        let mut cum = 0.0f64;
        for (i, &p) in probs.iter().enumerate() {
            if cum >= TOP_P {
                keep = i;
                break;
            }
            cum += p;
        }
    }
    // min-p: relative floor against the TOP probability (pre-renormalization, as upstream).
    if MIN_P > 0.0 {
        let floor = MIN_P * probs[0];
        let cut = probs[..keep]
            .iter()
            .position(|&p| p < floor)
            .unwrap_or(keep);
        keep = cut.max(1);
    }
    let keep = keep.max(1);

    let renorm: f64 = probs[..keep].iter().sum();
    let draw = rng.next_f64() * renorm;
    let mut acc = 0.0f64;
    for (idx, &p) in top[..keep].iter().zip(probs[..keep].iter()) {
        acc += p;
        if draw < acc {
            return i64::from(*idx);
        }
    }
    i64::from(top[0])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_speaker_reference_is_a_valid_neucodec_sequence() {
        assert_eq!(NEUTTS_SPEAKERS.len(), 4);
        for s in NEUTTS_SPEAKERS {
            assert!(
                !s.transcript.trim().is_empty(),
                "{} has no transcript",
                s.id
            );
            // A mismatched or empty reference truncates generation to a click, so both
            // halves of the reference are pinned here.
            assert!(s.codes.len() >= 50, "{} reference is too short", s.id);
            for &c in s.codes {
                assert!(
                    i64::from(c) >= 0 && i64::from(c) < NEUCODEC_CODEBOOK,
                    "{}: code {c} outside the single 2^16 codebook",
                    s.id
                );
            }
        }
    }

    #[test]
    fn voice_ids_split_into_speaker_and_emotion() {
        let (spk, emo) = parse_voice("sophie-sad");
        assert_eq!(spk.id, "sophie");
        assert_eq!(emo, Some(217_223));
        // Bare speaker id → neutral (which has NO control token).
        let (spk, emo) = parse_voice("paul");
        assert_eq!(spk.id, "paul");
        assert_eq!(emo, None);
        assert_eq!(parse_voice("steven-neutral").1, None);
        // Unknown speaker / emotion / empty all fall back rather than failing to speak.
        assert_eq!(parse_voice("nobody-happy").0.id, NEUTTS_DEFAULT_SPEAKER);
        assert_eq!(parse_voice("emily-elated").1, None);
        assert_eq!(parse_voice("").0.id, NEUTTS_DEFAULT_SPEAKER);
        assert_eq!(parse_voice("EMILY-HAPPY").1, Some(217_221));
    }

    #[test]
    fn emotion_table_has_one_neutral_and_six_control_tokens() {
        assert_eq!(NEUTTS_EMOTIONS.len(), 7);
        let with_token: Vec<i64> = NEUTTS_EMOTIONS.iter().filter_map(|(_, id)| *id).collect();
        assert_eq!(with_token.len(), 6);
        // The control tokens are the tail of the vocab (217 220..217 225) — a typo here
        // would index into the speech block and emit a code instead of an emotion.
        for id in with_token {
            assert!((217_220..=217_225).contains(&id), "bad emotion token {id}");
        }
        assert_eq!(
            NEUTTS_EMOTIONS.iter().find(|(n, _)| *n == "neutral"),
            Some(&("neutral", None))
        );
    }

    #[test]
    fn parse_codes_drops_non_speech_tokens() {
        let generated = vec![
            SPEECH_TOKEN_BASE,
            SPEECH_TOKEN_BASE + 65_535,
            TEXT_PROMPT_END,
            SPEECH_TOKEN_BASE + 7,
        ];
        assert_eq!(parse_codes(&generated), vec![0, 65_535, 7]);
    }

    #[test]
    fn peak_normalize_only_engages_above_unity() {
        // Under 1.0 the render is left EXACTLY alone — normalizing everything would
        // flatten the loudness difference the emotions are supposed to produce.
        let quiet = peak_normalized(vec![0.5, -0.625, 0.1]);
        assert_eq!(quiet, vec![0.5, -0.625, 0.1]);
        // Over 1.0 (measured: angry 1.139) it scales the whole render to 0.99.
        let hot = peak_normalized(vec![1.139, -0.5]);
        assert!(
            (hot[0] - 0.99).abs() < 1e-6,
            "peak not brought to 0.99: {hot:?}"
        );
        assert!((hot[1] - (-0.5 * 0.99 / 1.139)).abs() < 1e-6);
        assert!(peak_normalized(Vec::new()).is_empty());
    }

    #[test]
    fn normalize_folds_curly_quotes() {
        assert_eq!(
            normalize_text("it\u{2019}s \u{201C}fine\u{201D}"),
            "it's \"fine\""
        );
    }

    /// A lexicographic sort would pair `past_key_values.10.key` with `present.1.key`.
    #[test]
    fn kv_names_sort_by_layer_index_not_lexicographically() {
        let mut names: Vec<String> = (0..28)
            .flat_map(|i| {
                [
                    format!("past_key_values.{i}.key"),
                    format!("past_key_values.{i}.value"),
                ]
            })
            .collect();
        names.reverse();
        names.sort_by_key(|n| (layer_index(n), n.ends_with(".value")));
        assert_eq!(names[0], "past_key_values.0.key");
        assert_eq!(names[1], "past_key_values.0.value");
        assert_eq!(names[4], "past_key_values.2.key");
        assert_eq!(names[20], "past_key_values.10.key");
    }

    #[test]
    fn sampler_is_deterministic_and_respects_the_eos_mask() {
        let mut logits = vec![0.0f32; 217_232];
        logits[SPEECH_GENERATION_END as usize] = 100.0;
        logits[(SPEECH_TOKEN_BASE + 3) as usize] = 50.0;
        let mut scratch = Vec::new();
        // Below MIN_NEW_TOKENS the EOS peak is masked, so the runner-up wins.
        let mut rng = SplitMix64Rng::new(7);
        assert_eq!(
            sample_next(&logits, 0, &mut scratch, &mut rng),
            SPEECH_TOKEN_BASE + 3
        );
        // Past the floor it is selectable again (and dominates at this margin).
        let mut rng = SplitMix64Rng::new(7);
        assert_eq!(
            sample_next(&logits, MIN_NEW_TOKENS, &mut scratch, &mut rng),
            SPEECH_GENERATION_END
        );
        // Same seed + same row → same token (a seeded engine is what makes cold/warm
        // benchmark passes comparable).
        let mut a = SplitMix64Rng::new(fnv1a_seed(&[1, 2, 3]));
        let mut b = SplitMix64Rng::new(fnv1a_seed(&[1, 2, 3]));
        assert_eq!(
            sample_next(&logits, 0, &mut scratch, &mut a),
            sample_next(&logits, 0, &mut scratch, &mut b)
        );
    }
}
