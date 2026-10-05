// End-to-end validation of the Rust Nemotron-3-Diarization engine.
//
// Default mode — the diarization playground's reference clip + ground truth, with the
// gates its `?autotest=1` harness applies (SPEC §10.4):
//
//   * detected speaker count == 2 (exactly),
//   * speaker consistency ≥ 0.80 (majority-mapped labeled time),
//   * boundary F1 ≥ 0.50 with a ±0.5 s matching window.
//
// The wav is fed in 30 ms chunks exactly like the listen consumer (every ready chunk
// processed after each feed, Listen profile), then `finish` scores the tail.
//
// Eval mode — any 16 kHz mono wav → RTTM + one `RESULT` line (RTF, peak working set):
//
//   diarize_e2e --wav in.wav --rttm out.rttm [--profile live|low|offline|C/RC/F/U]
//               [--ep cpu|dml] [--threads N] [--probs out.f32]
//
// Model files: `--model <model.int8.onnx> --constants <constants.npz>`, else the
// hf-hub cache snapshot the in-app toggle downloads (pinned revision) — no network.
// `--ep dml` needs a graph whose Reshapes use `allowzero=0`: the export's dynamo
// Reshapes carry `allowzero=1`, which DirectML rejects (and its dynamic-int8
// MatMuls drift on DML), so the app runs the int8 graph on CPU.
//
// Run:  cargo run --release --example diarize_e2e

use std::path::PathBuf;

use winstt_app_lib::winstt::diarize::{
    CONSTANTS_FILE, MODEL_FILE, MODEL_REPO, MODEL_REVISION, NemotronDiarizer, SpeakerSegment,
    StreamingProfile,
};
use winstt_app_lib::winstt::stt::Accelerator;

const SR: usize = 16_000;
const CHUNK: usize = 480; // 30 ms

#[derive(Clone, Copy)]
struct Turn {
    start: f64,
    end: f64,
    speaker: i32,
}

fn arg(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1).cloned())
}

/// The hf-hub cache snapshot dir of the pinned export revision.
fn cached_snapshot() -> PathBuf {
    let hub = std::env::var_os("HF_HUB_CACHE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HF_HOME").map(|h| PathBuf::from(h).join("hub")))
        .unwrap_or_else(|| {
            let home = std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .expect("home dir");
            PathBuf::from(home).join(".cache/huggingface/hub")
        });
    hub.join(format!("models--{}--{}", MODEL_REPO.0, MODEL_REPO.1))
        .join("snapshots")
        .join(MODEL_REVISION)
}

fn load_wav(path: &PathBuf) -> Vec<f32> {
    let mut reader = hound::WavReader::open(path).expect("open wav");
    let spec = reader.spec();
    assert_eq!(spec.sample_rate, 16_000, "16 kHz input required");
    assert_eq!(spec.channels, 1, "mono input required");
    match spec.sample_format {
        hound::SampleFormat::Int => reader
            .samples::<i16>()
            .map(|s| s.expect("sample") as f32 / 32768.0)
            .collect(),
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .map(|s| s.expect("sample"))
            .collect(),
    }
}

#[cfg(windows)]
fn peak_working_set_mb() -> f64 {
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::GetCurrentProcess;
    let mut c = PROCESS_MEMORY_COUNTERS {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        ..Default::default()
    };
    // SAFETY: plain query of the current process's counters into a sized struct.
    unsafe {
        let _ = GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb);
    }
    c.PeakWorkingSetSize as f64 / (1024.0 * 1024.0)
}

#[cfg(not(windows))]
fn peak_working_set_mb() -> f64 {
    0.0
}

