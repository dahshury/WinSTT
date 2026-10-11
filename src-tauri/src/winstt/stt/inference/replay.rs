//! Preserve streaming input boundaries with a small memory budget and an anonymous spool.
//! Long listening sessions remain continuous; only recovery has a bounded time budget.
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};

const MEMORY_SAMPLES: usize = 256 * 1024;

#[derive(Default)]
pub(super) struct ReplayLog {
    // None records finalization; Some records an accept, including an empty accept.
    frames: Vec<Option<Vec<f32>>>,
    file: Option<File>,
    samples: usize,
    records: usize,
}

fn write_frame(file: &mut File, pcm: Option<&[f32]>) -> io::Result<()> {
    let Some(pcm) = pcm else {
        return file.write_all(&u32::MAX.to_le_bytes());
    };
    let count = u32::try_from(pcm.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "stream frame too large"))?;
    file.write_all(&count.to_le_bytes())?;
    let mut buffer = [0u8; 8192];
    for samples in pcm.chunks(buffer.len() / 4) {
        for (bytes, sample) in buffer.chunks_exact_mut(4).zip(samples) {
            bytes.copy_from_slice(&sample.to_le_bytes());
        }
        file.write_all(&buffer[..samples.len() * 4])?;
    }
    Ok(())
}

impl ReplayLog {
    pub(super) fn samples(&self) -> usize {
        self.samples
    }

    pub(super) fn append(&mut self, pcm: &[f32]) -> io::Result<()> {
        self.append_event(Some(pcm))
    }

    pub(super) fn append_finalize(&mut self) -> io::Result<()> {
        self.append_event(None)
    }

    fn append_event(&mut self, event: Option<&[f32]>) -> io::Result<()> {
        let pcm = event.unwrap_or_default();
        if pcm.len() > super::protocol::MAX_PCM_SAMPLES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "stream frame exceeds request limit",
            ));
        }
        if self.file.is_none()
            && (self.samples.saturating_add(pcm.len()) > MEMORY_SAMPLES
                || self.frames.len() >= 4096)
        {
            // tempfile() unlinks on Unix and uses delete-on-close on Windows. Audio is
            // never left in a named persistent recording, including on crashes.
            let mut file = tempfile::tempfile()?;
            for frame in &self.frames {
                write_frame(&mut file, frame.as_deref())?;
            }
            self.file = Some(file);
            self.frames.clear();
            self.frames.shrink_to_fit();
        }
        if let Some(file) = self.file.as_mut() {
            file.seek(SeekFrom::End(0))?;
            write_frame(file, event)?;
        } else {
            self.frames.push(event.map(<[f32]>::to_vec));
        }
        self.samples = self.samples.saturating_add(pcm.len());
        self.records += 1;
        Ok(())
    }

    pub(super) fn for_each<E>(
        &mut self,
        mut consume: impl FnMut(Option<&[f32]>) -> Result<(), E>,
    ) -> Result<(), E>
    where
        E: From<io::Error>,
    {
        if let Some(file) = self.file.as_mut() {
            file.seek(SeekFrom::Start(0))?;
            let mut frame = Vec::new();
            let mut scratch = [0u8; 8192];
            for _ in 0..self.records {
                let mut header = [0; 4];
                file.read_exact(&mut header)?;
                let count = u32::from_le_bytes(header) as usize;
                if count == u32::MAX as usize {
                    consume(None)?;
                    continue;
                }
                if count > super::protocol::MAX_PCM_SAMPLES {
                    return Err(
                        io::Error::new(io::ErrorKind::InvalidData, "invalid replay frame").into(),
                    );
                }
                frame.clear();
                while frame.len() < count {
                    let samples = (count - frame.len()).min(scratch.len() / 4);
                    file.read_exact(&mut scratch[..samples * 4])?;
                    frame.extend(
                        scratch[..samples * 4]
                            .chunks_exact(4)
                            .map(|sample| f32::from_le_bytes(sample.try_into().unwrap())),
                    );
                }
                consume(Some(&frame))?;
            }
        } else {
            for frame in &self.frames {
                consume(frame.as_deref())?;
            }
        }
        Ok(())
    }

    pub(super) fn clear(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finalization_and_empty_accept_remain_distinct_when_spooled() {
        let mut replay = ReplayLog::default();
        replay.append(&[]).unwrap();
        replay.append_finalize().unwrap();
        replay.append(&vec![0.5; MEMORY_SAMPLES + 1]).unwrap();
        replay.append_finalize().unwrap();
        let mut events = vec![];
        replay
            .for_each::<io::Error>(|frame| {
                events.push(frame.map(<[f32]>::len));
                Ok(())
            })
            .unwrap();
        assert_eq!(events, [Some(0), None, Some(MEMORY_SAMPLES + 1), None]);
    }

    #[test]
    fn spilling_preserves_frame_boundaries_and_allows_append_after_replay() {
        let mut replay = ReplayLog::default();
        replay.append(&[0.25]).unwrap();
        replay.append(&vec![0.5; MEMORY_SAMPLES]).unwrap();
        assert!(replay.file.is_some());
        let mut lengths = vec![];
        replay
            .for_each::<io::Error>(|frame| {
                lengths.push(frame.unwrap().len());
                Ok(())
            })
            .unwrap();
        assert_eq!(lengths, [1, MEMORY_SAMPLES]);
        replay.append(&[0.75]).unwrap();
        let mut last = vec![];
        replay
            .for_each::<io::Error>(|frame| {
                last = frame.unwrap().to_vec();
                Ok(())
            })
            .unwrap();
        assert_eq!(last, [0.75]);
        replay.clear();
        assert_eq!(replay.samples(), 0);
        assert!(replay.file.is_none());
    }
}
