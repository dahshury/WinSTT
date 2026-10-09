// End-to-end check for Qwen3-TTS Base zero-shot cloning through the SHIPPING adapter
// (`Qwen3TtsLocalEngine` in `CloneReference` mode — the same clip decode, reference cap,
// encoder pass and prompt the app runs). Synthesizes every line of a sentence file in the
// voice of one reference clip and writes `<out_dir>/NN.wav` (24 kHz mono), printing the
// per-sentence and overall CPU real-time factor.
//
//   cargo run --release --example qwen3_tts_clone_check -- \
//       <cache_dir> <ref_clip> <out_dir> <sentences.txt> [quant] [ref_text_file]
//
// `cache_dir` is the model root holding `cpu_<quant>/` (all eight graphs) + config.json /
// vocab.json / merges.txt, named after its catalog id (e.g. `.../qwen3-tts-0.6b-base`) so
// the row's reference cap applies. Without `ref_text_file` the clone is x-vector-only; with
// it, the ICL prompt (reference codes + transcript) is used. WER / speaker similarity are
// measured on the written WAVs by an external ASR / speaker-verification model.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use winstt_app_lib::winstt::tts::catalog;
use winstt_app_lib::winstt::tts::local_engines::Qwen3TtsLocalEngine;
use winstt_app_lib::winstt::tts::qwen3_tts::{QWEN3TTS_SAMPLE_RATE, Qwen3TtsVoiceMode};
use winstt_app_lib::winstt::tts::{SentenceAudio, TtsEngine};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        eprintln!(
            "usage: qwen3_tts_clone_check <cache_dir> <ref_clip> <out_dir> <sentences.txt> \
             [quant] [ref_text_file]"
        );
        std::process::exit(2);
    }
    let cache_dir = PathBuf::from(&args[1]);
    let ref_clip = args[2].clone();
    let out_dir = PathBuf::from(&args[3]);
    let sentences: Vec<String> = std::fs::read_to_string(&args[4])
        .expect("read sentences file")
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    let quant = args.get(5).cloned().unwrap_or_else(|| "int4".into());
    let ref_text = args
        .get(6)
        .map(|p| {
            std::fs::read_to_string(p)
                .expect("read ref text")
                .trim()
                .to_string()
        })
        .unwrap_or_default();
    let model_id = cache_dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    std::fs::create_dir_all(&out_dir).expect("create out dir");

    let engine =
        Qwen3TtsLocalEngine::new(cache_dir, quant.clone(), Qwen3TtsVoiceMode::CloneReference)
            .with_clone_reference(
                ref_text.clone(),
                catalog::reference_clip_cap_secs(&model_id),
            );
    println!(
        "model {model_id} quant {quant} mode {}",
        if ref_text.is_empty() {
            "x-vector"
        } else {
            "icl"
        }
    );

    let t0 = Instant::now();
    if let Err(err) = engine.warm_up() {
        eprintln!("warm_up failed: {err}");
        std::process::exit(1);
    }
    println!("sessions loaded in {:.1}s", t0.elapsed().as_secs_f32());

    let (mut warm_secs, mut warm_audio) = (0.0f32, 0.0f32);
    for (i, text) in sentences.iter().enumerate() {
        let t = Instant::now();
        let pcm = match engine.synthesize_sentence(text, &ref_clip, "en", 1.0) {
            Ok(SentenceAudio::F32le { samples, .. }) => samples,
            Ok(_) => panic!("unexpected audio container"),
            Err(err) => {
                eprintln!("sentence {i} failed: {err}");
                std::process::exit(1);
            }
        };
        let elapsed = t.elapsed().as_secs_f32();
        let secs = pcm.len() as f32 / QWEN3TTS_SAMPLE_RATE as f32;
        let peak = pcm.iter().fold(0.0f32, |m, &s| m.max(s.abs()));
        // Sentence 0 also pays the one-off reference preparation (both encoders).
        if i > 0 {
            warm_secs += elapsed;
            warm_audio += secs;
        }
        println!(
            "[{i:02}] {secs:5.2}s audio in {elapsed:6.1}s (RTF {:.2}){}  peak {peak:.3}",
            elapsed / secs.max(f32::EPSILON),
            if i == 0 { " incl. reference prep" } else { "" }
        );
        if pcm.is_empty() || peak < 1e-4 {
            eprintln!("FAIL: sentence {i} produced silence");
            std::process::exit(1);
        }
        write_wav(
            &out_dir.join(format!("{i:02}.wav")),
            &pcm,
            QWEN3TTS_SAMPLE_RATE,
        )
        .expect("write wav");
    }
    if warm_audio > 0.0 {
        println!(
            "warm RTF {:.2} over {} sentences ({warm_audio:.1}s audio)",
            warm_secs / warm_audio,
            sentences.len() - 1
        );
    }
    println!("PASS");
}

/// Minimal 16-bit PCM mono WAV writer (avoids pulling a dep into an example).
fn write_wav(path: &Path, pcm: &[f32], sample_rate: u32) -> std::io::Result<()> {
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
