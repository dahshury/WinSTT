// Offline wakeword benchmark/tuning harness.
//
// Examples:
//   cargo run --release --example wakeword_bench -- --audio ../tools/bench/wakeword-fixtures/sapi --variants fp32,int8 --thresholds 0.10,0.16,0.22,0.28,0.34 --boosts 1,2,3,4
//   cargo run --release --example wakeword_bench -- --audio C:\path\alexa.wav --phrase alexa --variant int8 --thresholds 0.16,0.22 --boosts 2,3

use std::env;
use std::path::{Path, PathBuf};
use std::time::Instant;

use winstt_app_lib::winstt::audio_conditioning::StreamingRmsNormalizer;
use winstt_app_lib::winstt::wakeword::{
    build_keywords_file, keyword_label, tokenize_phrase_for_kws_model, KeywordSpec, KwsModelPaths,
    WakeWordConfig, WakeWordDetector, WakeWordProvider, KWS_BUNDLE_DIRNAME,
};

const SAMPLE_RATE: u32 = 16_000;

#[derive(Clone, Debug)]
struct Args {
    audio: PathBuf,
    bundle: PathBuf,
    boosts: Vec<f32>,
    chunk_samples: usize,
    normalize: bool,
    pad_ms: u32,
    phrase: Option<String>,
    thresholds: Vec<f32>,
    variants: Vec<ModelVariant>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ModelVariant {
    Fp32,
    Int8,
}

#[derive(Clone, Debug)]
struct BenchCase {
    audio: PathBuf,
    phrase: String,
}

#[derive(Debug)]
struct BenchResult {
    audio: String,
    phrase: String,
    variant: ModelVariant,
    threshold: f32,
    boost: f32,
    normalize: bool,
    detected: bool,
    hit_word: String,
    hit_time_s: Option<f32>,
    build_ms: u128,
    run_ms: u128,
    real_time_factor: f32,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args()?;
    let cases = collect_cases(&args)?;

    println!(
        "audio,phrase,variant,threshold,boost,normalize,detected,hit_word,hit_time_s,build_ms,run_ms,rtf"
    );
    for case in cases {
        let mut audio = load_wav_f32_16k(&case.audio)?;
        append_silence(&mut audio, args.pad_ms);
        for variant in &args.variants {
            for threshold in &args.thresholds {
                for boost in &args.boosts {
                    let result = run_case(&args, &case, &audio, *variant, *threshold, *boost)?;
                    print_result(&result);
                }
            }
        }
    }

    Ok(())
}

fn parse_args() -> Result<Args, Box<dyn std::error::Error>> {
    let mut args = Args {
        audio: PathBuf::new(),
        bundle: default_bundle_dir(),
        boosts: vec![3.0],
        chunk_samples: 480,
        normalize: true,
        pad_ms: 1000,
        phrase: None,
        thresholds: vec![0.22],
        variants: vec![ModelVariant::Fp32],
    };

    let mut iter = env::args().skip(1);
    while let Some(flag) = iter.next() {
        match flag.as_str() {
            "--audio" => args.audio = PathBuf::from(next_value(&mut iter, "--audio")?),
            "--bundle" => args.bundle = PathBuf::from(next_value(&mut iter, "--bundle")?),
            "--boosts" => args.boosts = parse_f32_list(&next_value(&mut iter, "--boosts")?)?,
            "--chunk" => {
                args.chunk_samples = next_value(&mut iter, "--chunk")?.parse::<usize>()?;
            }
            "--normalize" => args.normalize = true,
            "--no-normalize" => args.normalize = false,
            "--pad-ms" => {
                args.pad_ms = next_value(&mut iter, "--pad-ms")?.parse::<u32>()?;
            }
            "--phrase" => args.phrase = Some(next_value(&mut iter, "--phrase")?),
            "--thresholds" => {
                args.thresholds = parse_f32_list(&next_value(&mut iter, "--thresholds")?)?;
            }
            "--variant" => {
                args.variants = vec![parse_variant(&next_value(&mut iter, "--variant")?)?];
            }
            "--variants" => {
                args.variants = next_value(&mut iter, "--variants")?
                    .split(',')
                    .map(parse_variant)
                    .collect::<Result<Vec<_>, _>>()?;
            }
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}").into()),
        }
    }

    if args.audio.as_os_str().is_empty() {
        return Err("missing --audio <wav-file-or-directory>".into());
    }
    if args.chunk_samples == 0 {
        return Err("--chunk must be positive".into());
    }
    if args.boosts.is_empty() {
        return Err("--boosts must include at least one value".into());
    }
    if args.thresholds.is_empty() {
        return Err("--thresholds must include at least one value".into());
    }
    if args.variants.is_empty() {
        return Err("--variants must include at least one value".into());
    }
    Ok(args)
}

fn print_help() {
    println!(
        "wakeword_bench --audio <wav-file-or-dir> [--phrase text] [--bundle dir] [--variant fp32|int8] [--variants fp32,int8] [--thresholds csv] [--boosts csv] [--chunk samples] [--pad-ms ms] [--normalize|--no-normalize]"
    );
}

fn next_value(
    iter: &mut impl Iterator<Item = String>,
    flag: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    iter.next()
        .ok_or_else(|| format!("{flag} requires a value").into())
}

fn parse_f32_list(value: &str) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
    value
        .split(',')
        .map(|item| {
            item.trim()
                .parse::<f32>()
                .map_err(|err| format!("invalid float '{item}': {err}").into())
        })
        .collect()
}

fn parse_variant(value: &str) -> Result<ModelVariant, Box<dyn std::error::Error>> {
    match value.trim().to_lowercase().as_str() {
        "fp32" | "float" => Ok(ModelVariant::Fp32),
        "int8" | "quantized" => Ok(ModelVariant::Int8),
        other => Err(format!("unknown model variant '{other}'").into()),
    }
}

