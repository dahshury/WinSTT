//! Convert the native aligner's source-timed words into speaker turns. Speaker
//! IDs are recording-local metadata; presentation prefixes belong to exports.
use std::collections::BTreeMap;

use serde_json::Value;

use super::{Segment, SttResult, TranscribeOptions, Transcription, WordResult, error};

fn speaker_id(value: &Value) -> Option<String> {
    let slot = value
        .as_u64()
        .or_else(|| value.as_str()?.strip_prefix("spk:")?.parse::<u64>().ok())?;
    (slot < 256).then(|| format!("spk:{slot}"))
}

fn strip_speaker_tags(text: &str) -> String {
    let mut output = String::new();
    let mut rest = text;
    while let Some(index) = rest.find("<spk:") {
        output.push_str(&rest[..index]);
        rest = &rest[index..];
        if let Some(end) = rest.find('>')
            && rest[5..end].parse::<u64>().is_ok()
        {
            if !output.is_empty() && !output.ends_with(char::is_whitespace) {
                output.push('\n');
            }
            rest = &rest[end + 1..];
        } else {
            output.push('<');
            rest = &rest[1..];
        }
    }
    output.push_str(rest);
    output.trim().to_string()
}

fn unspaced(c: char) -> bool {
    matches!(c as u32, 0x0E00..=0x0E7F | 0x3040..=0x30FF | 0x3400..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x323AF)
}

fn append_word(text: &mut String, word: &str) {
    let first = word.chars().next();
    let last = text.chars().next_back();
    let no_space = first.is_some_and(|c| ",.!?;:)]}，。！？、：；".contains(c))
        || last.is_some_and(|c| "([{“".contains(c))
        || first
            .zip(last)
            .is_some_and(|(a, b)| unspaced(a) && unspaced(b));
    if !text.is_empty() && !no_space {
        text.push(' ');
    }
    text.push_str(word);
}

fn turns(words: &[WordResult]) -> Vec<Segment> {
    // Keep simultaneous speakers separate. Grouping the interleaved global
    // word list by adjacent IDs would fragment every overlapping utterance.
    let mut by_speaker: BTreeMap<Option<String>, Vec<Segment>> = BTreeMap::new();
    for (index, word) in words.iter().enumerate() {
        let segments = by_speaker.entry(word.speaker.clone()).or_default();
        if let Some(segment) = segments.last_mut()
            && !words[..index]
                .iter()
                .rev()
                .take_while(|other| other.start >= segment.end)
                .any(|other| other.speaker != word.speaker && other.end <= word.start)
            && word.start - segment.end <= 1.0
            && word.end - segment.start <= 8.0
            && !segment.text.ends_with(['.', '?', '!', '。', '？', '！'])
        {
            append_word(&mut segment.text, word.text.trim());
            segment.end = segment.end.max(word.end);
        } else {
            segments.push(Segment {
                speaker: word.speaker.clone(),
                start: word.start,
                end: word.end,
                text: word.text.trim().to_string(),
            });
        }
    }
    let mut segments: Vec<_> = by_speaker.into_values().flatten().collect();
    segments.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.end.total_cmp(&b.end)));
    segments
}

