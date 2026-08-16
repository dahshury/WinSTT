// EXPERIMENT 3 — honest per-rung latency for `chatterbox-multilingual`, measured through the
// SHIPPING `TtsEngine` adapter (`ChatterboxLocalEngine`), all rungs back-to-back in ONE
// process so the box state is shared rather than compared across sessions.
//
//   cargo run --release --example cbx_gate_latency -- <model_id> <reps> <voice> "<text>" <q1,q2,..>
//
// Differences from `tts_engine_bench` (which does exactly one cold + one warm rep):
//   * session LOAD is timed on its own via `TtsEngine::warm_up()` (it only builds the four
//     ORT sessions; it runs no synthesis), so load is never folded into the first synth;
//   * `reps` synthesis passes per rung. Rep 0 is NOT warm — `ensure_ref_conditioning` caches
//     the speech-encoder run per (path, mtime) and rep 0 pays it — so rep 0 is reported
//     separately and only reps 1.. feed the median/spread;
//   * resident-set is sampled on a background thread for the whole run, so each rung gets a
//     peak-RSS window and a post-drop floor;
//   * one generated codec token is 960 samples at 24 kHz (25 Hz codec x 24 kHz), so the
//     token count is recovered exactly from the returned sample count and ms/token is
//     reported next to the end-to-end RTF. The AR backbone and the rung-INVARIANT fp32
//     `conditional_decoder` are not separable through this adapter — that split comes from
//     `cbx_probe_rung`; what IS separable here is that fp16 and fp32 emit bit-identical
//     token streams, so equal token counts mean equal decoder work and the fp16-vs-fp32
//     wall-clock delta is pure backbone.
//
// Model dirs: `WINSTT_TTS_CACHE`/<model_id> (the box's real cache is
// %LOCALAPPDATA%\winstt\tts, NOT the repo `.tts-cache`, which is empty).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use winstt_app_lib::winstt::tts::local_engines::ChatterboxLocalEngine;
use winstt_app_lib::winstt::tts::{SentenceAudio, TtsEngine};

const DEFAULT_SENTENCE: &str = "The quick brown fox jumps over the lazy dog.";
/// S3 codec: 25 tokens/s rendered at 24 kHz.
const SAMPLES_PER_TOKEN: usize = 960;

fn cache_root() -> PathBuf {
    std::env::var("WINSTT_TTS_CACHE").map_or_else(
        |_| {
            PathBuf::from(std::env::var("LOCALAPPDATA").expect("LOCALAPPDATA"))
                .join("winstt")
                .join("tts")
        },
        PathBuf::from,
    )
}

fn ensure_espeak() {
    if std::env::var_os("ESPEAK_NG_LIBRARY").is_none()
        && let Some(lib) = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|local| {
                local
                    .join("winstt")
                    .join("tts")
                    .join("runtime")
                    .join("espeakng_loader")
                    .join("espeak-ng.dll")
            })
            .filter(|lib| lib.exists())
    {
        // SAFETY: set before any TTS engine thread is started.
        unsafe { std::env::set_var("ESPEAK_NG_LIBRARY", lib) };
    }
}

/// Own-process resident set, sampled on a background thread. `peak` is monotonic across the
/// whole run; `reset_peak` re-anchors it to the current reading at a rung boundary so each
/// rung reports its own window.
struct RssSampler {
    peak: Arc<AtomicU64>,
    current: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
}

