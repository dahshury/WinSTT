use crate::winstt::settings_schema::{
    AppProfileConfig, AppProfileRule, LlmProvider, WinsttSettings,
};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AppIdentity {
    pub app_exe: String,
    pub window_title: String,
    pub url: String,
}

fn normalize_exe(value: &str) -> String {
    let normalized = value.trim().replace('/', "\\");
    let basename = normalized
        .rsplit('\\')
        .next()
        .unwrap_or(&normalized)
        .trim()
        .to_lowercase();
    basename
        .strip_suffix(".exe")
        .unwrap_or(&basename)
        .to_string()
}

fn host_of(value: &str) -> String {
    let mut candidate = value.trim().to_lowercase();
    if let Some((_, rest)) = candidate.split_once("://") {
        candidate = rest.to_string();
    }
    if let Some((_, rest)) = candidate.rsplit_once('@') {
        candidate = rest.to_string();
    }
    candidate = candidate
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .trim_end_matches('.')
        .to_string();
    // Browser domains are DNS hosts. IPv6 is not a supported rule target, so a
    // final colon unambiguously separates a port for this feature.
    if let Some((host, port)) = candidate.rsplit_once(':')
        && port.chars().all(|ch| ch.is_ascii_digit())
    {
        candidate = host.to_string();
    }
    candidate
        .strip_prefix("www.")
        .unwrap_or(&candidate)
        .to_string()
}

fn rule_matches(rule: &AppProfileRule, identity: &AppIdentity) -> Option<u8> {
    if !rule.enabled {
        return None;
    }
    let has_exe = !rule.app_exe.trim().is_empty();
    let has_title = !rule.title_pattern.trim().is_empty();
    let has_url = !rule.url_pattern.trim().is_empty();
    if !(has_exe || has_title || has_url) {
        return None;
    }

    let mut score = 0;
    if has_exe {
        if normalize_exe(&rule.app_exe) != normalize_exe(&identity.app_exe) {
            return None;
        }
        score += 1;
    }
    if has_title {
        if !identity
            .window_title
            .to_lowercase()
            .contains(&rule.title_pattern.trim().to_lowercase())
        {
            return None;
        }
        score += 2;
    }
    if has_url {
        let pattern = host_of(&rule.url_pattern);
        let host = host_of(&identity.url);
        if pattern.is_empty() || !(host == pattern || host.ends_with(&format!(".{pattern}"))) {
            return None;
        }
        score += 4;
    }
    Some(score)
}

pub fn resolve_rule<'a>(
    rules: &'a [AppProfileRule],
    identity: &AppIdentity,
    openrouter_key_present: bool,
) -> Option<&'a AppProfileRule> {
    rules
        .iter()
        .filter(|rule| match rule.config.base.provider {
            LlmProvider::Openrouter => openrouter_key_present,
            LlmProvider::AppleIntelligence | LlmProvider::Ollama => {
                !rule.config.base.model.trim().is_empty()
            }
        })
        .filter_map(|rule| rule_matches(rule, identity).map(|score| (score, rule)))
        // `max_by_key` returns the last maximum, but table order wins ties. A
        // manual fold retains the first maximum.
        .fold(
            None,
            |best: Option<(u8, &AppProfileRule)>, candidate| match best {
                Some(current) if current.0 >= candidate.0 => Some(current),
                _ => Some(candidate),
            },
        )
        .map(|(_, rule)| rule)
}

