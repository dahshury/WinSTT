// Transform-preview conversions and preset composition. Shared settings-to-LLM
// mappers live in commands::llm::conversions.

use crate::winstt::llm::{
    self, PresetEntry as LlmPresetEntry, ThinkingEffort as LlmEffort,
    merge_presets_with_custom_modifiers,
};
use crate::winstt::settings_schema::{
    CustomModifier as SettingsCustomModifier, LlmProvider, PresetEntry as SettingsPreset,
    WinsttSettings,
};

pub(super) use crate::winstt::commands::llm::conversions::{openrouter_options, to_llm_effort};
use crate::winstt::commands::llm::conversions::{to_llm_custom, to_llm_preset};

use super::LlmPreviewConfig;

fn parse_openrouter_effort_value(s: &str) -> String {
    match s {
        "off" => "off",
        "low" => "low",
        "high" => "high",
        _ => "medium",
    }
    .to_string()
}

pub(super) fn openrouter_options_from_preview(
    cfg: &LlmPreviewConfig,
) -> llm::OpenRouterRequestOptions {
    llm::OpenRouterRequestOptions {
        reasoning_effort: Some(parse_openrouter_effort_value(&cfg.reasoning_effort)),
        verbosity: Some(parse_openrouter_effort_value(&cfg.verbosity)),
        max_output_tokens: cfg.max_output_tokens.filter(|v| *v > 0),
    }
}

/// Compose the transforms feature's full preset list (builtins + enabled custom
/// modifiers) — the SAME ordering WinSTT's `processText("transforms")` produces.
pub(super) fn transforms_presets(
    presets: &[SettingsPreset],
    customs: &[SettingsCustomModifier],
) -> Vec<LlmPresetEntry> {
    let builtins: Vec<LlmPresetEntry> = presets.iter().map(to_llm_preset).collect();
    let customs: Vec<llm::CustomModifier> = customs.iter().map(to_llm_custom).collect();
    merge_presets_with_custom_modifiers(&builtins, &customs)
}

pub(super) fn saved_model(settings: &WinsttSettings, is_dictation: bool) -> String {
    if is_dictation {
        settings.llm.dictation.base.model.clone()
    } else {
        settings.llm.transforms.base.model.clone()
    }
}

/// Map the Playground's provider string to the `LlmProvider` enum, falling back
/// to the feature's saved provider on an unknown/empty value (matches Zod's
/// kebab-case spellings: `ollama` / `openrouter` / `apple-intelligence`).
pub(super) fn parse_provider(
    s: &str,
    settings: &WinsttSettings,
    is_dictation: bool,
) -> LlmProvider {
    match s {
        "ollama" => LlmProvider::Ollama,
        "openrouter" => LlmProvider::Openrouter,
        "apple-intelligence" => LlmProvider::AppleIntelligence,
        _ => {
            if is_dictation {
                settings.llm.dictation.base.provider
            } else {
                settings.llm.transforms.base.provider
            }
        }
    }
}

pub(super) fn parse_effort(s: &str) -> LlmEffort {
    match s {
        "off" => LlmEffort::Off,
        "low" => LlmEffort::Low,
        "high" => LlmEffort::High,
        _ => LlmEffort::Medium,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_effort_maps_levels() {
        assert!(matches!(parse_effort("off"), LlmEffort::Off));
        assert!(matches!(parse_effort("low"), LlmEffort::Low));
        assert!(matches!(parse_effort("high"), LlmEffort::High));
        assert!(matches!(parse_effort("medium"), LlmEffort::Medium));
        assert!(matches!(parse_effort("garbage"), LlmEffort::Medium));
    }

    #[test]
    fn parse_provider_maps_kebab_case() {
        let s = WinsttSettings::default();
        assert!(matches!(
            parse_provider("ollama", &s, false),
            LlmProvider::Ollama
        ));
        assert!(matches!(
            parse_provider("openrouter", &s, false),
            LlmProvider::Openrouter
        ));
        assert!(matches!(
            parse_provider("apple-intelligence", &s, false),
            LlmProvider::AppleIntelligence
        ));
        // Unknown → saved transforms provider (default Ollama).
        assert!(matches!(parse_provider("", &s, false), LlmProvider::Ollama));
    }
}
