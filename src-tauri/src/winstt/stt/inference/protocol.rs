//! Versioned metadata plus binary f32 PCM. Never serialize audio as JSON.
use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize, de::DeserializeOwned};

use super::super::{EngineConfig, NativeStreamUpdate, TranscribeOptions, Transcription};

pub(super) const VERSION: u32 = 1;
const MAX_METADATA_BYTES: usize = 16 * 1024 * 1024;
pub(super) const MAX_PCM_SAMPLES: usize = 16_000 * 60 * 60 * 2;

#[derive(Serialize, Deserialize)]
pub(super) enum Request {
    Load(EngineConfig),
    Transcribe(TranscribeOptions),
    Warmup(TranscribeOptions),
    StreamAccept,
    StreamFinalize,
    StreamReset,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct LoadedInfo {
    pub providers: Vec<String>,
    pub word_timestamps: bool,
    pub native_streaming: bool,
}

#[derive(Serialize, Deserialize)]
pub(super) enum Response {
    Hello(u32),
    Loaded(LoadedInfo),
    Transcription(Transcription),
    Update(NativeStreamUpdate),
    Text(String),
    Done,
    Error(WireError),
}

#[derive(Serialize, Deserialize)]
pub(super) enum WireError {
    Resolve(String),
    SessionCreate(String),
    Inference(String),
    DegenerateDecode(String),
    Tokenizer(String),
    Unsupported,
}

impl From<super::super::SttError> for WireError {
    fn from(error: super::super::SttError) -> Self {
        use super::super::SttError;
        match error {
            SttError::Resolve(message) => Self::Resolve(message),
            SttError::SessionCreate(message) => Self::SessionCreate(message),
            SttError::Inference(message) => Self::Inference(message),
            SttError::DegenerateDecode(message) => Self::DegenerateDecode(message),
            SttError::Tokenizer(message) => Self::Tokenizer(message),
            SttError::Unsupported(_) => Self::Unsupported,
        }
    }
}

impl From<WireError> for super::super::SttError {
    fn from(error: WireError) -> Self {
        match error {
            WireError::Resolve(message) => Self::Resolve(message),
            WireError::SessionCreate(message) => Self::SessionCreate(message),
            WireError::Inference(message) => Self::Inference(message),
            WireError::DegenerateDecode(message) => Self::DegenerateDecode(message),
            WireError::Tokenizer(message) => Self::Tokenizer(message),
            WireError::Unsupported => {
                Self::Unsupported("operation unsupported by the native inference worker")
            }
        }
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

pub(super) fn encode<T: Serialize>(message: &T, pcm: &[f32]) -> io::Result<Vec<u8>> {
    if pcm.len() > MAX_PCM_SAMPLES {
        return Err(invalid("inference PCM exceeds the two-hour request limit"));
    }
    let metadata = serde_json::to_vec(message)?;
    if metadata.len() > MAX_METADATA_BYTES {
        return Err(invalid("inference metadata exceeds limit"));
    }
    let mut bytes = Vec::with_capacity(8 + metadata.len() + pcm.len() * 4);
    bytes.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&metadata);
    for sample in pcm {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    Ok(bytes)
}

pub(super) fn write<T: Serialize>(writer: &mut impl Write, message: &T) -> io::Result<()> {
    writer.write_all(&encode(message, &[])?)?;
    writer.flush()
}

pub(super) fn read<T: DeserializeOwned>(reader: &mut impl Read) -> io::Result<(T, Vec<f32>)> {
    let mut header = [0; 8];
    reader.read_exact(&mut header)?;
    let metadata_len = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
    let samples = u32::from_le_bytes(header[4..].try_into().unwrap()) as usize;
    if metadata_len > MAX_METADATA_BYTES || samples > MAX_PCM_SAMPLES {
        return Err(invalid("inference frame exceeds limit"));
    }
    let mut metadata = vec![0; metadata_len];
    reader.read_exact(&mut metadata)?;
    let message = serde_json::from_slice(&metadata)?;
    let mut pcm = Vec::with_capacity(samples);
    // Fixed scratch space avoids a second full-size audio allocation.
    let mut scratch = [0u8; 8192];
    while pcm.len() < samples {
        let count = (samples - pcm.len()).min(scratch.len() / 4);
        reader.read_exact(&mut scratch[..count * 4])?;
        pcm.extend(
            scratch[..count * 4]
                .as_chunks::<4>()
                .0
                .iter()
                .map(|&sample| f32::from_le_bytes(sample)),
        );
    }
    Ok((message, pcm))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_pcm_roundtrips_without_changing_bits() {
        let pcm = [0.0, -0.0, 0.25, f32::from_bits(0x7fc01234)];
        let bytes = encode(&Request::StreamAccept, &pcm).unwrap();
        let (request, result) = read::<Request>(&mut bytes.as_slice()).unwrap();
        assert!(matches!(request, Request::StreamAccept));
        assert_eq!(
            pcm.map(f32::to_bits),
            result
                .iter()
                .map(|x| x.to_bits())
                .collect::<Vec<_>>()
                .as_slice()
        );
    }

    #[test]
    fn rejects_oversized_frames_before_allocating() {
        let mut header = [0; 8];
        header[..4].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(read::<Request>(&mut header.as_slice()).is_err());
        header[..4].copy_from_slice(&0u32.to_le_bytes());
        header[4..].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(read::<Request>(&mut header.as_slice()).is_err());
    }

    #[test]
    fn truncated_pcm_is_a_transport_failure() {
        let mut bytes = encode(&Request::StreamAccept, &[0.1]).unwrap();
        bytes.pop();
        assert!(read::<Request>(&mut bytes.as_slice()).is_err());
    }
}
