// Auto-apply dictation learning: append learned dictionary terms / snippets /
// modifier presets with normalize + stable-id helpers; DictationLearningApplyResult.

use std::collections::HashSet;
use tauri::AppHandle;

use super::{apply_settings_patch, PartialWinsttSettings};
use crate::winstt::llm::{DictationSideEffects, LearnedSnippet, SuggestedModifierPreset};
use crate::winstt::settings_schema::{CustomModifier, DictionaryEntry, SnippetEntry};
use crate::winstt::settings_store::read_settings;

fn normalize_dictionary_term(term: &str) -> String {
    term.trim().to_lowercase()
}

fn slugify_or(value: &str, fallback: &str) -> String {
    let slug = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        fallback.to_string()
    } else {
        slug
    }
}

fn auto_learning_entry_id(kind: &str, value: &str, index: usize, fallback: &str) -> String {
    let slug = slugify_or(value, fallback);
    format!(
        "auto-{kind}-{}-{index}-{slug}",
        chrono::Utc::now().timestamp_millis()
    )
}

fn auto_dictionary_entry_id(term: &str, index: usize) -> String {
    auto_learning_entry_id("dict", term, index, "term")
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DictationLearningApplyResult {
    pub dictionary_terms: usize,
    pub snippets: usize,
    pub modifiers: usize,
}

impl DictationLearningApplyResult {
    pub(crate) fn any(&self) -> bool {
        self.dictionary_terms > 0 || self.snippets > 0 || self.modifiers > 0
    }
}

pub(crate) fn auto_apply_dictation_learning(
    app: &AppHandle,
    side_effects: &DictationSideEffects,
) -> Result<DictationLearningApplyResult, String> {
    let current = read_settings(app);
    let mut dictionary = current.dictionary.clone();
    let mut snippets = current.snippets.clone();
    let mut llm = current.llm;

    let added_dictionary =
        append_auto_dictionary_terms(&mut dictionary, &side_effects.learned_proper_nouns);
    let added_snippets = append_auto_snippets(&mut snippets, &side_effects.learned_snippets);
    let added_modifiers = append_auto_modifier_presets(
        &mut llm.dictation.custom_modifiers,
        &side_effects.suggested_modifier_presets,
    );

    let result = DictationLearningApplyResult {
        dictionary_terms: added_dictionary.len(),
        snippets: added_snippets.len(),
        modifiers: added_modifiers.len(),
    };
    if !result.any() {
        return Ok(result);
    }

    apply_settings_patch(
        app,
        PartialWinsttSettings {
            dictionary: (!added_dictionary.is_empty()).then_some(dictionary),
            snippets: (!added_snippets.is_empty()).then_some(snippets),
            llm: (!added_modifiers.is_empty()).then_some(llm),
            ..PartialWinsttSettings::default()
        },
    )?;

    Ok(result)
}

fn append_auto_dictionary_terms(
    dictionary: &mut Vec<DictionaryEntry>,
    terms: &[String],
) -> Vec<String> {
    let mut existing: HashSet<String> = dictionary
        .iter()
        .map(|entry| normalize_dictionary_term(&entry.term))
        .filter(|term| !term.is_empty())
        .collect();
    let mut added = Vec::new();

    for raw in terms {
        let term = raw.trim();
        let normalized = normalize_dictionary_term(term);
        if normalized.is_empty() || !existing.insert(normalized) {
            continue;
        }
        let index = added.len();
        dictionary.push(DictionaryEntry {
            id: auto_dictionary_entry_id(term, index),
            term: term.to_string(),
            auto_added: Some(true),
            replacement: None,
        });
        added.push(term.to_string());
    }
    added
}

fn normalize_snippet_trigger(trigger: &str) -> String {
    trigger.trim().to_lowercase()
}

fn auto_snippet_entry_id(trigger: &str, index: usize) -> String {
    auto_learning_entry_id("snippet", trigger, index, "snippet")
}

fn append_auto_snippets(
    snippets: &mut Vec<SnippetEntry>,
    learned: &[LearnedSnippet],
) -> Vec<String> {
    let mut existing: HashSet<String> = snippets
        .iter()
        .map(|entry| normalize_snippet_trigger(&entry.trigger))
        .filter(|trigger| !trigger.is_empty())
        .collect();
    let mut added = Vec::new();

    for raw in learned {
        let trigger = raw.trigger.trim();
        let expansion = raw.expansion.trim();
        let normalized = normalize_snippet_trigger(trigger);
        if normalized.is_empty()
            || expansion.is_empty()
            || trigger.eq_ignore_ascii_case(expansion)
            || !existing.insert(normalized)
        {
            continue;
        }
        let index = added.len();
        snippets.push(SnippetEntry {
            id: auto_snippet_entry_id(trigger, index),
            trigger: trigger.to_string(),
            expansion: expansion.to_string(),
        });
        added.push(trigger.to_string());
    }
    added
}

fn normalize_modifier_identity(name: &str, prompt: &str) -> String {
    format!(
        "{}\n{}",
        name.trim().to_lowercase(),
        prompt.trim().to_lowercase()
    )
}

fn auto_modifier_entry_id(name: &str, index: usize) -> String {
    auto_learning_entry_id("modifier", name, index, "modifier")
}

fn append_auto_modifier_presets(
    modifiers: &mut Vec<CustomModifier>,
    suggested: &[SuggestedModifierPreset],
) -> Vec<String> {
    let mut existing: HashSet<String> = modifiers
        .iter()
        .map(|entry| normalize_modifier_identity(&entry.name, &entry.prompt))
        .collect();
    let mut added = Vec::new();

    for raw in suggested {
        let name_owned = raw.name.split_whitespace().collect::<Vec<_>>().join(" ");
        let name = name_owned.trim();
        let prompt = raw.prompt.trim();
        if name.is_empty() || prompt.is_empty() {
            continue;
        }
        let normalized = normalize_modifier_identity(name, prompt);
        if !existing.insert(normalized) {
            continue;
        }
        let index = added.len();
        modifiers.push(CustomModifier {
            id: auto_modifier_entry_id(name, index),
            name: name.to_string(),
            prompt: prompt.to_string(),
            enabled: false,
            levels_enabled: false,
            level: None,
        });
        added.push(name.to_string());
    }
    added
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_auto_dictionary_terms_flags_entries_and_skips_duplicates() {
        let mut dictionary = vec![DictionaryEntry {
            id: "manual".into(),
            term: "Kubernetes".into(),
            auto_added: None,
            replacement: None,
        }];
        let added = append_auto_dictionary_terms(
            &mut dictionary,
            &["Kubernetes".into(), "WinSTT".into(), "  Base UI  ".into()],
        );

        assert_eq!(added, vec!["WinSTT".to_string(), "Base UI".to_string()]);
        assert_eq!(dictionary.len(), 3);
        assert_eq!(dictionary[0].auto_added, None);
        assert_eq!(dictionary[1].term, "WinSTT");
        assert_eq!(dictionary[1].auto_added, Some(true));
        assert_eq!(dictionary[2].term, "Base UI");
        assert_eq!(dictionary[2].auto_added, Some(true));
    }

    #[test]
    fn append_auto_snippets_and_modifiers_skip_duplicates_and_invalid_entries() {
        let mut snippets = vec![SnippetEntry {
            id: "manual-snippet".into(),
            trigger: "/sig".into(),
            expansion: "Existing signature".into(),
        }];
        let added_snippets = append_auto_snippets(
            &mut snippets,
            &[
                LearnedSnippet {
                    trigger: "/sig".into(),
                    expansion: "Duplicate".into(),
                },
                LearnedSnippet {
                    trigger: "same".into(),
                    expansion: "same".into(),
                },
                LearnedSnippet {
                    trigger: "/thanks".into(),
                    expansion: "Thanks, I appreciate it.".into(),
                },
            ],
        );

        assert_eq!(added_snippets, vec!["/thanks".to_string()]);
        assert_eq!(snippets.len(), 2);
        assert_eq!(snippets[1].trigger, "/thanks");

        let mut modifiers = vec![CustomModifier {
            id: "manual-modifier".into(),
            name: "Formal".into(),
            prompt: "Rewrite formally.".into(),
            enabled: true,
            levels_enabled: false,
            level: None,
        }];
        let added_modifiers = append_auto_modifier_presets(
            &mut modifiers,
            &[
                SuggestedModifierPreset {
                    name: "Formal".into(),
                    prompt: "Rewrite formally.".into(),
                },
                SuggestedModifierPreset {
                    name: "  Meeting   Summary ".into(),
                    prompt: "Turn this into concise meeting notes.".into(),
                },
            ],
        );

        assert_eq!(added_modifiers, vec!["Meeting Summary".to_string()]);
        assert_eq!(modifiers.len(), 2);
        assert_eq!(modifiers[1].name, "Meeting Summary");
        assert!(!modifiers[1].enabled);
    }
}