pub fn apply_profile_to_settings(settings: &mut WinsttSettings, config: &AppProfileConfig) {
    settings.llm.dictation.base = config.base.clone();
    settings.llm.dictation.presets = config.presets.clone();
    settings.llm.dictation.custom_modifiers = config.custom_modifiers.clone();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(app: &str, title: &str, url: &str) -> AppProfileRule {
        let mut rule = AppProfileRule {
            app_exe: app.into(),
            title_pattern: title.into(),
            url_pattern: url.into(),
            ..AppProfileRule::default()
        };
        rule.config.base.model = "qwen3:4b".into();
        rule
    }

    #[test]
    fn normalizes_executable_paths_case_and_suffix() {
        assert_eq!(
            normalize_exe(r#"C:\Program Files\Chrome\CHROME.EXE"#),
            "chrome"
        );
        assert_eq!(normalize_exe("chrome"), "chrome");
    }

    #[test]
    fn normalizes_browser_hosts() {
        assert_eq!(host_of("https://www.GMail.com:443/inbox?q=1"), "gmail.com");
        assert_eq!(host_of("mail.gmail.com/inbox"), "mail.gmail.com");
    }

    #[test]
    fn host_matching_is_suffix_and_label_boundary_safe() {
        let gmail = rule("", "", "gmail.com");
        assert!(
            rule_matches(
                &gmail,
                &AppIdentity {
                    url: "mail.gmail.com".into(),
                    ..Default::default()
                }
            )
            .is_some()
        );
        assert!(
            rule_matches(
                &gmail,
                &AppIdentity {
                    url: "notgmail.com".into(),
                    ..Default::default()
                }
            )
            .is_none()
        );
        let mail = rule("", "", "mail.com");
        assert!(
            rule_matches(
                &mail,
                &AppIdentity {
                    url: "gmail.com".into(),
                    ..Default::default()
                }
            )
            .is_none()
        );
    }

    #[test]
    fn every_populated_matcher_must_match() {
        let candidate = rule("chrome.exe", "Gmail", "gmail.com");
        let matching = AppIdentity {
            app_exe: "CHROME".into(),
            window_title: "Inbox - GMAIL".into(),
            url: "mail.gmail.com".into(),
        };
        assert_eq!(rule_matches(&candidate, &matching), Some(7));
        assert!(
            rule_matches(
                &candidate,
                &AppIdentity {
                    url: "docs.google.com".into(),
                    ..matching
                }
            )
            .is_none()
        );
    }

    #[test]
    fn specificity_wins_and_table_order_breaks_ties() {
        let rules = vec![
            rule("chrome", "", ""),
            rule("", "", "gmail.com"),
            rule("chrome", "", "gmail.com"),
            rule("chrome", "", "gmail.com"),
        ];
        let identity = AppIdentity {
            app_exe: "chrome.exe".into(),
            url: "gmail.com".into(),
            ..Default::default()
        };
        assert!(std::ptr::eq(
            resolve_rule(&rules, &identity, true).unwrap(),
            &rules[2]
        ));
    }

    #[test]
    fn disabled_empty_and_keyless_openrouter_rules_are_skipped() {
        let mut disabled = rule("chrome", "", "");
        disabled.enabled = false;
        let mut cloud = rule("chrome", "", "");
        cloud.config.base.provider = LlmProvider::Openrouter;
        let mut fallback = rule("chrome", "", "");
        fallback.config.base.model = "qwen3:4b".into();
        let rules = vec![AppProfileRule::default(), disabled, cloud, fallback];
        let identity = AppIdentity {
            app_exe: "chrome.exe".into(),
            ..Default::default()
        };
        assert!(std::ptr::eq(
            resolve_rule(&rules, &identity, false).unwrap(),
            &rules[3]
        ));
    }

    #[test]
    fn local_rules_without_a_model_are_skipped() {
        let mut empty = rule("chrome", "", "");
        empty.config.base.model.clear();
        let mut usable = rule("chrome", "", "");
        usable.config.base.model = "qwen3:4b".into();
        let rules = vec![empty, usable];
        let identity = AppIdentity {
            app_exe: "chrome.exe".into(),
            ..Default::default()
        };
        assert!(std::ptr::eq(
            resolve_rule(&rules, &identity, true).unwrap(),
            &rules[1]
        ));
    }

    #[test]
    fn applying_profile_preserves_authoritative_switches() {
        let mut settings = WinsttSettings::default();
        settings.llm.dictation.enabled = true;
        settings.llm.dictation.dictionary_auto_add_enabled = true;
        let mut config = AppProfileConfig::default();
        config.base.model = "profile-model".into();
        apply_profile_to_settings(&mut settings, &config);
        assert!(settings.llm.dictation.enabled);
        assert!(settings.llm.dictation.dictionary_auto_add_enabled);
        assert_eq!(settings.llm.dictation.base.model, "profile-model");
    }
}
