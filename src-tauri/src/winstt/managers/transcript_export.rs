//! Stable transcript export document and pure serializers.

use serde::Serialize;

use crate::winstt::settings_schema::FileTranscriptionFormat;
use crate::winstt::stt::{Segment, Transcription, WordResult};

pub const TRANSCRIPT_SCHEMA: &str = "winstt.transcript.v1";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDocument {
    pub schema: &'static str,
    pub created_at: String,
    pub model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub duration_seconds: f64,
    pub source_file: String,
    pub text: String,
    pub segments: Vec<ExportSegment>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ExportSegment {
    pub id: u32,
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    pub words: Vec<ExportWord>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ExportWord {
    pub text: String,
    pub start: f64,
    pub end: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
}

impl TranscriptDocument {
    pub fn from_transcription(
        transcription: &Transcription,
        created_at: String,
        model_id: String,
        language: Option<String>,
        duration_seconds: f64,
        source_file: String,
    ) -> Self {
        let duration_seconds = duration_seconds.max(0.0);
        let source_segments = transcription
            .segments
            .clone()
            .filter(|segments| !segments.is_empty())
            .unwrap_or_else(|| {
                vec![Segment {
                    speaker: None,
                    start: 0.0,
                    end: duration_seconds.max(0.001) as f32,
                    text: transcription.text.clone(),
                }]
            });
        let words = transcription.words.as_deref().unwrap_or_default();
        let segments = source_segments
            .into_iter()
            .enumerate()
            .map(|(index, segment)| {
                let segment_words = words_for_segment(words, &segment)
                    .into_iter()
                    .map(export_word)
                    .collect();
                ExportSegment {
                    id: index as u32,
                    start: f64::from(segment.start.max(0.0)),
                    end: f64::from(segment.end.max(segment.start)),
                    text: segment.text,
                    speaker: segment.speaker,
                    words: segment_words,
                }
            })
            .collect();

        Self {
            schema: TRANSCRIPT_SCHEMA,
            created_at,
            model_id,
            language,
            duration_seconds,
            source_file,
            text: transcription.text.clone(),
            segments,
        }
    }
}

fn words_for_segment<'a>(words: &'a [WordResult], segment: &Segment) -> Vec<&'a WordResult> {
    words
        .iter()
        .filter(|word| {
            let midpoint = (word.start + word.end) / 2.0;
            midpoint >= segment.start && midpoint <= segment.end && word.speaker == segment.speaker
        })
        .collect()
}

fn export_word(word: &WordResult) -> ExportWord {
    ExportWord {
        text: word.text.clone(),
        start: f64::from(word.start.max(0.0)),
        end: f64::from(word.end.max(word.start)),
        confidence: None,
        speaker: word.speaker.clone(),
    }
}

pub fn speaker_label(id: &str) -> String {
    id.strip_prefix("spk:")
        .and_then(|n| n.parse::<u32>().ok())
        .map_or_else(
            || id.to_string(),
            |n| format!("Speaker {}", n.saturating_add(1)),
        )
}

pub fn plain_text(transcription: &Transcription, prefixes: bool) -> String {
    if prefixes
        && let Some(segments) = &transcription.segments
        && segments.iter().any(|s| s.speaker.is_some())
    {
        return segments
            .iter()
            .map(|s| prefixed(&s.text, s.speaker.as_deref(), true))
            .collect::<Vec<_>>()
            .join("\n");
    }
    transcription.text.clone()
}

fn prefixed(text: &str, speaker: Option<&str>, prefixes: bool) -> String {
    if prefixes && let Some(speaker) = speaker {
        return format!("{}: {}", speaker_label(speaker), text.trim());
    }
    text.trim().to_string()
}

pub fn serialize_with_speaker_prefixes(
    format: FileTranscriptionFormat,
    doc: &TranscriptDocument,
    prefixes: bool,
) -> String {
    match format {
        FileTranscriptionFormat::Txt
            if prefixes && doc.segments.iter().any(|s| s.speaker.is_some()) =>
        {
            let mut output = doc
                .segments
                .iter()
                .map(|s| prefixed(&s.text, s.speaker.as_deref(), true))
                .collect::<Vec<_>>()
                .join("\n");
            output.push('\n');
            output
        }
        FileTranscriptionFormat::Srt if prefixes => serialize_srt_with_prefixes(doc, true),
        _ => serialize(format, doc),
    }
}

