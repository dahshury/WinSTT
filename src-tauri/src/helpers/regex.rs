use regex::Regex;

pub(crate) fn static_regex(pattern: &str) -> Regex {
    match Regex::new(pattern) {
        Ok(regex) => regex,
        Err(err) => unreachable!("invalid static regex {pattern:?}: {err}"),
    }
}