fn default_bundle_dir() -> PathBuf {
    env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("com.winstt.winstt")
        .join("wakeword")
        .join(KWS_BUNDLE_DIRNAME)
}

fn collect_cases(args: &Args) -> Result<Vec<BenchCase>, Box<dyn std::error::Error>> {
    let mut paths = Vec::new();
    if args.audio.is_dir() {
        for entry in std::fs::read_dir(&args.audio)? {
            let entry = entry?;
            let path = entry.path();
            if path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("wav"))
            {
                paths.push(path);
            }
        }
        paths.sort();
    } else {
        paths.push(args.audio.clone());
    }

    let mut cases = Vec::new();
    for path in paths {
        let phrase = args
            .phrase
            .clone()
            .unwrap_or_else(|| phrase_from_path(&path));
        cases.push(BenchCase {
            audio: path,
            phrase,
        });
    }
    Ok(cases)
}

fn phrase_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("wakeword")
        .replace('_', " ")
        .to_lowercase()
}

fn load_wav_f32_16k(path: &Path) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    if spec.sample_rate != SAMPLE_RATE {
        return Err(format!(
            "{} has sample rate {}; expected {SAMPLE_RATE}",
            path.display(),
            spec.sample_rate
        )
        .into());
    }
    if spec.channels != 1 {
        return Err(format!(
            "{} has {} channels; expected mono",
            path.display(),
            spec.channels
        )
        .into());
    }

    let audio = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<Vec<_>, _>>()?,
        hound::SampleFormat::Int => {
            let scale = ((1_i64 << (spec.bits_per_sample.saturating_sub(1) as u32)) - 1) as f32;
            if spec.bits_per_sample <= 16 {
                reader
                    .samples::<i16>()
                    .map(|sample| sample.map(|sample| sample as f32 / scale))
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                reader
                    .samples::<i32>()
                    .map(|sample| sample.map(|sample| sample as f32 / scale))
                    .collect::<Result<Vec<_>, _>>()?
            }
        }
    };
    Ok(audio)
}

fn append_silence(audio: &mut Vec<f32>, pad_ms: u32) {
    let samples = SAMPLE_RATE as usize * pad_ms as usize / 1000;
    audio.resize(audio.len() + samples, 0.0);
}

fn run_case(
    args: &Args,
    case: &BenchCase,
    audio: &[f32],
    variant: ModelVariant,
    threshold: f32,
    boost: f32,
) -> Result<BenchResult, Box<dyn std::error::Error>> {
    let model = match variant {
        ModelVariant::Fp32 => KwsModelPaths::from_bundle_dir(&args.bundle),
        ModelVariant::Int8 => KwsModelPaths::from_bundle_dir_int8(&args.bundle),
    };
    if !model.all_present() {
        return Err(format!(
            "{variant:?} model files are incomplete under {}",
            args.bundle.display()
        )
        .into());
    }

    let tokens = tokenize_phrase_for_kws_model(&case.phrase, &model)?;
    let keywords_content = build_keywords_file(&[KeywordSpec {
        tokens,
        label: keyword_label(&case.phrase),
        boost: None,
        threshold: Some(threshold),
    }]);
    let config = WakeWordConfig {
        model,
        keywords_file: None,
        keywords_content: Some(keywords_content),
        keywords: vec![case.phrase.trim().to_lowercase()],
        provider: WakeWordProvider::Cpu,
        sensitivity: 0.6,
        timeout_seconds: 5.0,
        num_threads: Some(1),
        keywords_score: Some(boost),
    };

    let build_start = Instant::now();
    let mut detector = WakeWordDetector::new(&config)?;
    let build_ms = build_start.elapsed().as_millis();

    let run_start = Instant::now();
    let mut hit_word = String::new();
    let mut hit_sample = None;
    let mut normalizer = args.normalize.then(StreamingRmsNormalizer::wakeword);
    for (idx, chunk) in audio.chunks(args.chunk_samples).enumerate() {
        let result = if let Some(normalizer) = normalizer.as_mut() {
            let frame = normalizer.process(chunk);
            detector.detect(&frame.samples)
        } else {
            detector.detect(chunk)
        };
        if result.detected {
            hit_word = result.word;
            hit_sample = Some(((idx + 1) * args.chunk_samples).min(audio.len()));
            break;
        }
    }
    let run_elapsed = run_start.elapsed();
    let audio_seconds = audio.len() as f32 / SAMPLE_RATE as f32;
    let real_time_factor = if audio_seconds > 0.0 {
        run_elapsed.as_secs_f32() / audio_seconds
    } else {
        0.0
    };

    Ok(BenchResult {
        audio: case.audio.display().to_string(),
        phrase: case.phrase.clone(),
        variant,
        threshold,
        boost,
        normalize: args.normalize,
        detected: hit_sample.is_some(),
        hit_word,
        hit_time_s: hit_sample.map(|sample| sample as f32 / SAMPLE_RATE as f32),
        build_ms,
        run_ms: run_elapsed.as_millis(),
        real_time_factor,
    })
}

fn print_result(result: &BenchResult) {
    println!(
        "{},{},{:?},{:.3},{:.3},{},{},{},{},{},{},{:.5}",
        csv(&result.audio),
        csv(&result.phrase),
        result.variant,
        result.threshold,
        result.boost,
        result.normalize,
        result.detected,
        csv(&result.hit_word),
        result
            .hit_time_s
            .map(|value| format!("{value:.3}"))
            .unwrap_or_default(),
        result.build_ms,
        result.run_ms,
        result.real_time_factor
    );
}

fn csv(value: &str) -> String {
    if value.chars().any(|ch| matches!(ch, ',' | '"' | '\n')) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}
