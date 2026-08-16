// Data-layer audio decode + transcript formatting for the file-transcription
// queue. Extracted verbatim from `file_transcribe_manager.rs` so the queue
// manager keeps only queue/lifecycle/pause-resume control logic.
//
// Two concerns live here:
//   1. Audio decode (symphonia: wav/mp3/mp4/aac/flac/ogg/vorbis) + 16 kHz mono
//      resample — `decode_audio_to_pcm` and its accumulation helpers.

use symphonia::core::codecs::CodecParameters;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;

use crate::audio_toolkit::audio::FrameResampler;
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

/// What `decode_media` does when the decoded audio exceeds its sample budget.
#[derive(Clone, Copy, Debug)]
pub(crate) enum SampleLimit {
    /// File transcription: overrunning the budget is a user-visible error, so a
    /// two-hour file fails loudly instead of being silently half-transcribed.
    Error(usize),
    /// Reference clips: stop decoding at the budget and report `trimmed`. The
    /// user picked a song, not a 30 s sample — trimming is the helpful answer.
    Truncate(usize),
}

/// Mono f32 PCM at `sample_rate`, already length-capped per the caller's
/// [`SampleLimit`].
#[derive(Clone, Debug)]
pub(crate) struct DecodedClip {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    /// True when the source ran past the budget and the tail was dropped. The
    /// ORIGINAL duration is deliberately not reported: knowing it would mean
    /// decoding the whole file we just refused to decode.
    pub trimmed: bool,
}

impl DecodedClip {
    pub fn seconds(&self) -> f64 {
        self.samples.len() as f64 / f64::from(self.sample_rate.max(1))
    }
}

/// Decode an audio/video file to mono 16 kHz f32 PCM.
///
/// Faithful port of `server/src/stt_server/file_transcribe.py::_decode_media_to_pcm`,
/// which shells out to `ffmpeg -f f32le -ac 1 -ar 16000`. See [`decode_media`] for
/// the mechanics; this wrapper pins the transcription pipeline's rate + the
/// 60-minute hard error that the file queue's contract depends on.
pub(crate) fn decode_audio_to_pcm(path: &std::path::Path) -> Result<Vec<f32>, String> {
    decode_media(
        path,
        TARGET_SAMPLE_RATE as u32,
        SampleLimit::Error(MAX_DECODED_PCM_SAMPLES),
    )
    .map(|clip| clip.samples)
}

/// Decode a voice-cloning reference clip to mono f32 at the engine's rate,
/// trimming to `max_secs` instead of erroring — see
/// `winstt::tts::catalog::MAX_CLONE_REF_SECS` for why the cap is editorial.
/// `max_secs == 0` means "no trim", falling back to the 60-minute hard limit.
pub(crate) fn decode_reference_clip(
    path: &std::path::Path,
    target_rate: u32,
    max_secs: u32,
) -> Result<DecodedClip, String> {
    let rate = target_rate.max(1) as usize;
    let limit = if max_secs == 0 {
        SampleLimit::Error(rate * MAX_DECODED_AUDIO_MINUTES * 60)
    } else {
        SampleLimit::Truncate(rate.saturating_mul(max_secs as usize))
    };
    decode_media(path, target_rate, limit)
}

