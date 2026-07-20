// End-to-end validation of the Rust Cascade+WhoSpeaksLive diarizer against the
// diarization playground's reference clip and ground truth — the same gates the
// playground's `?autotest=1` harness applies (SPEC §10.4):
//
//   * detected speaker count == 2 (exactly),
//   * speaker consistency ≥ 0.80 (majority-mapped labeled time),
//   * boundary F1 ≥ 0.60 with a ±0.5 s matching window (soft floor).
//
// Uses the models already fetched by the playground's `tools/download_models.py`
// (examples/diarization-playground/models/) — no network. Feeds the wav in 30 ms
// chunks like the listen consumer does, processes every ready window, then scores
// the merged timeline against assets/test-2spk.truth.json.
//
// Run:  cargo run --release --example diarize_e2e

use std::path::PathBuf;

use winstt_app_lib::winstt::diarize::CascadeDiarizer;

const SR: usize = 16_000;
const CHUNK: usize = 480; // 30 ms

#[derive(Clone, Copy)]
struct Turn {
    start: f64,
    end: f64,
    speaker: i32,
}

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../examples/diarization-playground");
    // Optional overrides: `diarize_e2e <seg.onnx> <emb.onnx>` (e.g. the hf-hub
    // cached files the in-app toggle resolves) — same gates either way.
    let args: Vec<String> = std::env::args().collect();
    let seg = args.get(1).map_or_else(
        || root.join("models/pyannote-segmentation-3.0.onnx"),
        PathBuf::from,
    );
    let emb = args.get(2).map_or_else(
        || root.join("models/wespeaker_en_voxceleb_resnet34.onnx"),
        PathBuf::from,
    );
    let wav = root.join("assets/test-2spk.wav");
    let truth_path = root.join("assets/test-2spk.truth.json");
    for p in [&seg, &emb, &wav, &truth_path] {
        assert!(
            p.exists(),
            "missing asset: {} (run the playground's tools/download_models.py)",
            p.display()
        );
    }

    // Load wav (16 kHz mono).
    let mut reader = hound::WavReader::open(&wav).expect("open wav");
    let spec = reader.spec();
    assert_eq!(spec.sample_rate, 16_000);
    assert_eq!(spec.channels, 1);
    let pcm: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => reader
            .samples::<i16>()
            .map(|s| s.expect("sample") as f32 / 32768.0)
            .collect(),
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .map(|s| s.expect("sample"))
            .collect(),
    };
    let dur = pcm.len() as f64 / SR as f64;
    println!("clip: {:.1}s", dur);

    // Ground truth.
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

    // Build + drive the engine exactly like the listen consumer: 30 ms chunks.
    let t0 = std::time::Instant::now();
    let mut engine = CascadeDiarizer::new(&seg, &emb).expect("build diarizer");
    println!("engine built+warmed in {:.1}s", t0.elapsed().as_secs_f64());

    let t1 = std::time::Instant::now();
    let mut offset = 0usize;
    while offset < pcm.len() {
        let end = (offset + CHUNK).min(pcm.len());
        engine.accept_audio(&pcm[offset..end], offset as f64 / SR as f64);
        engine.process_ready_windows().expect("process windows");
        offset = end;
    }
    let infer = t1.elapsed().as_secs_f64();
    println!(
        "processed {} windows in {:.1}s (RTF {:.3})",
        engine.windows_processed(),
        infer,
        infer / dur
    );

    let segments = engine.timeline_snapshot();
    let hyp: Vec<Turn> = segments
        .iter()
        .filter(|s| s.speaker >= 0)
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
    let mut labeled = 0.0f64;
    let mut correct_total = 0.0f64;
    let mut t = 0.0f64;
    let mut samples: Vec<(i32, i32)> = Vec::new(); // (truth, hyp) per step, hyp -2 = none
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
    for (ts, hs) in &samples {
        labeled += step;
        if *hs >= 0 && mapping.get(hs) == Some(ts) {
            correct_total += step;
        }
    }
    let consistency = if labeled > 0.0 {
        correct_total / labeled
    } else {
        0.0
    };
    println!("speaker consistency: {:.3}", consistency);

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
    println!(
        "boundary F1: {:.3} (P {:.3} / R {:.3})",
        f1, precision, recall
    );

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
