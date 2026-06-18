//! Deterministic, universal layout normalization applied to LLM output before
//! it is pasted. This is LAYOUT ONLY — it never changes wording, casing, or
//! meaning (those belong to the model). Its single job: when the model emits an
//! enumeration *inline* on one line (e.g. "Steps: 1. a 2. b 3. c" or
//! "Do: * a * b * c"), break each item onto its own real line so the list
//! renders as a list in the target text box.
//!
//! Why this exists: small/cheap models (Gemma-class locals, gemini-flash-lite)
//! are unreliable at embedding `\n` inside a JSON string value even when the
//! prompt demands it — they often collapse a numbered/bulleted list onto one
//! row. The prompt still asks for proper newlines (so models that comply look
//! right), and this pass guarantees the layout for the ones that don't, across
//! every provider. It only ever ACTS on a line that already contains ≥2 inline
//! markers, so correctly-formatted multi-line lists (one marker per line) pass
//! through untouched and non-list prose is never reflowed.

use std::sync::LazyLock;

use regex::Regex;

use crate::helpers::regex::static_regex;

/// Matches an ordered-list marker: optional leading text, then a number with a
/// `.` or `)` delimiter followed by a space. Captured per-line during scanning.
static NUMBER_MARKER: LazyLock<Regex> = LazyLock::new(|| static_regex(r"(\d{1,3})[.)]\s+"));

/// Explode any line that carries an inline enumeration into one item per line.
/// Lines without an inline enumeration (including already-correct one-item-per-
/// line lists) are returned unchanged.
pub fn explode_inline_lists(text: &str) -> String {
    text.split('\n')
        .map(explode_line)
        .collect::<Vec<_>>()
        .join("\n")
}

fn explode_line(line: &str) -> String {
    if let Some(exploded) = explode_numbered(line) {
        return exploded;
    }
    if let Some(exploded) = explode_bulleted(line) {
        return exploded;
    }
    line.to_string()
}

/// Inline ordered list: a single line holding markers numbered 1, 2, 3 … in
/// ascending order (≥2 of them). Rewrites to a lead-in line (if any) followed by
/// one numbered item per line. A lead-in ending in `:` gets a blank line after
/// it, matching the block-list convention. Returns None when the line is not an
/// ascending inline enumeration (so a stray "step 1. do x" is left alone).
fn explode_numbered(line: &str) -> Option<String> {
    let marker_starts: Vec<(usize, usize, u32)> = NUMBER_MARKER
        .captures_iter(line)
        .filter_map(|cap| {
            let whole = cap.get(0)?;
            let num: u32 = cap.get(1)?.as_str().parse().ok()?;
            Some((whole.start(), whole.end(), num))
        })
        .collect();

    // Find the longest run of consecutive ascending markers starting at 1.
    let mut run: Vec<(usize, usize, u32)> = Vec::new();
    for &(start, end, num) in &marker_starts {
        let expected = run.len() as u32 + 1;
        if num == expected {
            run.push((start, end, num));
        } else if num == 1 {
            run.clear();
            run.push((start, end, num));
        }
    }
    if run.len() < 2 {
        return None;
    }

    let first_marker_start = run[0].0;
    let lead_in = line[..first_marker_start].trim_end();
    let mut out = String::new();
    if !lead_in.is_empty() {
        out.push_str(lead_in);
        out.push('\n');
        if lead_in.ends_with(':') {
            out.push('\n');
        }
    }
    for (idx, &(_, content_start, num)) in run.iter().enumerate() {
        let content_end = run.get(idx + 1).map_or(line.len(), |next| next.0);
        let item = line[content_start..content_end].trim();
        out.push_str(&format!("{num}. {item}"));
        if idx + 1 < run.len() {
            out.push('\n');
        }
    }
    Some(out)
}

