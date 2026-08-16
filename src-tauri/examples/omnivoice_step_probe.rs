// OmniVoice STAGE-0 probe — the cheap-disproof harness that decides the port.
//
// NOT shipped. `cargo run --release --example omnivoice_step_probe`.
//
// Answers three questions before any engine logic exists:
//   A   session commits, the 2.45 GB external `.data` resolves, I/O signature matches
//   A½  is export (A)'s attention actually BIDIRECTIONAL? (perturb a LATER target frame,
//       diff an EARLIER frame's logits — if it changes, bidirectional; if bit-identical,
//       the graph masks causally and the 2.45 GB hybrid rationale collapses)
//   C½  wall time of ONE step at a realistic `L` with `B = 2` (the CFG-doubled batch),
//       times 32 steps -> real-time factor. This is the product go/no-go.
//
// Also measures the split-batch alternative (conditional `B=1 seq=L` + unconditional
// `B=1 seq=F`) which is strictly cheaper than one `B=2 seq=L` pass.
//
// Model files (override the dir with WINSTT_OMNIVOICE_DIR):
//   omnivoice_step.onnx  +  omnivoice_step.data   (tritueviet/omnivoice-webgpu-assets)

use std::path::PathBuf;
use std::time::Instant;

use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::Tensor;

const CODEBOOKS: usize = 8;
const MASK_ID: i64 = 1024;
const FRAME_RATE: f64 = 25.0;
const NUM_STEP: usize = 32;

fn model_dir() -> PathBuf {
    std::env::var("WINSTT_OMNIVOICE_DIR")
        .map_or_else(|_| PathBuf::from("E:/DL/omnivoice-probe"), PathBuf::from)
}

/// One decode-shaped input set: `[B,8,L]` ids, `[B,L]` audio mask, `[B,1,L,L]` attention.
struct StepInputs {
    batch: usize,
    seq: usize,
    ids: Vec<i64>,
    audio: Vec<bool>,
    attn: Vec<bool>,
}

impl StepInputs {
    /// Build the conditional-only (`B=1`) or CFG (`B=2`) tensors for
    /// prefix `p`, reference frames `r`, target frames `f`.
    fn build(batch: usize, p: usize, r: usize, f: usize) -> Self {
        let seq = p + r + f;
        let mut ids = vec![MASK_ID; batch * CODEBOOKS * seq];
        // row 0: text prefix replicated across all 8 rows, then real ref codes, then masks.
        for t in 0..p {
            for c in 0..CODEBOOKS {
                ids[c * seq + t] = 100 + (t as i64 % 4000);
            }
        }
        for t in 0..r {
            for c in 0..CODEBOOKS {
                ids[c * seq + p + t] = ((t * 7 + c * 131) % 1024) as i64;
            }
        }
        let mut audio = vec![false; batch * seq];
        for slot in audio.iter_mut().take(seq).skip(p) {
            *slot = true;
        }
        let mut attn = vec![false; batch * seq * seq];
        for row in 0..seq {
            for col in 0..seq {
                attn[row * seq + col] = true;
            }
        }
        if batch == 2 {
            // row 1 = the target block alone at position 0, rest inert.
            for t in 0..f {
                audio[seq + t] = true;
            }
            for row in 0..f {
                for col in 0..f {
                    attn[seq * seq + row * seq + col] = true;
                }
            }
            for pos in f..seq {
                attn[seq * seq + pos * seq + pos] = true;
            }
        }
        Self {
            batch,
            seq,
            ids,
            audio,
            attn,
        }
    }

    fn run(&self, sess: &mut Session) -> ort::Result<(Vec<i64>, Vec<f32>)> {
        let ids = Tensor::from_array((
            [self.batch, CODEBOOKS, self.seq],
            self.ids.clone().into_boxed_slice(),
        ))?;
        let audio = Tensor::from_array((
            [self.batch, self.seq],
            self.audio.clone().into_boxed_slice(),
        ))?;
        let attn = Tensor::from_array((
            [self.batch, 1, self.seq, self.seq],
            self.attn.clone().into_boxed_slice(),
        ))?;
        let out = sess.run(ort::inputs! {
            "input_ids" => ids,
            "audio_mask" => audio,
            "attention_mask" => attn,
        })?;
        let (shape, data) = out["logits"].try_extract_tensor::<f32>()?;
        Ok((shape.to_vec(), data.to_vec()))
    }
}