pub(super) fn parse(
    result: &Value,
    duration: f32,
    opts: &TranscribeOptions,
) -> SttResult<Transcription> {
    let raw_text = result
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| error("missing transcript in native runtime response"))?;
    let text = if opts.diarization {
        strip_speaker_tags(raw_text)
    } else {
        raw_text.to_string()
    };
    let mut words = Vec::new();
    if let Some(entries) = result
        .pointer("/transcription/words")
        .and_then(Value::as_array)
    {
        for entry in entries {
            let parsed = (|| {
                let text = entry.get("word")?.as_str()?.trim().to_string();
                let start = entry.get("start")?.as_f64()?;
                let end = entry.get("end")?.as_f64()?;
                if text.is_empty()
                    || !start.is_finite()
                    || !end.is_finite()
                    || start < 0.0
                    || start > f64::from(duration)
                    || end < start
                    || end > f64::from(duration) + 0.1
                {
                    return None;
                }
                Some(WordResult {
                    text,
                    start: start as f32,
                    end: (end as f32).min(duration),
                    speaker: opts
                        .diarization
                        .then(|| entry.get("speaker").and_then(speaker_id))
                        .flatten(),
                })
            })();
            match parsed {
                Some(word) => words.push(word),
                None if opts.diarization => {
                    return Err(error(
                        "invalid word alignment; no speaker timings were exported",
                    ));
                }
                None => {}
            }
        }
    }
    if opts.diarization && !text.trim().is_empty() && !words.iter().any(|w| w.speaker.is_some()) {
        return Err(error(
            "speaker alignment is unavailable. Try a verbatim ASR prompt instead of translation or extensive rewriting; no speaker identities were invented.",
        ));
    }
    words.sort_by(|a, b| a.start.total_cmp(&b.start));
    let segments = if opts.return_timestamps || opts.diarization {
        if words.is_empty() {
            Some(vec![Segment {
                speaker: None,
                start: 0.0,
                end: duration,
                text: text.clone(),
            }])
        } else {
            Some(turns(&words))
        }
    } else {
        None
    };
    Ok(Transcription {
        text,
        segments,
        words: (!words.is_empty()).then_some(words),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn alternating_turns_are_not_merged_into_false_overlapping_speech() {
        let words = vec![
            WordResult {
                speaker: Some("spk:0".into()),
                start: 0.0,
                end: 0.4,
                text: "Yes".into(),
            },
            WordResult {
                speaker: Some("spk:1".into()),
                start: 0.5,
                end: 0.8,
                text: "Okay".into(),
            },
            WordResult {
                speaker: Some("spk:0".into()),
                start: 0.9,
                end: 1.2,
                text: "Thanks".into(),
            },
        ];
        let segments = turns(&words);
        assert_eq!(segments.len(), 3);
        assert!(segments[0].end <= segments[1].start);
        assert_eq!(segments[2].speaker.as_deref(), Some("spk:0"));
    }

    #[test]
    fn overlapping_speakers_keep_ids_and_source_times_without_prefixes_in_text() {
        let result = json!({"choices":[{"message":{"content":"<spk:0>Hello there.<spk:1>Hi!"}}],"transcription":{"words":[
            {"word":"Hello", "start":0.2,"end":0.6,"speaker":"spk:0"},
            {"word":"Hi!", "start":0.3,"end":0.8,"speaker":"spk:1"},
            {"word":"there.", "start":0.7,"end":1.1,"speaker":"spk:0"}
        ]}});
        let opts = TranscribeOptions {
            diarization: true,
            ..Default::default()
        };
        let parsed = parse(&result, 2.0, &opts).unwrap();
        assert!(!parsed.text.contains("<spk:"));
        let segments = parsed.segments.unwrap();
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].text, "Hello there.");
        assert_eq!(segments[0].speaker.as_deref(), Some("spk:0"));
        assert!(segments[1].start < segments[0].end);
        assert_eq!(parsed.words.unwrap()[1].speaker.as_deref(), Some("spk:1"));
    }

    #[test]
    fn missing_or_invalid_alignment_is_never_fabricated() {
        let opts = TranscribeOptions {
            diarization: true,
            ..Default::default()
        };
        for words in [
            json!([]),
            json!([{"word":"Hello","start":0,"end":1}]),
            json!([{"word":"Hello","start":-1,"end":1,"speaker":"spk:0"}]),
        ] {
            assert!(parse(&json!({"choices":[{"message":{"content":"Hello"}}],"transcription":{"words":words}}), 2.0, &opts).is_err());
        }
    }

    #[test]
    fn character_alignment_does_not_insert_spaces_inside_cjk_or_thai() {
        let mut text = String::new();
        for word in ["你", "好", "。"] {
            append_word(&mut text, word);
        }
        assert_eq!(text, "你好。");
        let mut text = String::new();
        for word in ["ส", "วั", "ส", "ดี"] {
            append_word(&mut text, word);
        }
        assert_eq!(text, "สวัสดี");
    }
}
