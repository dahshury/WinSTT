use std::path::Path;

use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;

use super::types::TtsDevice;
use crate::winstt::stt::{
    execution_providers, num_cpus_best_effort, pick_intra_op_threads, provider_label, Accelerator,
};

#[derive(Clone, Copy, Debug)]
pub(crate) enum TtsOrtProviderPolicy {
    CpuOnly {
        reason: &'static str,
    },
    #[allow(dead_code)]
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

    let mut builder = Session::builder()
        .map_err(|err| format!("session builder: {err}"))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|err| format!("opt level: {err}"))?;

    if is_gpu {
        builder = builder
            .with_intra_threads(pick_intra_op_threads(true, num_cpus_best_effort()))
            .map_err(|err| format!("intra threads: {err}"))?
            .with_memory_pattern(false)
            .map_err(|err| format!("disable memory pattern: {err}"))?;
    }

    builder = builder
        .with_execution_providers(execution_providers(&providers))
        .map_err(|err| format!("register EPs: {err}"))?;

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