/// Time every config round-robin so no single config absorbs the page-fault cost of
/// the 2.45 GB weight file, then report the MINIMUM per config. This box runs other
/// workloads; contention and paging only ever ADD time, so min is the closest
/// estimator of the true warm cost. Returns min seconds per config, same order.
fn timed_roundrobin(
    sess: &mut Session,
    configs: &[(&str, &StepInputs)],
    rounds: usize,
) -> Vec<f64> {
    // Warm-up: touch every config once, untimed, so the weight pages and MLAS
    // prepacked buffers are resident before the first measurement.
    for (label, inp) in configs {
        if let Err(e) = inp.run(sess) {
            println!("    [{label}] WARMUP FAILED: {e}");
        }
    }
    let mut times: Vec<Vec<f64>> = vec![Vec::with_capacity(rounds); configs.len()];
    for _ in 0..rounds {
        for (i, (label, inp)) in configs.iter().enumerate() {
            let t0 = Instant::now();
            match inp.run(sess) {
                Ok(_) => times[i].push(t0.elapsed().as_secs_f64()),
                Err(e) => {
                    println!("    [{label}] RUN FAILED: {e}");
                    times[i].push(f64::NAN);
                }
            }
        }
    }
    let mut out = Vec::with_capacity(configs.len());
    for (i, (label, inp)) in configs.iter().enumerate() {
        let mut t = times[i].clone();
        t.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let min = t.first().copied().unwrap_or(f64::NAN);
        let med = t[t.len() / 2];
        let max = t[t.len() - 1];
        println!(
            "    [{label}] B={} L={} -> min {min:.3}s  median {med:.3}s  max {max:.3}s  (n={rounds})",
            inp.batch, inp.seq
        );
        out.push(min);
    }
    out
}

