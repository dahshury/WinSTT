// Data-layer audio decode + transcript formatting for the file-transcription
// queue. Extracted verbatim from `file_transcribe_manager.rs` so the queue
// manager keeps only queue/lifecycle/pause-resume control logic.
//
// Two concerns live here:
//   1. Audio decode (symphonia: wav/mp3/mp4/aac/flac/ogg/vorbis) + 16 kHz mono
//      resample — `decode_audio_to_pcm` and its accumulation helpers.
//   2. Transcript serialization (txt/srt) — `format_transcript` /
//      `format_srt_timestamp`.

use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;

use crate::audio_toolkit::audio::FrameResampler;
use crate::winstt::settings_schema::FileTranscriptionFormat;

// ── Transcript serialization (txt / srt) ─────────────────────────────────────

pub(crate) fn format_transcript(
    format: FileTranscriptionFormat,
    text: &str,
    duration_secs: f64,
) -> String {
    match format {
        FileTranscriptionFormat::Txt => {
            let mut body = text.trim_end().to_string();
            body.push('\n');
            body
        }
        FileTranscriptionFormat::Srt => {
            let end = format_srt_timestamp(duration_secs.max(0.001));
            format!("1\n00:00:00,000 --> {end}\n{}\n", text.trim())
        }
    }
}

fn format_srt_timestamp(seconds: f64) -> String {
    let total_ms = (seconds * 1000.0).round().max(1.0) as u64;
    let ms = total_ms % 1000;
    let total_seconds = total_ms / 1000;
    let s = total_seconds % 60;
    let total_minutes = total_seconds / 60;
    let m = total_minutes % 60;
    let h = total_minutes / 60;
    format!("{h:02}:{m:02}:{s:02},{ms:03}")
}

// ── Audio decode (symphonia → 16 kHz mono f32) ───────────────────────────────

/// The transcription pipeline (mic, loopback, file) is 16 kHz mono f32 PCM — the
/// same rate every onnx-asr preprocessor targets, so the model's own resampler is
/// a no-op. Mirrors `_TARGET_SAMPLE_RATE` in `server/.../file_transcribe.py`.
pub(crate) const TARGET_SAMPLE_RATE: usize = 16_000;

/// Upper bound for one-shot file transcription. The STT path still transcribes a
/// single in-memory PCM buffer, so decoded audio must be bounded independently of
/// compressed file size.
const MAX_DECODED_AUDIO_MINUTES: usize = 60;
const MAX_DECODED_PCM_SAMPLES: usize = TARGET_SAMPLE_RATE * MAX_DECODED_AUDIO_MINUTES * 60;

/// Frame size the resampler emits in (30 ms @ 16 kHz). Chosen to match the
/// recorder/loopback frame cadence; the last partial frame is zero-padded on
/// `finish()` (≤30 ms of trailing silence, trimmed by VAD before transcription).
const RESAMPLE_FRAME_MS: u64 = 30;