pub fn serialize(format: FileTranscriptionFormat, doc: &TranscriptDocument) -> String {
    match format {
        FileTranscriptionFormat::Txt => serialize_txt(doc),
        FileTranscriptionFormat::Srt => serialize_srt(doc),
        FileTranscriptionFormat::Vtt => serialize_vtt(doc),
        FileTranscriptionFormat::Json => serialize_json(doc),
        FileTranscriptionFormat::Csv => serialize_csv(doc),
    }
}

pub fn serialize_txt(doc: &TranscriptDocument) -> String {
    let mut output = doc.text.trim_end().to_string();
    output.push('\n');
    output
}

pub fn serialize_srt(doc: &TranscriptDocument) -> String {
    serialize_srt_with_prefixes(doc, false)
}

fn serialize_srt_with_prefixes(doc: &TranscriptDocument, prefixes: bool) -> String {
    let mut output = String::new();
    for (index, segment) in doc.segments.iter().enumerate() {
        let (start, end) = cue_bounds(segment.start, segment.end);
        output.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            index + 1,
            format_srt_timestamp(start),
            format_srt_timestamp(end),
            prefixed(&segment.text, segment.speaker.as_deref(), prefixes)
        ));
    }
    output
}

pub fn serialize_vtt(doc: &TranscriptDocument) -> String {
    let mut output = String::from("WEBVTT\n\n");
    for (index, segment) in doc.segments.iter().enumerate() {
        let (start, end) = cue_bounds(segment.start, segment.end);
        output.push_str(&(index + 1).to_string());
        output.push('\n');
        output.push_str(&format!(
            "{} --> {}\n",
            format_vtt_timestamp(start),
            format_vtt_timestamp(end)
        ));
        let text = vtt_escape(segment.text.trim());
        if let Some(speaker) = segment.speaker.as_deref() {
            output.push_str(&format!(
                "<v {}>{text}",
                vtt_escape(&speaker_label(speaker))
            ));
        } else {
            output.push_str(&text);
        }
        output.push_str("\n\n");
    }
    output
}

pub fn serialize_json(doc: &TranscriptDocument) -> String {
    serde_json::to_string_pretty(doc).expect("TranscriptDocument is always JSON serializable")
}

pub fn serialize_csv(doc: &TranscriptDocument) -> String {
    let mut output = String::from("segment,start,end,speaker,text\r\n");
    for segment in &doc.segments {
        output.push_str(&format!(
            "{},{:.3},{:.3},{},{}\r\n",
            segment.id,
            segment.start,
            segment.end,
            csv_escape(segment.speaker.as_deref().unwrap_or_default()),
            csv_escape(&segment.text)
        ));
    }
    output
}

fn cue_bounds(start: f64, end: f64) -> (f64, f64) {
    let start = if start.is_finite() {
        start.max(0.0)
    } else {
        0.0
    };
    let end = if end.is_finite() { end.max(0.0) } else { start };
    (start, end.max(start + 0.001))
}

fn format_timestamp(seconds: f64, separator: char) -> String {
    let total_ms = (seconds.max(0.0) * 1000.0).round() as u64;
    let ms = total_ms % 1000;
    let total_seconds = total_ms / 1000;
    let seconds = total_seconds % 60;
    let total_minutes = total_seconds / 60;
    let minutes = total_minutes % 60;
    let hours = total_minutes / 60;
    format!("{hours:02}:{minutes:02}:{seconds:02}{separator}{ms:03}")
}

fn format_srt_timestamp(seconds: f64) -> String {
    format_timestamp(seconds, ',')
}

fn format_vtt_timestamp(seconds: f64) -> String {
    format_timestamp(seconds, '.')
}

fn csv_escape(field: &str) -> String {
    if field.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}