fn main() {
    let dir = model_dir();
    let step = dir.join("omnivoice_step.onnx");
    let data = dir.join("omnivoice_step.data");
    println!("== OmniVoice Stage-0 probe ==");
    println!("dir   : {}", dir.display());
    for p in [&step, &data] {
        match std::fs::metadata(p) {
            Ok(m) => println!("file  : {} = {} B", p.display(), m.len()),
            Err(e) => {
                println!("MISSING {}: {e}", p.display());
                return;
            }
        }
    }
    println!(
        "threads: available_parallelism = {}",
        std::thread::available_parallelism().map_or(0, |n| n.get())
    );

    // ---- Gate A: session commits, external data resolves ----
    let want_dml = std::env::var("OMNIVOICE_EP").is_ok_and(|v| v.eq_ignore_ascii_case("dml"));
    let threads: Option<usize> = std::env::var("OMNIVOICE_THREADS")
        .ok()
        .and_then(|v| v.parse().ok());
    println!(
        "ep     : {}  threads: {threads:?}",
        if want_dml { "DirectML" } else { "CPU" }
    );

    let t0 = Instant::now();
    let build = || -> ort::Result<Session> {
        let mut builder =
            Session::builder()?.with_optimization_level(GraphOptimizationLevel::Level3)?;
        if let Some(n) = threads {
            builder = builder.with_intra_threads(n)?;
        }
        #[cfg(windows)]
        if want_dml {
            builder = builder.with_memory_pattern(false)?;
            builder = builder.with_execution_providers([ort::ep::DirectML::default().build()])?;
        }
        builder.commit_from_file(&step)
    };
    let mut sess = match build() {
        Ok(s) => s,
        Err(e) => {
            println!("GATE A FAIL: commit_from_file: {e}");
            return;
        }
    };
    println!(
        "GATE A PASS: session committed in {:.2}s",
        t0.elapsed().as_secs_f64()
    );
    for i in sess.inputs() {
        println!("  in  {} {:?}", i.name(), i.dtype());
    }
    for o in sess.outputs() {
        println!("  out {} {:?}", o.name(), o.dtype());
    }

    // ---- Gate A½: bidirectional or causal? ----
    // Small L so this is cheap. P=12 prefix, no reference, F=24 target frames.
    let (p, r, f) = (12usize, 0usize, 24usize);
    let base = StepInputs::build(1, p, r, f);
    let seq = base.seq;
    let t0_pos = p; // FIRST target frame
    let t1_pos = seq - 1; // LAST target frame (strictly later)
    let mut mutated = StepInputs::build(1, p, r, f);
    for c in 0..CODEBOOKS {
        mutated.ids[c * seq + t1_pos] = ((c * 97 + 13) % 1024) as i64;
    }
    match (base.run(&mut sess), mutated.run(&mut sess)) {
        (Ok((_, a)), Ok((_, b))) => {
            let row = |v: &[f32], c: usize, t: usize| -> Vec<f32> {
                let off = (c * seq + t) * 1025;
                v[off..off + 1025].to_vec()
            };
            let mut max_delta = 0f32;
            for c in 0..CODEBOOKS {
                let ra = row(&a, c, t0_pos);
                let rb = row(&b, c, t0_pos);
                for (x, y) in ra.iter().zip(rb.iter()) {
                    max_delta = max_delta.max((x - y).abs());
                }
            }
            // Control: the mutated position itself must always change.
            let mut ctrl = 0f32;
            for c in 0..CODEBOOKS {
                let ra = row(&a, c, t1_pos);
                let rb = row(&b, c, t1_pos);
                for (x, y) in ra.iter().zip(rb.iter()) {
                    ctrl = ctrl.max((x - y).abs());
                }
            }
            println!(
                "GATE A-half: perturb t={t1_pos}, observe t={t0_pos}: max|dlogit| = {max_delta:.6e}  (control at t={t1_pos}: {ctrl:.6e})"
            );
            println!(
                "  => attention is {}",
                if max_delta > 1e-6 {
                    "BIDIRECTIONAL (earlier position sees later frame) -- hybrid rationale HOLDS"
                } else {
                    "CAUSAL (earlier position blind to later frame) -- hybrid rationale COLLAPSES"
                }
            );
        }
        _ => println!("GATE A-half: run failed"),
    }

    // ---- Gate C½: real timing at realistic L ----
    let passes: usize = std::env::var("OMNIVOICE_PASSES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);
    // Scenarios: (label, prefix tokens, reference frames, target seconds)
    let scenarios: &[(&str, usize, usize, f64)] = &[
        ("no-ref / 3s target", 30, 0, 3.0),
        ("3s ref / 3s target", 42, 75, 3.0),
        ("10s ref / 3s target", 60, 250, 3.0),
        ("12.5s golden ref / 3s target", 90, 313, 3.0),
    ];
    let only: Option<usize> = std::env::var("OMNIVOICE_SCENARIO")
        .ok()
        .and_then(|v| v.parse().ok());
    println!("\n== GATE C-half: one step timed, x{NUM_STEP} steps ==");
    for (i, (label, p, r, secs)) in scenarios.iter().enumerate() {
        if only.is_some_and(|k| k != i) {
            continue;
        }
        let f = ((secs + 0.25) * FRAME_RATE).round().max(1.0) as usize;
        println!("\n  {label}: P={p} R={r} F={f} L={}", p + r + f);
        let cfg = StepInputs::build(2, *p, *r, f);
        let cond = StepInputs::build(1, *p, *r, f);
        let uncond = StepInputs::build(1, 0, 0, f);
        let t = timed_roundrobin(
            &mut sess,
            &[
                ("CFG B=2", &cfg),
                ("cond  B=1 L", &cond),
                ("uncond B=1 F", &uncond),
            ],
            passes,
        );
        let (wcfg, wc, wu) = (t[0], t[1], t[2]);
        let rtf = |step_secs: f64| step_secs * NUM_STEP as f64 / secs;
        println!(
            "    => CFG B=2      {NUM_STEP} steps = {:6.2}s for {secs:.1}s audio  ==>  RTF {:5.2}x realtime",
            wcfg * NUM_STEP as f64,
            rtf(wcfg)
        );
        println!(
            "    => split-batch  {NUM_STEP} steps = {:6.2}s                  ==>  RTF {:5.2}x realtime  ({:+.0}% vs CFG B=2)",
            (wc + wu) * NUM_STEP as f64,
            rtf(wc + wu),
            100.0 * ((wc + wu) / wcfg - 1.0)
        );
        println!(
            "    => no-CFG floor {NUM_STEP} steps = {:6.2}s                  ==>  RTF {:5.2}x realtime",
            wc * NUM_STEP as f64,
            rtf(wc)
        );
    }
}