/// Decode an audio/video file to mono 16 kHz f32 PCM.
///
/// Faithful port of `server/src/stt_server/file_transcribe.py::_decode_media_to_pcm`,
/// which shells out to `ffmpeg -f f32le -ac 1 -ar 16000`. Here we decode in-process
/// with symphonia (wav/mp3/mp4/aac/flac/ogg/vorbis) so no external ffmpeg binary is
/// required: probe the container, decode every packet of the default audio track,
/// downmix to mono, then resample to 16 kHz via the project's recording-grade
/// `FftFixedIn` resampler (`FrameResampler`).
///
/// Robust to arbitrary input sample rates and channel layouts. Per-packet
/// `DecodeError`s are skipped (the stream resyncs on the next packet, matching how
/// ffmpeg tolerates a corrupt frame); a clean EOF ends the loop.
pub(crate) fn decode_audio_to_pcm(path: &std::path::Path) -> Result<Vec<f32>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("cannot open file: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());

    // Hint the probe with the file extension — cheap disambiguation for the
    // signature scan (e.g. raw ADTS/AAC streams that share magic with others).
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|e| format!("unsupported or unreadable media: {e}"))?;

    // Pick the default audio track (the container may also carry video/subtitle
    // tracks for .mp4/.mkv inputs — we want the audio stream only). Extract owned
    // values in a scope so the immutable borrow of `format` is released before the
    // mutable `next_packet()` loop below.
    let (track_id, audio_params) = {
        let track = format
            .default_track(TrackType::Audio)
            .ok_or_else(|| "no audio track found in file".to_string())?;
        let params = match &track.codec_params {
            Some(CodecParameters::Audio(p)) => p.clone(),
            _ => return Err("audio track has no codec parameters".to_string()),
        };
        (track.id, params)
    };

    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&audio_params, &AudioDecoderOptions::default())
        .map_err(|e| format!("no decoder for audio codec: {e}"))?;

    // Accumulated mono samples at the final 16 kHz target rate. Resample each
    // decoded packet as it arrives so compressed media cannot expand into both a
    // large native-rate buffer and a second resampled buffer.
    let mut pcm: Vec<f32> = Vec::new();
    let mut source_rate: Option<u32> = None;
    let mut resampler: Option<FrameResampler> = None;
    // Scratch buffer reused across packets for the interleaved f32 copy.
    let mut interleaved: Vec<f32> = Vec::new();
    let mut mono_chunk: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            // Clean end of stream.
            Ok(None) => break,
            // Some demuxers signal EOF as an UnexpectedEof IoError rather than
            // `Ok(None)`; treat it as a normal end of stream.
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => {
                // Track list changed mid-stream (e.g. chained OGG). We only handle
                // the initial track; stop cleanly with what we have.
                break;
            }
            Err(e) => return Err(format!("error reading packet: {e}")),
        };

        // Skip packets that don't belong to our chosen audio track.
        if packet.track_id != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = decoded.spec();
                if source_rate.is_none() {
                    let rate = spec.rate();
                    source_rate = Some(rate);
                    if rate as usize != TARGET_SAMPLE_RATE {
                        let frame_dur = std::time::Duration::from_millis(RESAMPLE_FRAME_MS);
                        resampler = Some(FrameResampler::try_new(
                            rate as usize,
                            TARGET_SAMPLE_RATE,
                            frame_dur,
                        )?);
                    }
                } else if source_rate != Some(spec.rate()) {
                    return Err("audio stream changed sample rate mid-file".to_string());
                }
                let channels = spec.channels().count().max(1);
                let frames = decoded.frames();
                if frames == 0 {
                    continue;
                }

                // Copy the decoded buffer to interleaved f32 (handles any source
                // sample format — i16/i32/f32/etc — via symphonia's conversion).
                decoded.copy_to_vec_interleaved::<f32>(&mut interleaved);

                if channels <= 1 {
                    append_decoded_mono(&mut pcm, &mut resampler, &interleaved)?;
                } else {
                    // Downmix to mono by averaging channels (matches the Python
                    // FileAudioSource `np.mean(arr, axis=1)` / ffmpeg `-ac 1`).
                    mono_chunk.clear();
                    mono_chunk.reserve(frames);
                    let inv = 1.0 / channels as f32;
                    for frame in interleaved.chunks_exact(channels) {
                        let sum: f32 = frame.iter().copied().sum();
                        mono_chunk.push(sum * inv);
                    }
                    append_decoded_mono(&mut pcm, &mut resampler, &mono_chunk)?;
                }
            }
            // A single corrupt packet is recoverable — skip it and resync on the
            // next one (the decoder clears its internal buffer on error).
            Err(SymError::DecodeError(_)) => continue,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(format!("decode error: {e}")),
        }
    }

    if let Some(resampler) = &mut resampler {
        let mut limit_error = None;
        resampler.finish(|frame| {
            if limit_error.is_none() {
                limit_error = append_pcm_limited(&mut pcm, frame).err();
            }
        });
        if let Some(error) = limit_error {
            return Err(error);
        }
    }

    if pcm.is_empty() {
        return Err("file contained no decodable audio".to_string());
    }

    Ok(pcm)
}

fn append_decoded_mono(
    pcm: &mut Vec<f32>,
    resampler: &mut Option<FrameResampler>,
    mono: &[f32],
) -> Result<(), String> {
    let Some(resampler) = resampler else {
        return append_pcm_limited(pcm, mono);
    };

    let mut limit_error = None;
    resampler.push(mono, |frame| {
        if limit_error.is_none() {
            limit_error = append_pcm_limited(pcm, frame).err();
        }
    });
    if let Some(error) = limit_error {
        return Err(error);
    }
    Ok(())
}

fn append_pcm_limited(pcm: &mut Vec<f32>, samples: &[f32]) -> Result<(), String> {
    append_pcm_limited_with_max(pcm, samples, MAX_DECODED_PCM_SAMPLES)
}

fn append_pcm_limited_with_max(
    pcm: &mut Vec<f32>,
    samples: &[f32],
    max_samples: usize,
) -> Result<(), String> {
    if pcm.len().saturating_add(samples.len()) > max_samples {
        return Err(decoded_audio_limit_error());
    }
    pcm.extend_from_slice(samples);
    Ok(())
}

fn decoded_audio_limit_error() -> String {
    format!(
        "decoded audio exceeds the {MAX_DECODED_AUDIO_MINUTES}-minute file transcription limit; split the file into shorter clips"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_pcm_limited_with_max_allows_exact_limit() {
        let mut pcm = vec![0.0; 3];
        let samples = [1.0, 2.0];

        let result = append_pcm_limited_with_max(&mut pcm, &samples, 5);

        assert!(result.is_ok());
        assert_eq!(pcm, vec![0.0, 0.0, 0.0, 1.0, 2.0]);
    }

    #[test]
    fn append_pcm_limited_with_max_rejects_over_limit_without_extending() {
        let mut pcm = vec![0.0; 3];
        let samples = [1.0, 2.0, 3.0];

        let result = append_pcm_limited_with_max(&mut pcm, &samples, 5);

        assert_eq!(result, Err(decoded_audio_limit_error()));
        assert_eq!(pcm, vec![0.0, 0.0, 0.0]);
    }
}
