// Encoder-dictionary calibration + validation harness (retrieve-then-verify).
//
// Loads the real on-device mmBERT int8 masked-LM and drives the ACTUAL corrector
// (`EncoderDict::correct` over a `DictIndex`) across a labeled adversarial set, against a LARGE
// distractor dictionary — the exact condition the old prefilter degraded under. Reports, per rank-K
// threshold, recall (positives correctly snapped) and false-positive count (negatives wrongly
// changed), plus per-utterance latency. Use it to pick / confirm `DEFAULT_RANK_K`.
//
//   cargo run --release --example dict_eval
//
// Env:
//   DICT_MODEL_DIR   dir holding model_int8.onnx + tokenizer.json
//                    (default: %APPDATA%/com.winstt.winstt/encoder-dict)
//   DICT_RANK_KS     comma-separated rank-K thresholds to sweep (default: 300,600,900,1500)

use std::path::PathBuf;
use std::time::Instant;

use winstt_app_lib::winstt::encoder_dict::engine::EncoderDict;
use winstt_app_lib::winstt::encoder_dict::index::DictIndex;

/// A labeled case. `expect_swap = true` → the term SHOULD replace the misheard span; `false` → the
/// text must come back byte-for-byte unchanged (a false-positive probe).
struct Case {
    text: &'static str,
    /// For a positive case, the canonical term expected to appear in the output.
    expect_term: &'static str,
    expect_swap: bool,
}

const LONG_PARAGRAPH: &str = "I seriously think that the dictionary is a good and useful feature and I will keep it because it was alpha and now I have optimized it very well. To the point that I could say any word inside the dictionary and the interpreter will interpret it. Let's take each word into context. The when stt application contains the parakeet model which is of the NVIDIA family and has the real-time Nematron model that is real-time and can stream text, especially can paste the text as word by word. All of that is bundled into a VEET project that uses OLAMA in order to do the post processing, but you still can c continue to use cloud models like Connecting your API key to open router, all of that are piped through our Direct ML pipeline that is being used locally for the NVIDIA models. And we also have support to the Whisper models as well.";

fn cases() -> Vec<Case> {
    vec![
        // The user's real 834-char paragraph that silently got ZERO corrections in the app.
        Case {
            text: LONG_PARAGRAPH,
            expect_term: "Ollama",
            expect_swap: true,
        },
        // ── Positives: a genuine mis-hearing that should snap to the term ──────────────
        Case {
            text: "install veet today",
            expect_term: "Vite",
            expect_swap: true,
        },
        Case {
            text: "i really like kubernetties",
            expect_term: "Kubernetes",
            expect_swap: true,
        },
        Case {
            text: "let's run oh llama locally",
            expect_term: "Ollama",
            expect_swap: true,
        },
        Case {
            text: "the noemotron model is fast",
            expect_term: "Nemotron",
            expect_swap: true,
        },
        // Multi-byte prefix: the accented "café" (2-byte é) makes every following BYTE offset differ
        // from its CHAR offset. Same surprising "install … veet … today" frame as above, so if the
        // scorer mixed up byte vs char offsets it would score the wrong tokens and the rank would
        // collapse — a clean regression guard for the offset fix in span_mean_rank.
        Case {
            text: "café then install veet today",
            expect_term: "Vite",
            expect_swap: true,
        },
        // ── Negatives: correctly-heard words that must NOT be swapped ──────────────────
        Case {
            text: "watch the video tonight",
            expect_term: "Vite",
            expect_swap: false,
        },
        Case {
            text: "press the mute button",
            expect_term: "Vite",
            expect_swap: false,
        },
        Case {
            text: "will it transcribe the text cleanly",
            expect_term: "Ollama",
            expect_swap: false,
        },
        Case {
            text: "i had a great video call",
            expect_term: "Vite",
            expect_swap: false,
        },
        Case {
            text: "the weather is nice today",
            expect_term: "Nemotron",
            expect_swap: false,
        },
    ]
}

/// The user's ACTUAL dictionary (from the app DB), so this reproduces their real conditions.
fn dictionary() -> Vec<String> {
    [
        "WinSTT",
        "Parkeet",
        "Nemotron",
        "Vite",
        "Ollama",
        "OpenRouter",
        "Kubernetes",
        "DirectML",
        "Whisper",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}

fn main() {
    let model_dir = std::env::var("DICT_MODEL_DIR").map_or_else(
        |_| {
            let appdata = std::env::var("APPDATA").expect("APPDATA");
            PathBuf::from(appdata)
                .join("com.winstt.winstt")
                .join("encoder-dict")
        },
        PathBuf::from,
    );
    let model = model_dir.join("model_int8.onnx");
    let tok = model_dir.join("tokenizer.json");
    if !model.is_file() || !tok.is_file() {
        eprintln!(
            "model not found in {}; download it in-app first",
            model_dir.display()
        );
        std::process::exit(2);
    }

    let rank_ks: Vec<f64> = std::env::var("DICT_RANK_KS")
        .unwrap_or_else(|_| "300,600,900,1500".to_string())
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    // Context window per word (Vocabulary tab slider); 220 = default/least. Vary to see the
    // speed/quality tradeoff on the long paragraph.
    let context_bytes: usize = std::env::var("DICT_CONTEXT")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(220);

    let mut engine = EncoderDict::load(&model, &tok).expect("load model");
    engine.warm();
    let terms = dictionary();
    let index = DictIndex::build(&terms);
    let cases = cases();
    let n_pos = cases.iter().filter(|c| c.expect_swap).count();
    let n_neg = cases.len() - n_pos;

    println!(
        "dictionary terms: {}  cases: {} ({} pos / {} neg)\n",
        terms.len(),
        cases.len(),
        n_pos,
        n_neg
    );
    println!(
        "{:>7}  {:>10}  {:>14}  {:>12}",
        "rank_k", "recall", "false-pos", "avg ms"
    );
    println!("{}", "-".repeat(50));

    for &m in &rank_ks {
        // SAFETY: single-threaded harness; the corrector reads WINSTT_DICT_RANK_K per call.
        unsafe { std::env::set_var("WINSTT_DICT_RANK_K", m.to_string()) };
        let mut tp = 0usize;
        let mut fp = 0usize;
        let mut total_ms = 0f64;
        let mut misses: Vec<String> = Vec::new();
        for c in &cases {
            let started = Instant::now();
            let out = engine.correct(c.text, &index, context_bytes);
            let case_ms = started.elapsed().as_secs_f64() * 1000.0;
            total_ms += case_ms;
            if c.text.len() > 200 {
                println!(
                    "   [long-text {:.0} chars] took {case_ms:.0} ms  changed={}",
                    c.text.len(),
                    out != c.text
                );
                if out != c.text {
                    println!("   OUT: {out}");
                }
            }
            let changed = out != c.text;
            if c.expect_swap {
                if out.to_lowercase().contains(&c.expect_term.to_lowercase()) {
                    tp += 1;
                } else {
                    misses.push(format!(
                        "MISS  «{}» → expected {} | got «{out}»",
                        c.text, c.expect_term
                    ));
                }
            } else if changed {
                fp += 1;
                misses.push(format!("FP    «{}» → «{out}»", c.text));
            }
        }
        let recall = tp as f64 / n_pos.max(1) as f64;
        println!(
            "{m:>7.0}  {:>9.0}%  {fp:>8} / {n_neg:<3}  {:>10.1}",
            recall * 100.0,
            total_ms / cases.len() as f64
        );
        for line in misses {
            println!("           {line}");
        }
    }
}
