// Settings → prompt-shape conversion helpers (the thin `From` the spec calls for).
// Split out of the `llm` command root; used by the command entries in `mod.rs`.

use crate::winstt::llm::{
    self, merge_presets_with_custom_modifiers, PresetEntry as LlmPresetEntry,
    PresetKey as LlmPresetKey, PresetLevel as LlmPresetLevel, ThinkingEffort as LlmEffort,
};
use crate::winstt::settings_schema::{
    EffortLevel as SettingsOpenRouterEffort, LlmFeatureBase, PresetEntry as SettingsPreset,
    PresetKey as SettingsPresetKey, PresetLevel as SettingsLevel, ThinkingEffort as SettingsEffort,
    WinsttSettings,
};

// ── settings → prompt-shape conversions (the thin `From` the spec calls for) ──

pub(super) fn to_llm_level(level: SettingsLevel) -> LlmPresetLevel {
    match level {
        SettingsLevel::Light => LlmPresetLevel::Light,
        SettingsLevel::Medium => LlmPresetLevel::Medium,
        SettingsLevel::High => LlmPresetLevel::High,
    }
}

pub(super) fn to_llm_key(key: SettingsPresetKey) -> LlmPresetKey {
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

pub(super) fn to_llm_preset(p: &SettingsPreset) -> LlmPresetEntry {
    LlmPresetEntry::Builtin {
        key: to_llm_key(p.key),
        level: p.level.map(to_llm_level),
        target_lang: p.target_lang.clone(),
    }
}

pub(super) fn to_llm_custom(
    m: &crate::winstt::settings_schema::CustomModifier,
) -> llm::CustomModifier {
    llm::CustomModifier {
        id: m.id.clone(),
        name: m.name.clone(),
        prompt: m.prompt.clone(),
        enabled: m.enabled,
        levels_enabled: m.levels_enabled,
        level: m.level.map(to_llm_level),
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

pub(super) fn openrouter_effort_value(e: SettingsOpenRouterEffort) -> &'static str {
    match e {
        SettingsOpenRouterEffort::Low => "low",
        SettingsOpenRouterEffort::Medium => "medium",
        SettingsOpenRouterEffort::High => "high",
    }
}

/// Reasoning effort carries an extra `off` step (disables reasoning) on top of
/// the verbosity scale. The transport turns `"off"` into
/// `reasoning: { enabled: false }`; the others into `reasoning: { effort }`.
pub(super) fn openrouter_reasoning_value(e: SettingsEffort) -> &'static str {
    match e {
        SettingsEffort::Off => "off",
        SettingsEffort::Low => "low",
        SettingsEffort::Medium => "medium",
        SettingsEffort::High => "high",
    }
}

pub(super) fn openrouter_options(base: &LlmFeatureBase) -> llm::OpenRouterRequestOptions {
    llm::OpenRouterRequestOptions {
        reasoning_effort: Some(openrouter_reasoning_value(base.reasoning_effort).to_string()),
        verbosity: Some(openrouter_effort_value(base.verbosity).to_string()),
        max_output_tokens: base.max_output_tokens.filter(|v| *v > 0),
    }
}

/// Build the prompt-shape preset list (builtins + enabled custom modifiers) from
/// the persisted dictation settings.
pub(super) fn dictation_presets(settings: &WinsttSettings) -> Vec<LlmPresetEntry> {
    let builtins: Vec<LlmPresetEntry> = settings
        .llm
        .dictation
        .presets
        .iter()
        .map(to_llm_preset)
        .collect();
    let customs: Vec<llm::CustomModifier> = settings
        .llm
        .dictation
        .custom_modifiers
        .iter()
        .map(to_llm_custom)
        .collect();
    merge_presets_with_custom_modifiers(&builtins, &customs)
}

pub(super) fn transforms_presets(settings: &WinsttSettings) -> Vec<LlmPresetEntry> {
    let builtins: Vec<LlmPresetEntry> = settings
        .llm
        .transforms
        .presets
        .iter()
        .map(to_llm_preset)
        .collect();
    let customs: Vec<llm::CustomModifier> = settings
        .llm
        .transforms
        .custom_modifiers
        .iter()
        .map(to_llm_custom)
        .collect();
    merge_presets_with_custom_modifiers(&builtins, &customs)
}