/// Inline unordered list: a single line with ≥2 `* ` (or `- `) bullet markers.
/// Rewrites to a lead-in line (if any) followed by one `* ` item per line.
fn explode_bulleted(line: &str) -> Option<String> {
    let bytes = line.as_bytes();
    let mut marker_starts: Vec<usize> = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        let is_marker = (bytes[i] == b'*' || bytes[i] == b'-') && bytes[i + 1] == b' ';
        let at_boundary = i == 0 || bytes[i - 1] == b' ';
        if is_marker && at_boundary {
            marker_starts.push(i);
            i += 2;
        } else {
            i += 1;
        }
    }
    if marker_starts.len() < 2 {
        return None;
    }

    let first = marker_starts[0];
    let lead_in = line[..first].trim_end();
    let mut out = String::new();
    if !lead_in.is_empty() {
        out.push_str(lead_in);
        out.push('\n');
        if lead_in.ends_with(':') {
            out.push('\n');
        }
    }
    for (idx, &start) in marker_starts.iter().enumerate() {
        let content_start = start + 2;
        let content_end = marker_starts.get(idx + 1).copied().unwrap_or(line.len());
        let item = line[content_start..content_end].trim();
        out.push_str(&format!("* {item}"));
        if idx + 1 < marker_starts.len() {
            out.push('\n');
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_plain_prose_untouched() {
        let input = "This is a normal sentence. It has no list at all.";
        assert_eq!(explode_inline_lists(input), input);
    }

    #[test]
    fn leaves_correct_multiline_list_untouched() {
        let input = "Steps:\n\n1. First\n2. Second\n3. Third";
        assert_eq!(explode_inline_lists(input), input);
    }

    #[test]
    fn explodes_inline_numbered_after_colon() {
        let input = "Please check the cases: 1. before start 2. after end 3. on a holiday";
        let expected = "Please check the cases:\n\n1. before start\n2. after end\n3. on a holiday";
        assert_eq!(explode_inline_lists(input), expected);
    }

    #[test]
    fn explodes_inline_numbered_without_lead_in() {
        let input = "1. Do this 2. Then that 3. Finally this";
        let expected = "1. Do this\n2. Then that\n3. Finally this";
        assert_eq!(explode_inline_lists(input), expected);
    }

    #[test]
    fn explodes_inline_bullets_after_colon() {
        let input = "You should: * update the docs * fix the tests * ping the team";
        let expected = "You should:\n\n* update the docs\n* fix the tests\n* ping the team";
        assert_eq!(explode_inline_lists(input), expected);
    }

    #[test]
    fn normalizes_dash_bullets_to_star() {
        let input = "Do: - a - b";
        let expected = "Do:\n\n* a\n* b";
        assert_eq!(explode_inline_lists(input), expected);
    }

    #[test]
    fn ignores_single_stray_marker() {
        // A lone "1." mid-sentence is not an enumeration — leave it alone.
        let input = "There is exactly 1. thing here";
        assert_eq!(explode_inline_lists(input), input);
    }

    #[test]
    fn ignores_single_bullet() {
        let input = "A times B * C is the formula";
        assert_eq!(explode_inline_lists(input), input);
    }

    #[test]
    fn requires_ascending_from_one() {
        // "version 2." / "version 3." without a 1 is not an enumeration.
        let input = "Compare version 2. and version 3. carefully";
        assert_eq!(explode_inline_lists(input), input);
    }

    #[test]
    fn trailing_prose_stays_on_last_item() {
        // The model decides where the list ends; we only guarantee item newlines.
        let input = "Cases: 1. a 2. b 3. c. Then verify everything works.";
        let expected = "Cases:\n\n1. a\n2. b\n3. c. Then verify everything works.";
        assert_eq!(explode_inline_lists(input), expected);
    }

    #[test]
    fn handles_paren_delimiter() {
        let input = "Steps: 1) first 2) second";
        let expected = "Steps:\n\n1. first\n2. second";
        assert_eq!(explode_inline_lists(input), expected);
    }
}