/// Decode any symphonia-supported container (wav/mp3/mp4/aac/flac/ogg/vorbis) to
/// mono f32 at `target_rate`, in-process — no external ffmpeg binary: probe the
/// container, decode every packet of the default audio track, downmix to mono by
/// channel averaging, then resample via the project's recording-grade rubato FFT
/// resampler (`FrameResampler`).
///
/// Robust to arbitrary input sample rates and channel layouts. Per-packet
/// `DecodeError`s are skipped (the stream resyncs on the next packet, matching how
/// ffmpeg tolerates a corrupt frame); a clean EOF ends the loop.
pub(crate) fn decode_media(
    path: &std::path::Path,
    target_rate: u32,
    limit: SampleLimit,
) -> Result<DecodedClip, String> {
    let target_rate_usize = target_rate.max(1) as usize;
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

    // Accumulated mono samples at the final target rate. Resample each decoded
    // packet as it arrives so compressed media cannot expand into both a large
    // native-rate buffer and a second resampled buffer.
    let mut pcm: Vec<f32> = Vec::new();
    let mut source_rate: Option<u32> = None;
    let mut resampler: Option<FrameResampler> = None;
    let mut trimmed = false;
    // Scratch buffer reused across packets for the interleaved f32 copy.
    let mut interleaved: Vec<f32> = Vec::new();
    let mut mono_chunk: Vec<f32> = Vec::new();

    loop {
        // Truncating callers stop at the budget: the rest of a 4-minute song is
        // decode work whose output would be discarded.
        if trimmed {
            break;
        }
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
                    if rate as usize != target_rate_usize {
                        let frame_dur = std::time::Duration::from_millis(RESAMPLE_FRAME_MS);
                        resampler = Some(FrameResampler::try_new(
                            rate as usize,
                            target_rate_usize,
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
                    append_decoded_mono(
                        &mut pcm,
                        &mut resampler,
                        &interleaved,
                        limit,
                        &mut trimmed,
                    )?;
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
                    append_decoded_mono(
                        &mut pcm,
                        &mut resampler,
                        &mono_chunk,
                        limit,
                        &mut trimmed,
                    )?;
                }
            }
            // A single corrupt packet is recoverable — skip it and resync on the
            // next one (the decoder clears its internal buffer on error).
            Err(SymError::DecodeError(_)) => continue,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(format!("decode error: {e}")),
        }
    }

    // A truncated decode has nothing left to drain, and the resampler's zero pad
    // would only append synthetic silence past the cap.
    if let Some(resampler) = &mut resampler
        && !trimmed
    {
        let mut limit_error = None;
        resampler.finish(|frame| {
            if limit_error.is_none() {
                limit_error = append_pcm_limited(&mut pcm, frame, limit, &mut trimmed).err();
            }
        });
        if let Some(error) = limit_error {
            return Err(error);
        }
    }

    if pcm.is_empty() {
        return Err("file contained no decodable audio".to_string());
    }

    Ok(DecodedClip {
        samples: pcm,
        sample_rate: target_rate,
        trimmed,
    })
}

fn append_decoded_mono(
    pcm: &mut Vec<f32>,
    resampler: &mut Option<FrameResampler>,
    mono: &[f32],
    limit: SampleLimit,
    trimmed: &mut bool,
) -> Result<(), String> {
    let Some(resampler) = resampler else {
        return append_pcm_limited(pcm, mono, limit, trimmed);
    };

    let mut limit_error = None;
    resampler.push(mono, |frame| {
        if limit_error.is_none() {
            limit_error = append_pcm_limited(pcm, frame, limit, trimmed).err();
        }
    });
    if let Some(error) = limit_error {
        return Err(error);
    }
    Ok(())
}