/// Drive the engine like the listen consumer (30 ms feeds, process after each),
/// then score the tail. Returns `(segments, infer_seconds)`.
fn run(engine: &mut NemotronDiarizer, pcm: &[f32]) -> (Vec<SpeakerSegment>, f64) {
    let t = std::time::Instant::now();
    let mut offset = 0usize;
    while offset < pcm.len() {
        let end = (offset + CHUNK).min(pcm.len());
        engine.accept_audio(&pcm[offset..end], offset as f64 / SR as f64);
        engine.process_ready_chunks().expect("process chunks");
        offset = end;
    }
    engine.finish().expect("finish");
    (engine.timeline_snapshot(), t.elapsed().as_secs_f64())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let snapshot = cached_snapshot();
    let model = arg(&args, "--model").map_or_else(|| snapshot.join(MODEL_FILE), PathBuf::from);
    let constants =
        arg(&args, "--constants").map_or_else(|| snapshot.join(CONSTANTS_FILE), PathBuf::from);
    let profile = match arg(&args, "--profile").as_deref() {
        None | Some("live") => StreamingProfile::LIVE,
        Some("low") => StreamingProfile::LOW_LATENCY,
        Some("offline") => StreamingProfile::OFFLINE,
        // Custom geometry for tuning: `chunk/right_context/fifo/update_period`.
        Some(geo) => match geo
            .split('/')
            .map(str::parse::<usize>)
            .collect::<Result<Vec<_>, _>>()
            .as_deref()
        {
            Ok(&[chunk, right_context, fifo, update_period]) => StreamingProfile {
                chunk,
                right_context,
                fifo,
                update_period,
            },
            _ => panic!("unknown --profile {geo} (live|low|offline|C/RC/F/U)"),
        },
    };
    let (ep, accel) = match arg(&args, "--ep").as_deref() {
        None | Some("cpu") => ("cpu", Accelerator::Cpu),
        Some("dml") => ("dml", Accelerator::DirectMl),
        Some(other) => panic!("unknown --ep {other}"),
    };
    let threads: usize = arg(&args, "--threads").map_or(2, |t| t.parse().expect("--threads"));
    for p in [&model, &constants] {
        assert!(
            p.exists(),
            "missing model file: {} (enable diarization once, or pass --model/--constants)",
            p.display()
        );
    }

    let base_ws = peak_working_set_mb();
    let t0 = std::time::Instant::now();
    let mut engine =
        NemotronDiarizer::new(&model, &constants, profile, accel, threads).expect("build engine");
    let load = t0.elapsed().as_secs_f64();
    if arg(&args, "--probs").is_some() {
        engine.record_probabilities(true);
    }

    if let Some(wav) = arg(&args, "--wav").map(PathBuf::from) {
        let pcm = load_wav(&wav);
        let dur = pcm.len() as f64 / SR as f64;
        let (segments, infer) = run(&mut engine, &pcm);
        let uri = wav.file_stem().expect("stem").to_string_lossy().to_string();
        let mut rttm = String::new();
        for s in &segments {
            rttm.push_str(&format!(
                "SPEAKER {uri} 1 {:.3} {:.3} <NA> <NA> spk{} <NA> <NA>\n",
                s.start,
                s.end - s.start,
                s.speaker
            ));
        }
        let out = arg(&args, "--rttm").expect("--rttm <out.rttm>");
        std::fs::write(&out, rttm).expect("write rttm");
        if let Some(path) = arg(&args, "--probs") {
            let bytes: Vec<u8> = engine
                .recorded_probabilities()
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect();
            std::fs::write(path, bytes).expect("write probs");
        }
        println!(
            "RESULT engine=nemotron ep={ep} profile={}/{}/{}/{} threads={threads} dur={dur:.1} load={load:.2} infer={infer:.2} rtf={:.4} peak_ws_mb={:.0} base_ws_mb={base_ws:.0} speakers={}",
            profile.chunk,
            profile.right_context,
            profile.fifo,
            profile.update_period,
            infer / dur,
            peak_working_set_mb(),
            engine.speaker_count()
        );
        return;
    }

    // ── Playground gate mode ──────────────────────────────────────────────────
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../examples/diarization-playground");
    let wav = root.join("assets/test-2spk.wav");
    let truth_path = root.join("assets/test-2spk.truth.json");
    for p in [&wav, &truth_path] {
        assert!(p.exists(), "missing asset: {}", p.display());
    }
    let pcm = load_wav(&wav);
    let dur = pcm.len() as f64 / SR as f64;
    println!("clip: {dur:.1}s, engine built+warmed in {load:.1}s");

    let truth: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&truth_path).expect("read truth"))
            .expect("parse truth");
    let truth_turns: Vec<Turn> = truth["turns"]
        .as_array()
        .expect("turns")
        .iter()
        .map(|t| Turn {
            start: t["start"].as_f64().expect("start"),
            end: t["end"].as_f64().expect("end"),
            speaker: t["speaker"].as_i64().expect("speaker") as i32,
        })
        .collect();

    let (segments, infer) = run(&mut engine, &pcm);
    println!(
        "processed {} chunks in {infer:.2}s (RTF {:.3}, peak working set {:.0} MB)",
        engine.chunks_processed(),
        infer / dur,
        peak_working_set_mb()
    );
    let hyp: Vec<Turn> = segments
        .iter()
        .map(|s| Turn {
            start: s.start,
            end: s.end,
            speaker: s.speaker,
        })
        .collect();

    let speakers: std::collections::BTreeSet<i32> = hyp.iter().map(|t| t.speaker).collect();
    println!("speakers detected: {} {:?}", speakers.len(), speakers);

    // Speaker consistency: majority-map hypothesis ids to truth ids by overlap,
    // then measure the fraction of truth speech time labeled correctly.
    let step = 0.01;
    let mut overlap: std::collections::BTreeMap<(i32, i32), f64> = Default::default();
    let mut samples: Vec<(i32, i32)> = Vec::new(); // (truth, hyp) per step, hyp -2 = none
    let mut t = 0.0f64;
    while t < dur {
        let tt = truth_turns
            .iter()
            .find(|turn| t >= turn.start && t < turn.end)
            .map(|turn| turn.speaker);
        let hh = hyp
            .iter()
            .find(|turn| t >= turn.start && t < turn.end)
            .map(|turn| turn.speaker);
        if let (Some(ts), Some(hs)) = (tt, hh) {
            *overlap.entry((hs, ts)).or_insert(0.0) += step;
            samples.push((ts, hs));
        } else if let Some(ts) = tt {
            samples.push((ts, -2));
        }
        t += step;
    }
    // hyp id → best truth id.
    let mut mapping: std::collections::BTreeMap<i32, i32> = Default::default();
    for (&(hs, ts), &sec) in &overlap {
        let best = mapping
            .get(&hs)
            .map(|&cur| overlap.get(&(hs, cur)).copied().unwrap_or(0.0));
        if best.is_none_or(|b| sec > b) {
            mapping.insert(hs, ts);
        }
    }
    let labeled = samples.len() as f64 * step;
    let correct = samples
        .iter()
        .filter(|(ts, hs)| *hs >= 0 && mapping.get(hs) == Some(ts))
        .count() as f64
        * step;
    let consistency = if labeled > 0.0 {
        correct / labeled
    } else {
        0.0
    };
    println!("speaker consistency: {consistency:.3}");

    // Boundary F1 (±0.5 s matching window).
    let truth_bounds: Vec<f64> = truth_turns.iter().flat_map(|t| [t.start, t.end]).collect();
    let hyp_bounds: Vec<f64> = hyp.iter().flat_map(|t| [t.start, t.end]).collect();
    let tol = 0.5;
    let matched_hyp = hyp_bounds
        .iter()
        .filter(|h| truth_bounds.iter().any(|t| (*t - **h).abs() <= tol))
        .count();
    let matched_truth = truth_bounds
        .iter()
        .filter(|t| hyp_bounds.iter().any(|h| (*h - **t).abs() <= tol))
        .count();
    let precision = matched_hyp as f64 / hyp_bounds.len().max(1) as f64;
    let recall = matched_truth as f64 / truth_bounds.len().max(1) as f64;
    let f1 = if precision + recall > 0.0 {
        2.0 * precision * recall / (precision + recall)
    } else {
        0.0
    };
    println!("boundary F1: {f1:.3} (P {precision:.3} / R {recall:.3})");

    // Gates (SPEC §10.4).
    let mut failures = Vec::new();
    if speakers.len() != 2 {
        failures.push(format!("speaker count {} != 2", speakers.len()));
    }
    if consistency < 0.80 {
        failures.push(format!("consistency {consistency:.3} < 0.80"));
    }
    if f1 < 0.50 {
        failures.push(format!("boundary F1 {f1:.3} < 0.50"));
    }
    if failures.is_empty() {
        println!("E2E_RESULT PASS");
    } else {
        println!("E2E_RESULT FAIL: {}", failures.join("; "));
        std::process::exit(1);
    }
}
