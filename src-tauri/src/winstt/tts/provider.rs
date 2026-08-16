use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;

use super::types::TtsDevice;
use crate::winstt::stt::{
    Accelerator, configure_session, num_cpus_best_effort, pick_intra_op_threads, provider_label,
};

/// Generic lazy-load holder shared by every in-process ONNX TTS engine.
///
/// The five local engines (Kokoro/Kitten/Piper/Supertonic/Chatterbox) all wrap
/// their loaded ONNX state (`L`) behind a `Mutex<Option<L>>` + a `ready`
/// `AtomicBool`, and all spell the same `is_ready`/`shutdown`/lazy-init preamble.
/// This holder factors that skeleton out while leaving each engine's `L` type,
/// `load()` builder and `synthesize()` body untouched. `E` is each engine's own
/// error type — supplied per call via closures so the holder stays error-agnostic.
pub(crate) struct LazyOrtEngine<L> {
    loaded: Mutex<Option<L>>,
    ready: AtomicBool,
}

impl<L> LazyOrtEngine<L> {
    pub(crate) fn new() -> Self {
        Self {
            loaded: Mutex::new(None),
            ready: AtomicBool::new(false),
        }
    }

    /// True once a `load()` has succeeded (mirrors the old per-engine `ready`).
    pub(crate) fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    /// Read-only access to the loaded state (or `None`); used by
    /// `active_providers()` which only needs to clone a field.
    pub(crate) fn with_ref<T>(&self, f: impl FnOnce(&L) -> T) -> Option<T> {
        self.loaded.lock().ok().and_then(|g| g.as_ref().map(f))
    }

    /// Force the load NOW (idempotent). `lock_err` builds the poison error, `load`
    /// builds the engine's `L`. Matches the old `warm_up`: when already loaded it
    /// returns `Ok(())` without re-running `load` or re-storing `ready`.
    pub(crate) fn warm_up<E>(
        &self,
        lock_err: impl FnOnce() -> E,
        load: impl FnOnce() -> Result<L, E>,
    ) -> Result<(), E> {
        let mut guard = self.loaded.lock().map_err(|_| lock_err())?;
        if guard.is_none() {
            *guard = Some(load()?);
            self.ready.store(true, Ordering::Release);
        }
        Ok(())
    }

    /// Lock, lazily `load` if not yet initialized, then run `f` against the loaded
    /// state. `lock_err`/`not_init_err` build the engine's errors for the poisoned
    /// and never-initialized branches. Mirrors the old `synthesize` preamble.
    pub(crate) fn with_loaded<T, E>(
        &self,
        lock_err: impl Fn() -> E,
        not_init_err: impl FnOnce() -> E,
        load: impl FnOnce() -> Result<L, E>,
        f: impl FnOnce(&mut L) -> Result<T, E>,
    ) -> Result<T, E> {
        let mut guard = self.loaded.lock().map_err(|_| lock_err())?;
        if guard.is_none() {
            *guard = Some(load()?);
            self.ready.store(true, Ordering::Release);
        }
        let Some(loaded) = guard.as_mut() else {
            return Err(not_init_err());
        };
        f(loaded)
    }

    /// Drop the loaded state (idempotent) and clear `ready`. Byte-identical to the
    /// old per-engine `shutdown`.
    pub(crate) fn shutdown(&self) {
        if let Ok(mut guard) = self.loaded.lock() {
            *guard = None;
        }
        self.ready.store(false, Ordering::Release);
    }
}

/// Build a **CPU-only** ORT session for an engine that has not validated DirectML
/// yet. `reason` is logged when a non-CPU device was requested; `engine` is the
/// log label. Returns `Err(String)` so each engine can wrap it in its own error.
/// Factors out the byte-identical private `build_session` of Piper/Supertonic/
/// Chatterbox (CpuOnly policy + `TtsDevice::Cpu`, dropping the active-providers).
pub(crate) fn cpu_session(
    path: &Path,
    reason: &'static str,
    engine: &str,
) -> Result<Session, String> {
    let (session, _active_providers) = build_session(
        path,
        TtsDevice::Cpu,
        TtsOrtProviderPolicy::CpuOnly { reason },
        engine,
    )?;
    Ok(session)
}