impl RssSampler {
    fn start() -> Self {
        let peak = Arc::new(AtomicU64::new(0));
        let current = Arc::new(AtomicU64::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (p, c, s) = (peak.clone(), current.clone(), stop.clone());
        std::thread::spawn(move || {
            let mut sys = sysinfo::System::new();
            let Ok(pid) = sysinfo::get_current_pid() else {
                return;
            };
            let pids = [pid];
            while !s.load(Ordering::Relaxed) {
                sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&pids), false);
                if let Some(proc) = sys.process(pid) {
                    let m = proc.memory();
                    c.store(m, Ordering::Relaxed);
                    p.fetch_max(m, Ordering::Relaxed);
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        });
        // Let the first sample land so a rung boundary never reads 0.
        std::thread::sleep(Duration::from_millis(500));
        Self {
            peak,
            current,
            stop,
        }
    }
    fn now_mb(&self) -> f64 {
        self.current.load(Ordering::Relaxed) as f64 / (1024.0 * 1024.0)
    }
    fn peak_mb(&self) -> f64 {
        self.peak.load(Ordering::Relaxed) as f64 / (1024.0 * 1024.0)
    }
    fn reset_peak(&self) {
        self.peak
            .store(self.current.load(Ordering::Relaxed), Ordering::Relaxed);
    }
}

impl Drop for RssSampler {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn stats(samples: &[f32]) -> (f32, f32, usize) {
    let mut peak = 0.0f32;
    let mut sumsq = 0.0f64;
    let mut nan = 0usize;
    for &s in samples {
        if s.is_nan() {
            nan += 1;
            continue;
        }
        peak = peak.max(s.abs());
        sumsq += f64::from(s) * f64::from(s);
    }
    let rms = if samples.is_empty() {
        0.0
    } else {
        (sumsq / samples.len() as f64).sqrt() as f32
    };
    (peak, rms, nan)
}

/// Median of an already-cloneable slice (mean of the two middles on even counts, so a
/// 4-warm-rep run does not silently pick a side).
fn median(v: &[f64]) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    let n = s.len();
    if n % 2 == 1 {
        s[n / 2]
    } else {
        (s[n / 2 - 1] + s[n / 2]) / 2.0
    }
}

fn run_rung(model_id: &str, quant: &str, voice: &str, text: &str, reps: usize, rss: &RssSampler) {
    println!("\n########## RUNG {quant} ##########");
    rss.reset_peak();
    let rss_before = rss.now_mb();

    let engine = ChatterboxLocalEngine::new(cache_root().join(model_id), model_id, quant);

    let t_load = Instant::now();
    if let Err(e) = engine.warm_up() {
        println!("LOAD quant={quant} FAILED: {e}");
        return;
    }
    let load_ms = t_load.elapsed().as_secs_f64() * 1000.0;
    let rss_loaded = rss.now_mb();
    println!(
        "LOAD quant={quant} load_ms={load_ms:.0} rss_before_mb={rss_before:.0} \
         rss_after_load_mb={rss_loaded:.0} delta_mb={:.0}",
        rss_loaded - rss_before
    );

    let mut warm_wall: Vec<f64> = Vec::new();
    let mut warm_rtf: Vec<f64> = Vec::new();
    let mut warm_mspt: Vec<f64> = Vec::new();
    let mut tokens_seen = 0usize;

    for rep in 0..reps {
        let t = Instant::now();
        let out = engine.synthesize_sentence(text, voice, "en", 1.0);
        let wall_ms = t.elapsed().as_secs_f64() * 1000.0;
        let Ok(SentenceAudio::F32le {
            samples,
            sample_rate,
        }) = out
        else {
            println!("GEN quant={quant} rep={rep} FAILED");
            return;
        };
        let dur_s = samples.len() as f64 / f64::from(sample_rate);
        let tokens = samples.len() / SAMPLES_PER_TOKEN;
        let rtf = wall_ms / 1000.0 / dur_s;
        let mspt = if tokens == 0 {
            f64::NAN
        } else {
            wall_ms / tokens as f64
        };
        let (peak, rms, nan) = stats(&samples);
        let kind = if rep == 0 { "cond" } else { "warm" };
        println!(
            "GEN quant={quant} rep={rep} kind={kind} wall_ms={wall_ms:.0} samples={} \
             dur_s={dur_s:.3} tokens={tokens} rtf={rtf:.3} ms_per_tok_e2e={mspt:.1} \
             peak={peak:.3} rms={rms:.4} nan={nan} rss_mb={:.0}",
            samples.len(),
            rss.now_mb()
        );
        if rep > 0 {
            warm_wall.push(wall_ms);
            warm_rtf.push(rtf);
            warm_mspt.push(mspt);
            tokens_seen = tokens;
        }
    }

    let rung_peak = rss.peak_mb();
    let lo = warm_wall.iter().copied().fold(f64::INFINITY, f64::min);
    let hi = warm_wall.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let med_wall = median(&warm_wall);
    println!(
        "SUMMARY quant={quant} n_warm={} tokens={tokens_seen} load_ms={load_ms:.0} \
         wall_median_ms={med_wall:.0} wall_min_ms={lo:.0} wall_max_ms={hi:.0} \
         spread_pct={:.1} rtf_median={:.3} rtf_min={:.3} rtf_max={:.3} \
         ms_per_tok_e2e_median={:.1} peak_rss_mb={rung_peak:.0}",
        warm_wall.len(),
        if med_wall > 0.0 {
            (hi - lo) / med_wall * 100.0
        } else {
            f64::NAN
        },
        median(&warm_rtf),
        warm_rtf.iter().copied().fold(f64::INFINITY, f64::min),
        warm_rtf.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        median(&warm_mspt),
    );

    engine.shutdown();
    drop(engine);
    // Give the allocator a moment to return the graph arenas before the next rung anchors.
    std::thread::sleep(Duration::from_secs(3));
    println!("AFTER-DROP quant={quant} rss_mb={:.0}", rss.now_mb());
}

/// ROUND-ROBIN mode. The sequential mode above measures one rung to completion before the
/// next starts, which on this box is not safe: the contention witness shows the competing
/// load swinging between 36% and 100% of 24 cores on a ~1 min timescale, so a rung measured
/// at 17:16 and a rung measured at 17:25 are not comparable no matter how many reps each
/// gets. Here every rung is held loaded at once and one rep of EACH is taken per round, so
/// all rungs see the same box conditions to within seconds. Round 0 is the conditioning
/// round (`ensure_ref_conditioning` runs the speech encoder once per engine) and is excluded.
///
/// RSS is deliberately NOT reported per rung here — three loaded engines share the process —
/// that number comes from the sequential mode.
fn run_interleaved(
    model_id: &str,
    quants: &[String],
    voice: &str,
    text: &str,
    rounds: usize,
    rss: &RssSampler,
) {
    let mut engines: Vec<(String, ChatterboxLocalEngine)> = Vec::new();
    for q in quants {
        let e = ChatterboxLocalEngine::new(cache_root().join(model_id), model_id, q);
        let t = Instant::now();
        if let Err(err) = e.warm_up() {
            println!("LOAD quant={q} FAILED: {err}");
            return;
        }
        println!(
            "LOAD quant={q} load_ms={:.0} rss_after_load_mb={:.0} (cumulative: earlier rungs \
             stay resident in this mode)",
            t.elapsed().as_secs_f64() * 1000.0,
            rss.now_mb()
        );
        engines.push((q.clone(), e));
    }

    let mut per_rung: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let mut tokens: BTreeMap<String, usize> = BTreeMap::new();
    for round in 0..rounds {
        for (q, e) in &engines {
            let t = Instant::now();
            let out = e.synthesize_sentence(text, voice, "en", 1.0);
            let wall_ms = t.elapsed().as_secs_f64() * 1000.0;
            let Ok(SentenceAudio::F32le {
                samples,
                sample_rate,
            }) = out
            else {
                println!("RR quant={q} round={round} FAILED");
                return;
            };
            let dur_s = samples.len() as f64 / f64::from(sample_rate);
            let tok = samples.len() / SAMPLES_PER_TOKEN;
            let (peak, rms, nan) = stats(&samples);
            println!(
                "RR quant={q} round={round} kind={} wall_ms={wall_ms:.0} tokens={tok} \
                 dur_s={dur_s:.3} rtf={:.3} ms_per_tok_e2e={:.1} peak={peak:.3} rms={rms:.4} nan={nan}",
                if round == 0 { "cond" } else { "warm" },
                wall_ms / 1000.0 / dur_s,
                wall_ms / tok as f64,
            );
            if round > 0 {
                per_rung.entry(q.clone()).or_default().push(wall_ms);
                tokens.insert(q.clone(), tok);
            }
        }
    }

    for (q, w) in &per_rung {
        let med = median(w);
        let lo = w.iter().copied().fold(f64::INFINITY, f64::min);
        let hi = w.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let tok = tokens[q];
        let dur_s = tok as f64 * f64::from(SAMPLES_PER_TOKEN as u32) / 24_000.0;
        println!(
            "RRSUMMARY quant={q} n_warm={} tokens={tok} wall_median_ms={med:.0} \
             wall_min_ms={lo:.0} wall_max_ms={hi:.0} spread_pct={:.1} rtf_median={:.3} \
             ms_per_tok_e2e_median={:.1} all_ms={:?}",
            w.len(),
            (hi - lo) / med * 100.0,
            med / 1000.0 / dur_s,
            med / tok as f64,
            w.iter().map(|x| x.round() as i64).collect::<Vec<_>>(),
        );
    }

    for (_, e) in &engines {
        e.shutdown();
    }
    engines.clear();
}

fn main() {
    ensure_espeak();
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("interleave") {
        let model_id = args
            .get(2)
            .cloned()
            .unwrap_or_else(|| "chatterbox-multilingual".into());
        let rounds: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(5);
        let voice = args.get(4).cloned().unwrap_or_else(|| "default".into());
        let text = args
            .get(5)
            .cloned()
            .unwrap_or_else(|| DEFAULT_SENTENCE.into());
        let quants: Vec<String> = args
            .get(6)
            .cloned()
            .unwrap_or_else(|| "q4,fp16,fp32".into())
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        println!(
            "GATE-RR model={model_id} rounds={rounds} voice={voice} quants={quants:?} \
             cache={} text={text:?}",
            cache_root().display()
        );
        let rss = RssSampler::start();
        let t_all = Instant::now();
        run_interleaved(&model_id, &quants, &voice, &text, rounds, &rss);
        println!(
            "\nGATE-RR done total_s={:.1} process_peak_rss_mb={:.0} (ALL rungs resident)",
            t_all.elapsed().as_secs_f64(),
            rss.peak_mb()
        );
        return;
    }
    let model_id = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| "chatterbox-multilingual".into());
    let reps: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(4);
    let voice = args.get(3).cloned().unwrap_or_else(|| "default".into());
    let text = args
        .get(4)
        .cloned()
        .unwrap_or_else(|| DEFAULT_SENTENCE.into());
    let quants: Vec<String> = args
        .get(5)
        .cloned()
        .unwrap_or_else(|| "q4,fp16,fp32".into())
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();

    println!(
        "GATE model={model_id} reps={reps} voice={voice} quants={quants:?} cache={} text={text:?}",
        cache_root().display()
    );

    let rss = RssSampler::start();
    println!("RSS baseline_mb={:.0}", rss.now_mb());

    let t_all = Instant::now();
    for q in &quants {
        run_rung(&model_id, q, &voice, &text, reps, &rss);
    }
    println!(
        "\nGATE done total_s={:.1} process_peak_rss_mb={:.0}",
        t_all.elapsed().as_secs_f64(),
        rss.peak_mb()
    );
}
