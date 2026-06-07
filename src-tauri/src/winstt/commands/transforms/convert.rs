// Pure Settings->LLM type/effort/options conversions and preset composition shared
// by the runtime path and the playground preview. Stateless mappers extracted
// verbatim from the transforms module root.

use crate::winstt::llm::{
    self, merge_presets_with_custom_modifiers, PresetEntry as LlmPresetEntry,
    PresetKey as LlmPresetKey, PresetLevel as LlmPresetLevel, ThinkingEffort as LlmEffort,
};
use crate::winstt::settings_schema::{
    CustomModifier as SettingsCustomModifier, EffortLevel as SettingsOpenRouterEffort,
    LlmFeatureBase, LlmProvider, PresetEntry as SettingsPreset, PresetKey as SettingsPresetKey,
    PresetLevel as SettingsLevel, ThinkingEffort as SettingsEffort, WinsttSettings,
};

use super::LlmPreviewConfig;

// ── settings → prompt-shape conversions (local; llm.rs keeps its own private) ───

fn to_llm_level(level: SettingsLevel) -> LlmPresetLevel {
    match level {
        SettingsLevel::Light => LlmPresetLevel::Light,
        SettingsLevel::Medium => LlmPresetLevel::Medium,
        SettingsLevel::High => LlmPresetLevel::High,
    }
}

fn to_llm_key(key: SettingsPresetKey) -> LlmPresetKey {
    match key {
        SettingsPresetKey::Neutral => LlmPresetKey::Neutral,
        SettingsPresetKey::Formal => LlmPresetKey::Formal,
        SettingsPresetKey::Friendly => LlmPresetKey::Friendly,
        SettingsPresetKey::Technical => LlmPresetKey::Technical,
        SettingsPresetKey::Concise => LlmPresetKey::Concise,
        SettingsPresetKey::Summarize => LlmPresetKey::Summarize,
        SettingsPresetKey::Reorder => LlmPresetKey::Reorder,
        SettingsPresetKey::Restructure => LlmPresetKey::Restructure,
        SettingsPresetKey::RewordForClarity => LlmPresetKey::RewordForClarity,
        SettingsPresetKey::Translate => LlmPresetKey::Translate,
    }
}

fn to_llm_preset(p: &SettingsPreset) -> LlmPresetEntry {
    LlmPresetEntry::Builtin {
        key: to_llm_key(p.key),
        level: p.level.map(to_llm_level),
        target_lang: p.target_lang.clone(),
    }
}

pub(super) fn to_llm_effort(e: SettingsEffort) -> LlmEffort {
    match e {
        SettingsEffort::Off => LlmEffort::Off,
        SettingsEffort::Low => LlmEffort::Low,
        SettingsEffort::Medium => LlmEffort::Medium,
        SettingsEffort::High => LlmEffort::High,
    }
}

fn openrouter_effort_value(e: SettingsOpenRouterEffort) -> &'static str {
    match e {
        SettingsOpenRouterEffort::Low => "low",
        SettingsOpenRouterEffort::Medium => "medium",
        SettingsOpenRouterEffort::High => "high",
    }
}

/// Reasoning effort adds an `off` step (disables reasoning) on top of the
/// verbosity scale. `"off"` becomes `reasoning: { enabled: false }` downstream.
fn openrouter_reasoning_value(e: SettingsEffort) -> &'static str {
    match e {
        SettingsEffort::Off => "off",
        SettingsEffort::Low => "low",
        SettingsEffort::Medium => "medium",
        SettingsEffort::High => "high",
    }
}

fn parse_openrouter_effort_value(s: &str) -> String {
    match s {
        "off" => "off",
        "low" => "low",
        "high" => "high",
        _ => "medium",
    }
    .to_string()
}

pub(super) fn openrouter_options(base: &LlmFeatureBase) -> llm::OpenRouterRequestOptions {
    llm::OpenRouterRequestOptions {
        reasoning_effort: Some(openrouter_reasoning_value(base.reasoning_effort).to_string()),
        verbosity: Some(openrouter_effort_value(base.verbosity).to_string()),
        max_output_tokens: base.max_output_tokens.filter(|v| *v > 0),
    }
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

fn to_llm_custom(m: &SettingsCustomModifier) -> llm::CustomModifier {
    llm::CustomModifier {
        id: m.id.clone(),
        name: m.name.clone(),
        prompt: m.prompt.clone(),
        enabled: m.enabled,
        levels_enabled: m.levels_enabled,
        level: m.level.map(to_llm_level),
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
