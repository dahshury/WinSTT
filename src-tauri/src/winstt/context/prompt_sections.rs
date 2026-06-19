use super::json_scrub_secret_codes;

enum JsonPromptValue {
    Bool(bool),
    Text(String),
}

pub(super) struct JsonPromptSection {
    key: &'static str,
    value: JsonPromptValue,
}

impl JsonPromptSection {
    pub(super) fn text(key: &'static str, value: impl Into<String>) -> Self {
        Self {
            key,
            value: JsonPromptValue::Text(value.into()),
        }
    }

    pub(super) fn bool(key: &'static str, value: bool) -> Self {
        Self {
            key,
            value: JsonPromptValue::Bool(value),
        }
    }

    fn has_value(&self) -> bool {
        match &self.value {
            JsonPromptValue::Bool(value) => *value,
            JsonPromptValue::Text(value) => !value.is_empty(),
        }
    }
}

pub(super) fn json_serialize_context(sections: Vec<JsonPromptSection>) -> String {
    // PRIVACY-CRITICAL final gate: scrub OTP / verification / single-use secret
    // codes from EVERY assembled text section, no matter which formatter branch
    // produced it (window-dump, pruned-tree reroute, flat beforeCaret, etc.).
    // Bool sections (e.g. `ide`) and metadata are left untouched. This runs after
    // assembly and before serialization so it is impossible to bypass.
    let sections = sections
        .into_iter()
        .map(|mut section| {
            if let JsonPromptValue::Text(value) = &section.value {
                if json_section_carries_content(section.key) {
                    section.value = JsonPromptValue::Text(json_scrub_secret_codes(value));
                }
            }
            section
        })
        .filter(JsonPromptSection::has_value)
        .collect::<Vec<_>>();
    if sections.is_empty() {
        return String::new();
    }

    let mut out = String::from("{\n");
    for (index, section) in sections.iter().enumerate() {
        let key = serde_json::to_string(section.key).unwrap_or_else(|_| "\"\"".to_string());
        let value = match &section.value {
            JsonPromptValue::Bool(value) => value.to_string(),
            JsonPromptValue::Text(value) => {
                serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
            }
        };
        out.push_str("  ");
        out.push_str(&key);
        out.push_str(": ");
        out.push_str(&value);
        if index + 1 < sections.len() {
            out.push(',');
        }
        out.push('\n');
    }
    out.push('}');
    out
}

/// True for the prompt sections that carry captured page/field content and may
/// contain leaked secret codes. Lightweight metadata sections are excluded so a
/// digit-bearing title is never mangled.
fn json_section_carries_content(key: &str) -> bool {
    matches!(
        key,
        "selection"
            | "beforeCaret"
            | "afterCaret"
            | "fieldText"
            | "screen"
            | "screenOcr"
            | "clipboard"
    )
}

pub(super) fn json_trim_or_empty(raw: Option<&str>) -> String {
    raw.unwrap_or("").trim().to_string()
}