fn vtt_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> TranscriptDocument {
        TranscriptDocument {
            schema: TRANSCRIPT_SCHEMA,
            created_at: "2026-07-14T12:00:00Z".into(),
            model_id: "whisper-test".into(),
            language: Some("en".into()),
            duration_seconds: 3662.0,
            source_file: "talk.mp4".into(),
            text: "Hello & <world>. Next line.".into(),
            segments: vec![
                ExportSegment {
                    id: 0,
                    start: 0.0,
                    end: 1.25,
                    text: "Hello & <world>.".into(),
                    speaker: None,
                    words: vec![ExportWord {
                        text: "Hello".into(),
                        start: 0.0,
                        end: 0.5,
                        confidence: None,
                        speaker: None,
                    }],
                },
                ExportSegment {
                    id: 1,
                    start: 1.0,
                    end: 1.0,
                    text: "Next line.".into(),
                    speaker: Some("Speaker & One".into()),
                    words: vec![],
                },
                ExportSegment {
                    id: 2,
                    start: 3661.5,
                    end: 3662.0,
                    text: "Long recording".into(),
                    speaker: None,
                    words: vec![],
                },
            ],
        }
    }

    #[test]
    fn diarized_exports_preserve_metadata_and_only_prefix_requested_plain_formats() {
        let transcription = Transcription {
            text: "Hello. Hi!".into(),
            segments: Some(vec![
                Segment {
                    speaker: Some("spk:0".into()),
                    start: 0.0,
                    end: 1.0,
                    text: "Hello.".into(),
                },
                Segment {
                    speaker: Some("spk:1".into()),
                    start: 0.5,
                    end: 1.5,
                    text: "Hi!".into(),
                },
            ]),
            words: Some(vec![
                WordResult {
                    speaker: Some("spk:0".into()),
                    start: 0.0,
                    end: 1.0,
                    text: "Hello.".into(),
                },
                WordResult {
                    speaker: Some("spk:1".into()),
                    start: 0.5,
                    end: 1.5,
                    text: "Hi!".into(),
                },
            ]),
        };
        let doc = TranscriptDocument::from_transcription(
            &transcription,
            "now".into(),
            "native".into(),
            None,
            2.0,
            "talk.wav".into(),
        );
        assert_eq!(doc.segments[0].words.len(), 1);
        // An unassigned overlapping turn must not absorb another speaker's words.
        let unknown = Segment {
            speaker: None,
            start: 0.3,
            end: 0.9,
            text: "Unknown".into(),
        };
        assert!(words_for_segment(transcription.words.as_deref().unwrap(), &unknown).is_empty());
        assert_eq!(doc.segments[0].words[0].speaker.as_deref(), Some("spk:0"));
        assert_eq!(
            serialize_with_speaker_prefixes(FileTranscriptionFormat::Txt, &doc, false),
            "Hello. Hi!\n"
        );
        assert_eq!(
            serialize_with_speaker_prefixes(FileTranscriptionFormat::Txt, &doc, true),
            "Speaker 1: Hello.\nSpeaker 2: Hi!\n"
        );
        assert!(
            serialize_with_speaker_prefixes(FileTranscriptionFormat::Srt, &doc, true)
                .contains("Speaker 2: Hi!")
        );
        assert!(
            !serialize_with_speaker_prefixes(FileTranscriptionFormat::Srt, &doc, false)
                .contains("Speaker 2:")
        );
        assert!(serialize_vtt(&doc).contains("<v Speaker 2>Hi!"));
        assert!(serialize_csv(&doc).contains(",spk:1,Hi!"));
        let json = serialize_json(&doc);
        assert!(json.contains("\"speaker\": \"spk:1\""));
        assert!(!json.contains("Speaker 2:"));
        assert_eq!(
            plain_text(&transcription, true),
            "Speaker 1: Hello.\nSpeaker 2: Hi!"
        );
        assert_eq!(plain_text(&transcription, false), transcription.text);
    }

    #[test]
    fn srt_emits_per_segment_cues_with_comma_millis() {
        let output = serialize_srt(&fixture());
        assert!(output.contains("1\n00:00:00,000 --> 00:00:01,250"));
        assert!(output.contains("3\n01:01:01,500 --> 01:01:02,000"));
    }

    #[test]
    fn vtt_emits_header_escaping_voice_tag_and_dot_millis() {
        let output = serialize_vtt(&fixture());
        assert!(output.starts_with("WEBVTT\n\n"));
        assert!(output.contains("Hello &amp; &lt;world&gt;."));
        assert!(output.contains("<v Speaker &amp; One>Next line."));
        assert!(output.contains("01:01:01.500 --> 01:01:02.000"));
    }

    #[test]
    fn zero_length_cues_are_bumped_and_overlaps_are_preserved() {
        let output = serialize_vtt(&fixture());
        assert!(output.contains("00:00:01.000 --> 00:00:01.001"));
    }

    #[test]
    fn json_has_stable_schema_and_empty_words_without_null_optionals() {
        let output = serialize_json(&fixture());
        assert!(output.contains("\"schema\": \"winstt.transcript.v1\""));
        assert!(output.contains("\"words\": []"));
        assert!(!output.contains("confidence"));
    }

    #[test]
    fn json_schema_v1_matches_the_stable_wire_shape() {
        let doc = TranscriptDocument {
            schema: TRANSCRIPT_SCHEMA,
            created_at: "2026-07-14T12:00:00Z".into(),
            model_id: "whisper-test".into(),
            language: None,
            duration_seconds: 1.0,
            source_file: "talk.wav".into(),
            text: "Hello".into(),
            segments: vec![ExportSegment {
                id: 0,
                start: 0.0,
                end: 1.0,
                text: "Hello".into(),
                speaker: None,
                words: vec![],
            }],
        };

        assert_eq!(
            serialize_json(&doc),
            r#"{
  "schema": "winstt.transcript.v1",
  "createdAt": "2026-07-14T12:00:00Z",
  "modelId": "whisper-test",
  "durationSeconds": 1.0,
  "sourceFile": "talk.wav",
  "text": "Hello",
  "segments": [
    {
      "id": 0,
      "start": 0.0,
      "end": 1.0,
      "text": "Hello",
      "words": []
    }
  ]
}"#
        );
    }

    #[test]
    fn csv_uses_rfc4180_escaping() {
        let mut doc = fixture();
        doc.segments[0].text = "one, \"two\"\nthree".into();
        let output = serialize_csv(&doc);
        assert!(output.contains("\"one, \"\"two\"\"\nthree\"\r\n"));
        assert!(output.contains("1.250"));
    }

    #[test]
    fn rtl_text_survives_every_serializer() {
        let arabic = "مرحبا بالعالم";
        let transcription = Transcription {
            text: arabic.into(),
            ..Default::default()
        };
        let doc = TranscriptDocument::from_transcription(
            &transcription,
            String::new(),
            String::new(),
            None,
            1.0,
            String::new(),
        );
        for output in [
            serialize_txt(&doc),
            serialize_srt(&doc),
            serialize_vtt(&doc),
            serialize_json(&doc),
            serialize_csv(&doc),
        ] {
            assert!(output.contains(arabic));
        }
    }

    #[test]
    fn no_segments_degrades_to_one_full_duration_segment() {
        let transcription = Transcription {
            text: "Fallback".into(),
            ..Default::default()
        };
        let doc = TranscriptDocument::from_transcription(
            &transcription,
            String::new(),
            String::new(),
            None,
            2.5,
            String::new(),
        );
        assert_eq!(doc.segments.len(), 1);
        assert_eq!(doc.segments[0].start, 0.0);
        assert_eq!(doc.segments[0].end, 2.5);
    }

    #[test]
    fn words_are_attached_to_the_segment_containing_their_midpoint() {
        let transcription = Transcription {
            text: "one two".into(),
            segments: Some(vec![
                Segment {
                    speaker: None,
                    start: 0.0,
                    end: 1.0,
                    text: "one".into(),
                },
                Segment {
                    speaker: None,
                    start: 1.0,
                    end: 2.0,
                    text: "two".into(),
                },
            ]),
            words: Some(vec![
                WordResult {
                    speaker: None,
                    text: "one".into(),
                    start: 0.1,
                    end: 0.5,
                },
                WordResult {
                    speaker: None,
                    text: "two".into(),
                    start: 1.2,
                    end: 1.6,
                },
            ]),
        };
        let doc = TranscriptDocument::from_transcription(
            &transcription,
            String::new(),
            String::new(),
            None,
            2.0,
            String::new(),
        );

        assert_eq!(doc.segments[0].words[0].text, "one");
        assert_eq!(doc.segments[1].words[0].text, "two");
    }
}
