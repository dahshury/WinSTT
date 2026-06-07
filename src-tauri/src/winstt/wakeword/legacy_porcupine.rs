// ═════════════════════════════════════════════════════════════════════════════
// Legacy pvporcupine 1.9.5 FFI detector — runtime-loaded native handle.
//
//    Mirrors `IWakeWordDetector` for the bundled built-in `.ppn` phrases. The
//    wheel is downloaded/extracted on demand by the manager; this wrapper only
//    validates the files and calls the C API via `libloading`.
// ═════════════════════════════════════════════════════════════════════════════

use std::os::raw::{c_char, c_float, c_int, c_short, c_void};

use libloading::Library;

use super::config::LegacyPorcupinePaths;
use super::presets::normalize_name;
use super::{cstring_path, WakeWordResult};

type PvPorcupineInit = unsafe extern "C" fn(
    *const c_char,
    c_int,
    *const *const c_char,
    *const c_float,
    *mut *mut c_void,
) -> c_int;
type PvPorcupineDelete = unsafe extern "C" fn(*mut c_void);
type PvPorcupineProcess = unsafe extern "C" fn(*mut c_void, *const c_short, *mut c_int) -> c_int;
type PvPorcupineFrameLength = unsafe extern "C" fn() -> c_int;
type PvSampleRate = unsafe extern "C" fn() -> c_int;

/// Runtime-loaded pvporcupine 1.9.5 detector for bundled built-in `.ppn`
/// phrases. The wheel is downloaded/extracted on demand by the manager; this
/// wrapper only validates the files and calls the C API.
pub struct LegacyPorcupineDetector {
    _library: Library,
    handle: *mut c_void,
    delete: PvPorcupineDelete,
    process: PvPorcupineProcess,
    frame_length: usize,
    sample_rate: i32,
    keyword: String,
    pending: Vec<i16>,
}

// The native handle is only touched while the manager holds its detector mutex.
unsafe impl Send for LegacyPorcupineDetector {}

impl LegacyPorcupineDetector {
    pub fn new(
        paths: &LegacyPorcupinePaths,
        keyword: &str,
        sensitivity: f32,
    ) -> anyhow::Result<Self> {
        if !paths.all_present_for_keyword(keyword) {
            anyhow::bail!(
                "legacy Porcupine files for '{}' are incomplete under {}",
                keyword,
                paths.root.display()
            );
        }

        let model = cstring_path(&paths.model())?;
        let keyword_path = cstring_path(&paths.keyword(keyword))?;
        let keyword_paths = [keyword_path.as_ptr()];
        let sensitivities = [sensitivity.clamp(0.0, 1.0) as c_float];

        let library = unsafe { Library::new(paths.library())? };
        let init: PvPorcupineInit = unsafe { *library.get(b"pv_porcupine_init\0")? };
        let delete: PvPorcupineDelete = unsafe { *library.get(b"pv_porcupine_delete\0")? };
        let process: PvPorcupineProcess = unsafe { *library.get(b"pv_porcupine_process\0")? };
        let frame_length_fn: PvPorcupineFrameLength =
            unsafe { *library.get(b"pv_porcupine_frame_length\0")? };
        let sample_rate_fn: PvSampleRate = unsafe { *library.get(b"pv_sample_rate\0")? };

        let mut handle: *mut c_void = std::ptr::null_mut();
        let status = unsafe {
            init(
                model.as_ptr(),
                1,
                keyword_paths.as_ptr(),
                sensitivities.as_ptr(),
                &mut handle,
            )
        };
        if status != 0 || handle.is_null() {
            anyhow::bail!("pv_porcupine_init failed with status {status}");
        }

        let frame_length = unsafe { frame_length_fn() };
        let sample_rate = unsafe { sample_rate_fn() };
        if frame_length <= 0 {
            unsafe { delete(handle) };
            anyhow::bail!("pv_porcupine_frame_length returned {frame_length}");
        }
        if sample_rate != 16_000 {
            unsafe { delete(handle) };
            anyhow::bail!("pv_sample_rate returned {sample_rate}; expected 16000");
        }

        Ok(Self {
            _library: library,
            handle,
            delete,
            process,
            frame_length: frame_length as usize,
            sample_rate,
            keyword: normalize_name(keyword),
            pending: Vec::with_capacity(frame_length as usize * 2),
        })
    }

    pub fn detect(&mut self, chunk: &[f32]) -> WakeWordResult {
        if chunk.is_empty() {
            return WakeWordResult::none();
        }

        self.pending.extend(chunk.iter().map(|sample| {
            let clamped = sample.clamp(-1.0, 1.0);
            (clamped * i16::MAX as f32) as i16
        }));

        let mut consumed = 0usize;
        while self.pending.len().saturating_sub(consumed) >= self.frame_length {
            let frame = &self.pending[consumed..consumed + self.frame_length];
            let mut result = -1;
            let status = unsafe { (self.process)(self.handle, frame.as_ptr(), &mut result) };
            consumed += self.frame_length;
            if status != 0 {
                log::warn!("pv_porcupine_process failed with status {status}");
                break;
            }
            if result >= 0 {
                self.pending.drain(..consumed);
                return WakeWordResult::hit(result, self.keyword.clone());
            }
        }

        if consumed > 0 {
            self.pending.drain(..consumed);
        }
        WakeWordResult::none()
    }

    pub fn reset(&mut self) {
        self.pending.clear();
    }

    pub fn sample_rate(&self) -> i32 {
        self.sample_rate
    }
}

impl Drop for LegacyPorcupineDetector {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { (self.delete)(self.handle) };
            self.handle = std::ptr::null_mut();
        }
    }
}