/// Build a **CPU-only** session with an explicit intra-op thread cap.
///
/// [`cpu_session`] leaves `intra_threads` unset, which lets ORT spawn one thread
/// per logical core. That is the right default for the wide graphs (Kokoro's
/// vocoder, Chatterbox's encoder) but it is actively harmful for a *narrow*
/// autoregressive decoder: NeuTTS-2e's backbone has `hidden_size` 512, so a
/// single-token step is a stack of tiny GEMMs whose per-op fork/join dominates
/// once the pool is large. Measured on this box (24 logical cores, int8 graph,
/// 40 timed steps): 8.3 tok/s at the ORT default vs **23.2 tok/s at 4 threads** —
/// a 2.8x loss from over-subscription, matching the upstream card's "set
/// intra_op_num_threads to 3-4" note. Engines that want that cap ask for it here
/// rather than every engine paying for a knob only one of them needs.
pub(crate) fn cpu_session_with_intra_threads(
    path: &Path,
    reason: &'static str,
    engine: &str,
    intra_threads: usize,
) -> Result<Session, String> {
    log::debug!("[tts] {engine} CPU-pinned with {intra_threads} intra-op threads ({reason})");
    let mut builder = configure_session(
        GraphOptimizationLevel::Level3,
        Some(intra_threads.max(1)),
        false,
        Some(&[Accelerator::Cpu]),
    )?;
    builder
        .commit_from_file(path)
        .map_err(|err| format!("commit_from_file {}: {err}", path.display()))
}

/// Input node names of a loaded session (e.g. Kokoro's `tokens` vs `input_ids`
/// schema probe). Empty if the runtime exposes none.
pub(crate) fn input_names(session: &Session) -> Vec<String> {
    session
        .inputs()
        .iter()
        .map(|o| o.name().to_string())
        .collect()
}

/// Output node names of a loaded session (Supertonic resolves named outputs).
pub(crate) fn output_names(session: &Session) -> Vec<String> {
    session
        .outputs()
        .iter()
        .map(|o| o.name().to_string())
        .collect()
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum TtsOrtProviderPolicy {
    CpuOnly {
        reason: &'static str,
    },
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "staged for engines that should follow the active STT device"
        )
    )]
    FollowDevice,
}

pub(crate) fn build_session(
    path: &Path,
    device: TtsDevice,
    policy: TtsOrtProviderPolicy,
    engine: &str,
) -> Result<(Session, Vec<String>), String> {
    let providers = providers_for_policy(device, policy, engine);
    let active_providers = providers.iter().map(provider_label).collect::<Vec<_>>();
    let is_gpu = providers
        .first()
        .is_some_and(|provider| !matches!(provider, Accelerator::Cpu));

    // GPU path sets intra-op threads (CPU path keeps ORT's default) + disables the DML
    // memory-pattern planner; Level3 (`ORT_ENABLE_ALL` layout) for all.
    let intra_threads = is_gpu.then(|| pick_intra_op_threads(true, num_cpus_best_effort()));
    let mut builder = configure_session(
        GraphOptimizationLevel::Level3,
        intra_threads,
        is_gpu,
        Some(&providers),
    )?;

    let session = builder
        .commit_from_file(path)
        .map_err(|err| format!("commit_from_file {}: {err}", path.display()))?;
    Ok((session, active_providers))
}

fn providers_for_policy(
    device: TtsDevice,
    policy: TtsOrtProviderPolicy,
    engine: &str,
) -> Vec<Accelerator> {
    match policy {
        TtsOrtProviderPolicy::CpuOnly { reason } => {
            if !matches!(device, TtsDevice::Cpu) {
                log::debug!(
                    "[tts] {engine} requested device={device:?} -> running CPU-only ({reason})"
                );
            }
            vec![Accelerator::Cpu]
        }
        TtsOrtProviderPolicy::FollowDevice => providers_for_tts_device(device),
    }
}

fn providers_for_tts_device(device: TtsDevice) -> Vec<Accelerator> {
    match device {
        TtsDevice::Cpu => vec![Accelerator::Cpu],
        TtsDevice::DirectMl => vec![Accelerator::DirectMl, Accelerator::Cpu],
        TtsDevice::Auto if cfg!(windows) => vec![Accelerator::DirectMl, Accelerator::Cpu],
        TtsDevice::Auto => vec![Accelerator::Cpu],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tts_auto_maps_to_platform_provider() {
        let providers = providers_for_tts_device(TtsDevice::Auto);
        if cfg!(windows) {
            assert_eq!(providers, vec![Accelerator::DirectMl, Accelerator::Cpu]);
        } else {
            assert_eq!(providers, vec![Accelerator::Cpu]);
        }
    }

    #[test]
    fn tts_directml_keeps_cpu_fallback() {
        assert_eq!(
            providers_for_tts_device(TtsDevice::DirectMl),
            vec![Accelerator::DirectMl, Accelerator::Cpu]
        );
    }

    #[test]
    fn cpu_only_policy_overrides_requested_gpu() {
        assert_eq!(
            providers_for_policy(
                TtsDevice::DirectMl,
                TtsOrtProviderPolicy::CpuOnly {
                    reason: "test policy"
                },
                "test"
            ),
            vec![Accelerator::Cpu]
        );
    }

    #[test]
    fn follow_device_policy_uses_requested_device() {
        assert_eq!(
            providers_for_policy(TtsDevice::Cpu, TtsOrtProviderPolicy::FollowDevice, "test"),
            vec![Accelerator::Cpu]
        );
    }
}
