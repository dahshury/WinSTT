// End-to-end smoke check for the Qwen3-TTS VoiceDesign engine: opens all six ONNX sessions,
// synthesizes one sentence, and writes a 24 kHz mono WAV.
//
// The engine was ported but never run against real weights, and the first real run failed at
// session load with "Protobuf parsing failed" — a truncated download, not a port bug. This
// example is the fastest way to re-confirm both halves (weights intact + inference produces
// audio) without launching the desktop app.
//
//   cargo run --release --example qwen3_tts_check -- <cache_dir> [quant] [text] [voice prompt]
//
// `cache_dir` is the model root holding `cpu_int4/` + config.json/vocab.json/merges.txt, e.g.
// "D:/Necessary programs/WinSTT-portable/Data/tts/qwen3-tts-1.7b-voicedesign".

use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use winstt_app_lib::winstt::downloads::onnx_is_truncated;
use winstt_app_lib::winstt::tts::qwen3_tts::{
    QWEN3TTS_SAMPLE_RATE, Qwen3TtsEngine, Qwen3TtsVoiceMode,
};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(cache_dir) = args.get(1).map(PathBuf::from) else {
        eprintln!("usage: qwen3_tts_check <cache_dir> [quant] [text] [voice prompt]");
        std::process::exit(2);
    };
    let quant = args.get(2).cloned().unwrap_or_else(|| "int4".into());
    let text = args.get(3).cloned().unwrap_or_else(|| {
        "The quick brown fox jumps over the lazy dog, and the download finally finished.".into()
    });
    let voice = args.get(4).cloned().unwrap_or_default();

    // Pre-flight: report any weight that is still short, so a truncation is named here rather
    // than surfacing as an opaque protobuf error from ORT.
    let weights = cache_dir.join(match quant.as_str() {
        "fp16" => "cpu_fp16",
        "fp32" => "cpu_fp32",
        _ => "cpu_int4",
    });
    println!("weights dir: {}", weights.display());
    let mut truncated = false;
    if let Ok(entries) = std::fs::read_dir(&weights) {
        let mut files: Vec<_> = entries.flatten().map(|e| e.path()).collect();
        files.sort();
        for path in files {
            if path.extension().is_none_or(|e| e != "onnx") {
                continue;
            }
            let len = std::fs::metadata(&path).map_or(0, |m| m.len());
            let bad = onnx_is_truncated(&path);
            truncated |= bad;
            println!(
                "  {:<24} {:>13} bytes  {}",
                path.file_name().unwrap_or_default().to_string_lossy(),
                len,
                if bad { "TRUNCATED" } else { "ok" }
            );
        }
    }
    if truncated {
        eprintln!("\nat least one weight is truncated — re-download before trusting this run");
        std::process::exit(1);
    }

    let engine = Qwen3TtsEngine::new(cache_dir, quant, Qwen3TtsVoiceMode::DesignPrompt);

    let t0 = Instant::now();
    if let Err(err) = engine.warm_up() {
        eprintln!("\nwarm_up failed: {err}");
        std::process::exit(1);
    }
    println!("\nsessions loaded in {:.1}s", t0.elapsed().as_secs_f32());

    println!("text : {text}");
    println!(
        "voice: {}",
        if voice.is_empty() {
            "<default>"
        } else {
            &voice
        }
    );
    let t1 = Instant::now();
    let pcm = match engine.synthesize(&text, &voice, "en", 1.0) {
        Ok(pcm) => pcm,
        Err(err) => {
            eprintln!("\nsynthesize failed: {err}");
            std::process::exit(1);
        }
    };
    let elapsed = t1.elapsed().as_secs_f32();

    let seconds = pcm.len() as f32 / QWEN3TTS_SAMPLE_RATE as f32;
    let peak = pcm.iter().fold(0.0f32, |m, &s| m.max(s.abs()));
    let rms = (pcm.iter().map(|s| s * s).sum::<f32>() / pcm.len().max(1) as f32).sqrt();
    println!(
        "\n{} samples = {seconds:.2}s audio in {elapsed:.1}s (RTF {:.2}x), peak {peak:.3}, rms {rms:.4}",
        pcm.len(),
        elapsed / seconds.max(f32::EPSILON)
    );

    if pcm.is_empty() {
        eprintln!("FAIL: no samples produced");
        std::process::exit(1);
    }
    if peak < 1e-4 {
        eprintln!("FAIL: output is silence (peak {peak:.6}) — the graph ran but produced nothing");
        std::process::exit(1);
    }

    let out = std::env::current_dir()
        .unwrap_or_default()
        .join("qwen3_tts_check.wav");
    match write_wav(&out, &pcm, QWEN3TTS_SAMPLE_RATE) {
        Ok(()) => println!("wrote {}", out.display()),
        Err(err) => eprintln!("wav write failed: {err}"),
    }
    println!("\nPASS");
}

/// Minimal 16-bit PCM mono WAV writer (avoids pulling a dep into an example).
fn write_wav(path: &std::path::Path, pcm: &[f32], sample_rate: u32) -> std::io::Result<()> {
    let mut file = std::fs::File::create(path)?;
    let data_len = (pcm.len() * 2) as u32;
    file.write_all(b"RIFF")?;
    file.write_all(&(36 + data_len).to_le_bytes())?;
    file.write_all(b"WAVEfmt ")?;
    file.write_all(&16u32.to_le_bytes())?;
    file.write_all(&1u16.to_le_bytes())?; // PCM
    file.write_all(&1u16.to_le_bytes())?; // mono
    file.write_all(&sample_rate.to_le_bytes())?;
    file.write_all(&(sample_rate * 2).to_le_bytes())?;
    file.write_all(&2u16.to_le_bytes())?;
    file.write_all(&16u16.to_le_bytes())?;
    file.write_all(b"data")?;
    file.write_all(&data_len.to_le_bytes())?;
    for &s in pcm {
        file.write_all(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())?;
    }
    Ok(())
}
