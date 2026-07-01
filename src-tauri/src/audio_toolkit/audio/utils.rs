use anyhow::Result;
use hound::{WavReader, WavSpec, WavWriter};
use log::debug;
use std::path::Path;

/// Read a WAV file and return normalised f32 samples.
pub fn read_wav_samples<P: AsRef<Path>>(file_path: P) -> Result<Vec<f32>> {
    let reader = WavReader::open(file_path.as_ref())?;
    let samples = reader
        .into_samples::<i16>()
        .map(|s| s.map(|v| v as f32 / i16::MAX as f32))
        .collect::<Result<Vec<f32>, _>>()?;
    Ok(samples)
}

/// Playback duration of a WAV file in milliseconds, read from the header alone.
///
/// Cheap: `hound` parses the RIFF/`fmt`/`data` headers on `open`, so `len()`
/// (total interleaved samples, derived from the `data` chunk size) and `spec()`
/// are available without streaming the audio body. Returns `None` when the file
/// is missing/corrupt or carries a zero sample rate, so callers can fall back to
/// "unknown" (0) rather than fail. Used to populate history `durationMs` from the
/// saved recording, including for rows written before duration was tracked.
pub fn wav_duration_ms<P: AsRef<Path>>(file_path: P) -> Option<u64> {
    let reader = WavReader::open(file_path.as_ref()).ok()?;
    let spec = reader.spec();
    let channels = u64::from(spec.channels.max(1));
    let sample_rate = u64::from(spec.sample_rate);
    if sample_rate == 0 {
        return None;
    }
    // `len()` counts interleaved samples across all channels; divide out channels
    // to get frames, then scale frames→ms. Mono 16 kHz recordings make this exact.
    Some(u64::from(reader.len()) * 1000 / (channels * sample_rate))
}

/// Verify a WAV file by reading it back and checking the sample count.
pub fn verify_wav_file<P: AsRef<Path>>(file_path: P, expected_samples: usize) -> Result<()> {
    let reader = WavReader::open(file_path.as_ref())?;
    let actual_samples = reader.len() as usize;
    if actual_samples != expected_samples {
        anyhow::bail!(
            "WAV sample count mismatch: expected {}, got {}",
            expected_samples,
            actual_samples
        );
    }
    Ok(())
}

/// Save audio samples as a WAV file
pub fn save_wav_file<P: AsRef<Path>>(file_path: P, samples: &[f32]) -> Result<()> {
    let spec = WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = WavWriter::create(file_path.as_ref(), spec)?;

    // Convert f32 samples to i16 for WAV
    for sample in samples {
        let sample_i16 = (sample * i16::MAX as f32) as i16;
        writer.write_sample(sample_i16)?;
    }

    writer.finalize()?;
    debug!("Saved WAV file: {:?}", file_path.as_ref());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_then_read_roundtrips_within_i16_epsilon() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("roundtrip.wav");
        let samples = [0.0_f32, 0.5, -0.5, 1.0, -1.0, 0.25];
        save_wav_file(&path, &samples).unwrap();
        let back = read_wav_samples(&path).unwrap();
        assert_eq!(back.len(), samples.len());
        for (orig, got) in samples.iter().zip(back.iter()) {
            // i16 quantization step is 1/32767 ~= 3.05e-5.
            assert!(
                (orig - got).abs() < 2e-4,
                "f32->i16->f32 within quantization: {orig} vs {got}"
            );
        }
    }

    #[test]
    fn verify_wav_file_matches_and_rejects_count() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("count.wav");
        let samples = vec![0.1_f32; 320];
        save_wav_file(&path, &samples).unwrap();
        assert!(verify_wav_file(&path, 320).is_ok());
        assert!(
            verify_wav_file(&path, 321).is_err(),
            "wrong sample count is an error"
        );
    }

    #[test]
    fn read_missing_file_is_err() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does_not_exist.wav");
        assert!(read_wav_samples(&missing).is_err());
        assert!(verify_wav_file(&missing, 0).is_err());
    }

    #[test]
    fn wav_duration_ms_matches_sample_count_at_16khz() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dur.wav");
        // 16_000 mono samples @ 16 kHz == exactly 1000 ms.
        save_wav_file(&path, &vec![0.0_f32; 16_000]).unwrap();
        assert_eq!(wav_duration_ms(&path), Some(1000));

        // 8_000 samples == half a second.
        let half = dir.path().join("half.wav");
        save_wav_file(&half, &vec![0.0_f32; 8_000]).unwrap();
        assert_eq!(wav_duration_ms(&half), Some(500));
    }

    #[test]
    fn wav_duration_ms_missing_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(wav_duration_ms(dir.path().join("nope.wav")), None);
    }
}
