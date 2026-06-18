// Dictation LLM prompt harness. Builds the EXACT dictation system + user prompts the app uses
// (`build_dictation_system_prompt` / `dictation_user_prompt_for_presets`) for a set of
// dictionary/vocabulary test cases, and emits them as JSON for a runner to send to a local LLM.
//
//   cargo run --example dictation_prompt_cases > cases.json
//   python ../tools/bench/run_dictation_cases.py cases.json [model]   # POSTs each to Ollama
//
// The point: now that the dictionary is an LLM-ONLY feature (no deterministic fuzzy/replace pass),
// verify the model honors the structured <preferred-terms> / <replacement-pairs> blocks — fixing
// real mis-transcriptions (veet -> Vite, oh llama -> ollama) while leaving correct common words
// alone (video stays video) and never inserting an unspoken term. NOT shipped — a dev harness.

use winstt_app_lib::winstt::llm::{
    build_dictation_system_prompt, dictation_user_prompt_for_presets, PresetEntry, PresetKey, Vocab,
};

struct Case {
    name: &'static str,
    raw: &'static str,
    dictionary: &'static [&'static str],
    pairs: &'static [(&'static str, &'static str)],
    expect_contains: &'static [&'static str],
    expect_absent: &'static [&'static str],
}

const CASES: &[Case] = &[
    Case {
        name: "real word 'video' is NOT replaced by 'Vite'",
        raw: "I watched a video this morning before the meeting.",
        dictionary: &["Vite"],
        pairs: &[],
        expect_contains: &["video"],
        expect_absent: &["Vite"],
    },
    Case {
        name: "phonetic near-miss 'veet' -> 'Vite' (build-tool context)",
        raw: "I switched the project from webpack to veet for faster builds.",
        dictionary: &["Vite"],
        pairs: &[],
        expect_contains: &["Vite"],
        expect_absent: &[],
    },
    Case {
        name: "split mis-transcription 'oh llama' -> 'ollama'",
        raw: "I ran the model locally with oh llama last night.",
        dictionary: &["ollama"],
        pairs: &[],
        expect_contains: &["ollama"],
        expect_absent: &[],
    },
    Case {
        name: "no false insertion when nothing matches",
        raw: "Will it transcribe the text cleanly?",
        dictionary: &["Vite", "ollama"],
        pairs: &[],
        expect_contains: &["transcribe"],
        expect_absent: &["Vite", "ollama"],
    },
    Case {
        name: "replacement pair: github -> GitHub",
        raw: "push the branch to github when you are done.",
        dictionary: &[],
        pairs: &[("github", "GitHub")],
        expect_contains: &["GitHub"],
        expect_absent: &[],
    },
];

fn main() {
    // Neutral cleanup preset = the default dictation pass (no tone rewrite).
    let presets = vec![PresetEntry::Builtin {
        key: PresetKey::Neutral,
        level: None,
        target_lang: None,
    }];

    let out: Vec<_> = CASES
        .iter()
        .map(|c| {
            let vocab = Vocab {
                dictionary: c.dictionary.iter().map(|s| s.to_string()).collect(),
                replacement_pairs: c
                    .pairs
                    .iter()
                    .map(|(a, b)| (a.to_string(), b.to_string()))
                    .collect(),
                snippets: Vec::new(),
            };
            let system = build_dictation_system_prompt(&presets, "", &vocab);
            let user = dictation_user_prompt_for_presets(&presets, c.raw);
            serde_json::json!({
                "name": c.name,
                "raw": c.raw,
                "system": system,
                "user": user,
                "expect_contains": c.expect_contains,
                "expect_absent": c.expect_absent,
            })
        })
        .collect();

    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