fn append_pcm_limited(
    pcm: &mut Vec<f32>,
    samples: &[f32],
    limit: SampleLimit,
    trimmed: &mut bool,
) -> Result<(), String> {
    match limit {
        SampleLimit::Error(max) => append_pcm_limited_with_max(pcm, samples, max),
        SampleLimit::Truncate(max) => {
            let room = max.saturating_sub(pcm.len());
            if samples.len() > room {
                *trimmed = true;
            }
            pcm.extend_from_slice(&samples[..room.min(samples.len())]);
            Ok(())
        }
    }
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

    #[test]
    fn truncate_keeps_the_head_and_reports_trimming() {
        let mut pcm = vec![0.0; 3];
        let mut trimmed = false;

        let result = append_pcm_limited(
            &mut pcm,
            &[1.0, 2.0, 3.0],
            SampleLimit::Truncate(5),
            &mut trimmed,
        );

        assert_eq!(result, Ok(()));
        assert_eq!(pcm, vec![0.0, 0.0, 0.0, 1.0, 2.0]);
        assert!(trimmed, "dropping the tail must be reported");
    }

    #[test]
    fn truncate_under_budget_does_not_report_trimming() {
        let mut pcm = Vec::new();
        let mut trimmed = false;

        append_pcm_limited(
            &mut pcm,
            &[1.0, 2.0],
            SampleLimit::Truncate(5),
            &mut trimmed,
        )
        .expect("under budget");

        assert_eq!(pcm, vec![1.0, 2.0]);
        assert!(!trimmed);
    }

    /// Once full, later frames must be dropped rather than pushed past the cap
    /// (the decode loop breaks on `trimmed`, but the in-flight resampler frames
    /// still drain through this callback).
    #[test]
    fn truncate_drops_everything_after_the_budget_is_full() {
        let mut pcm = vec![0.0; 5];
        let mut trimmed = false;

        append_pcm_limited(&mut pcm, &[9.0], SampleLimit::Truncate(5), &mut trimmed)
            .expect("saturated budget is not an error");

        assert_eq!(pcm.len(), 5);
        assert!(trimmed);
    }

    #[test]
    fn error_mode_still_fails_loudly() {
        let mut pcm = vec![0.0; 3];
        let mut trimmed = false;

        let result = append_pcm_limited(
            &mut pcm,
            &[1.0, 2.0, 3.0],
            SampleLimit::Error(5),
            &mut trimmed,
        );

        assert_eq!(result, Err(decoded_audio_limit_error()));
        assert!(!trimmed);
        assert_eq!(pcm, vec![0.0, 0.0, 0.0]);
    }

    /// Why `tts_transcribe_reference` does not re-validate a clip's length.
    ///
    /// `tts_prepare_reference_clip` stores a trimmed clip at EXACTLY the cap
    /// (24 kHz), because `SampleLimit::Truncate` fills the buffer to `max` and
    /// then skips the `finish()` drain. Re-decoding that stored file to 16 kHz
    /// runs a second resampler which DOES drain — a zero-padded frame through the
    /// FFT delay line plus the trailing partial frame — so it emits MORE than
    /// `cap * 16_000` samples. Measuring the same audio twice and comparing the
    /// two numbers therefore refused every clip the preparer had just accepted
    /// ("Reference clip is 30s — please use one under 30s."). A budget of exactly
    /// the cap would instead cut real audio, which is why the transcribe path
    /// truncates one second past it.
    #[test]
    fn re_decoding_a_clip_stored_at_the_cap_measures_longer_than_the_cap() {
        const CAP_SECS: usize = 30;
        let stored = vec![0.1_f32; 24_000 * CAP_SECS];
        let mut out: Vec<f32> = Vec::new();
        let mut resampler = FrameResampler::try_new(
            24_000,
            TARGET_SAMPLE_RATE,
            std::time::Duration::from_millis(RESAMPLE_FRAME_MS),
        )
        .expect("24k -> 16k resampler");
        resampler.push(&stored, |frame| out.extend_from_slice(frame));
        resampler.finish(|frame| out.extend_from_slice(frame));

        assert!(
            out.len() > TARGET_SAMPLE_RATE * CAP_SECS,
            "re-decoding a clip stored at the cap must overshoot it: {} samples",
            out.len()
        );
        assert!(
            out.len() <= TARGET_SAMPLE_RATE * (CAP_SECS + 1),
            "one second of headroom must absorb the pad: {} samples",
            out.len()
        );
    }

    #[test]
    fn decoded_clip_reports_seconds_at_its_own_rate() {
        let clip = DecodedClip {
            samples: vec![0.0; 48_000],
            sample_rate: 24_000,
            trimmed: true,
        };
        assert!((clip.seconds() - 2.0).abs() < f64::EPSILON);
    }
}
