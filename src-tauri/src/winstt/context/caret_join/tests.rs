use super::*;

/// One `join_for_insertion` fixture: `(output, beforeCaret, afterCaret, terms)`.
type JoinCase<'a> = (&'a str, Option<&'a str>, Option<&'a str>, &'a [&'a str]);

fn terms(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

// ─────────────────────────── continuation lowercasing ───────────────────────────

#[test]
fn title_case_transcript_after_and_is_lowercased_first_word_only() {
    // The E2E failure: beforeCaret "...smooth and " (mid-sentence, ends space),
    // transcript comes back title-case. Only the FIRST word is lowercased; the
    // rest of the (title-case) words are left to the LLM — but here we assert the
    // documented behaviour that ONLY the first word's casing is touched.
    let before = "We deployed the Kubernetes cluster yesterday. The rollout was smooth and ";
    let out = join_for_insertion(
        "The Migration Finished Ahead Of Schedule",
        Some(before),
        None,
        &terms(&[]),
    );
    // beforeCaret ends with a space → no leading space added, first word lowered.
    assert_eq!(out, "the Migration Finished Ahead Of Schedule");
    assert!(!out.contains("  "), "no double space: {out:?}");
}

#[test]
fn proper_noun_in_terms_is_not_lowercased() {
    let before = "we then migrated to ";
    let out = join_for_insertion(
        "Kubernetes rules everything",
        Some(before),
        None,
        &terms(&["Kubernetes"]),
    );
    assert_eq!(out, "Kubernetes rules everything");
}

#[test]
fn i_contractions_kept_capitalized_mid_sentence() {
    let before = "after the review ";
    for (input, expected) in [
        ("I'll ship it", "I'll ship it"),
        ("I am done", "I am done"),
        ("I've tested it", "I've tested it"),
    ] {
        let out = join_for_insertion(input, Some(before), None, &terms(&[]));
        assert_eq!(out, expected, "input {input:?}");
    }
}

#[test]
fn acronym_first_word_kept() {
    let before = "the response came back from the ";
    let out = join_for_insertion("API returned an error", Some(before), None, &terms(&[]));
    assert_eq!(out, "API returned an error");
}

#[test]
fn plain_lowercase_word_left_alone() {
    let before = "the build is ";
    let out = join_for_insertion("ready to ship", Some(before), None, &terms(&[]));
    assert_eq!(out, "ready to ship");
}

// ─────────────────────────── sentence start ───────────────────────────

#[test]
fn empty_before_caret_capitalizes() {
    let out = join_for_insertion("hello world", None, None, &terms(&[]));
    assert_eq!(out, "Hello world");
    let out2 = join_for_insertion("hello world", Some(""), None, &terms(&[]));
    assert_eq!(out2, "Hello world");
}

#[test]
fn terminal_period_capitalizes_and_spaces() {
    let before = "The rollout finished.";
    let out = join_for_insertion("everything is green", Some(before), None, &terms(&[]));
    // period end → capitalize; before has no trailing space → single leading space.
    assert_eq!(out, " Everything is green");
}

#[test]
fn terminal_with_trailing_closer_quote_still_capitalizes() {
    let before = "he said \"done.\" ";
    let out = join_for_insertion("next we ship", Some(before), None, &terms(&[]));
    assert_eq!(out, "Next we ship");
}

#[test]
fn colon_and_semicolon_treated_terminal() {
    let out = join_for_insertion("first item", Some("todo: "), None, &terms(&[]));
    assert_eq!(out, "First item");
    let out2 = join_for_insertion("also this", Some("done; "), None, &terms(&[]));
    assert_eq!(out2, "Also this");
}

#[test]
fn list_bullet_start_capitalizes() {
    let out = join_for_insertion("write the tests", Some("- "), None, &terms(&[]));
    assert_eq!(out, "Write the tests");
}

// ─────────────────────────── spacing ───────────────────────────

#[test]
fn single_space_inserted_when_no_trailing_space() {
    let out = join_for_insertion("world", Some("hello"), None, &terms(&[]));
    // "hello" ends mid-sentence (no terminal) → lowercase first + single space.
    assert_eq!(out, " world");
}

#[test]
fn no_double_space_when_before_ends_with_space() {
    let out = join_for_insertion("world", Some("hello "), None, &terms(&[]));
    assert_eq!(out, "world");
    assert!(!out.starts_with(' '));
}

#[test]
fn leading_whitespace_on_output_collapsed_against_trailing_space() {
    let out = join_for_insertion("   world", Some("hello "), None, &terms(&[]));
    assert_eq!(out, "world");
}

#[test]
fn opener_bracket_before_gets_no_space() {
    // beforeCaret ends with an opener "(" → no leading space, no case change forced.
    let out = join_for_insertion("note this", Some("see ("), None, &terms(&[]));
    assert_eq!(out, "note this");
}

// ─────────────────────────── after-caret punctuation dedup ───────────────────────────

#[test]
fn after_caret_comma_dedup() {
    // output ends with a comma AND afterCaret begins with a comma → drop one.
    let out = join_for_insertion(
        "and then we left,",
        Some("we arrived "),
        Some(", tired"),
        &terms(&[]),
    );
    assert_eq!(out, "and then we left");
}

#[test]
fn after_caret_period_dedup_with_leading_space() {
    let out = join_for_insertion("all done.", Some("the task is "), Some(" ."), &terms(&[]));
    assert_eq!(out, "all done");
}

#[test]
fn after_caret_non_matching_punct_not_stripped() {
    // afterCaret begins with '.', output ends with ',' → different, keep it.
    let out = join_for_insertion("first,", Some("the "), Some(". done"), &terms(&[]));
    assert_eq!(out, "first,");
}

// ─────────────────────────── idempotency ───────────────────────────

#[test]
fn join_is_idempotent() {
    let cases: &[JoinCase<'_>] = &[
        ("The Migration Finished", Some("smooth and "), None, &[]),
        ("hello", Some("hi"), None, &[]),
        ("everything green", Some("done. "), None, &[]),
        ("and then,", Some("we left "), Some(", tired"), &[]),
        ("Kubernetes wins", Some("we use "), None, &["Kubernetes"]),
        ("world", Some("say ("), None, &[]),
    ];
    for (output, before, after, t) in cases {
        let once = join_for_insertion(output, *before, *after, &terms(t));
        let twice = join_for_insertion(&once, *before, *after, &terms(t));
        assert_eq!(once, twice, "not idempotent for {output:?}");
    }
}

#[test]
fn empty_output_returns_empty() {
    assert_eq!(join_for_insertion("", Some("hi "), None, &terms(&[])), "");
}

#[test]
fn output_with_no_alpha_char_untouched_casing() {
    // Leading non-alpha char (d) → no case change; spacing still applies.
    let out = join_for_insertion("123 items", Some("we have "), None, &terms(&[]));
    assert_eq!(out, "123 items");
}

// ─────────────────────────── @file tagging ───────────────────────────

#[test]
fn at_filename_becomes_sigil() {
    let out = apply_ide_file_tags(
        "Please refactor at context_manager.rs to add retries",
        true,
        &terms(&["context_manager.rs"]),
    );
    assert_eq!(out, "Please refactor @context_manager.rs to add retries");
}

#[test]
fn capital_at_filename_becomes_sigil() {
    let out = apply_ide_file_tags(
        "Please refactor At context_manager.rs to add retries",
        true,
        &terms(&["context_manager.rs"]),
    );
    assert_eq!(out, "Please refactor @context_manager.rs to add retries");
}

#[test]
fn already_tagged_filename_untouched_no_double_sigil() {
    let out = apply_ide_file_tags(
        "Please refactor @context_manager.rs to add retries",
        true,
        &terms(&["context_manager.rs"]),
    );
    assert_eq!(out, "Please refactor @context_manager.rs to add retries");
    assert!(!out.contains("@@"));
}

#[test]
fn sigil_space_filename_collapsed() {
    let out = apply_ide_file_tags(
        "Please refactor @ context_manager.rs to add retries",
        true,
        &terms(&["context_manager.rs"]),
    );
    assert_eq!(out, "Please refactor @context_manager.rs to add retries");
    assert!(!out.contains("@@"));
}

#[test]
fn bare_filename_naturally_mentioned_is_tagged() {
    // Parity change: a KNOWN filename mentioned naturally (no spoken "at") is now
    // promoted to an @tag, matching Wispr Flow's file-tagging model.
    let out = apply_ide_file_tags(
        "Open context_manager.rs now",
        true,
        &terms(&["context_manager.rs"]),
    );
    assert_eq!(out, "Open @context_manager.rs now");
}

#[test]
fn bare_filename_mid_sentence_natural_mention_tagged() {
    let out = apply_ide_file_tags(
        "fix the bug in authCheck.ts before shipping",
        true,
        &terms(&["authCheck.ts"]),
    );
    assert_eq!(out, "fix the bug in @authCheck.ts before shipping");
}

#[test]
fn bare_filename_not_in_terms_is_not_tagged() {
    // Precision guard: a filename mentioned in passing but NOT present in the
    // captured context term list is left untouched — we never invent a tag.
    let out = apply_ide_file_tags(
        "the results are in report.md and summary.md",
        true,
        &terms(&["report.md"]),
    );
    assert_eq!(out, "the results are in @report.md and summary.md");
}

#[test]
fn prose_word_resembling_filename_not_in_terms_untouched() {
    // "example.com" looks filename-shaped but is NOT in terms → never tagged,
    // even though it appears in the utterance.
    let out = apply_ide_file_tags(
        "visit example.com then edit main.rs",
        true,
        &terms(&["main.rs"]),
    );
    assert_eq!(out, "visit example.com then edit @main.rs");
}

#[test]
fn tag_trigger_word_tags_and_drops_nothing_extra() {
    let out = apply_ide_file_tags(
        "please tag context_manager.rs for me",
        true,
        &terms(&["context_manager.rs"]),
    );
    assert_eq!(out, "please @context_manager.rs for me");
    assert!(!out.contains("tag @"));
}

#[test]
fn tagged_trigger_word_tags_and_drops_nothing_extra() {
    let out = apply_ide_file_tags("I tagged utils.py earlier", true, &terms(&["utils.py"]));
    assert_eq!(out, "I @utils.py earlier");
    assert!(!out.contains("tagged @"));
}

#[test]
fn capitalized_tag_trigger_at_sentence_start_tags() {
    let out = apply_ide_file_tags("Tag main.rs now", true, &terms(&["main.rs"]));
    assert_eq!(out, "@main.rs now");
}

#[test]
fn natural_mention_pass_is_idempotent_no_double_sigil() {
    let t = terms(&["context_manager.rs"]);
    let input = "Open context_manager.rs now";
    let once = apply_ide_file_tags(input, true, &t);
    let twice = apply_ide_file_tags(&once, true, &t);
    assert_eq!(once, twice);
    assert!(!twice.contains("@@"));
}

#[test]
fn bare_natural_mention_word_boundary_safe() {
    // Only "config.rs" is a term; a bare "format.rs" (not a term) must be
    // untouched, and "config.rs" must not be caught as a substring of a longer
    // token like "myconfig.rs".
    let out = apply_ide_file_tags(
        "run format.rs then config.rs and skip myconfig.rs",
        true,
        &terms(&["config.rs"]),
    );
    assert_eq!(out, "run format.rs then @config.rs and skip myconfig.rs");
}

#[test]
fn longest_first_ordering_when_terms_share_suffix() {
    // Both "main.test.tsx" and "test.tsx" are terms; the longer must tag the full
    // token, and the shorter must not partially match inside it.
    let out = apply_ide_file_tags(
        "look at main.test.tsx quickly",
        true,
        &terms(&["test.tsx", "main.test.tsx"]),
    );
    assert_eq!(out, "look @main.test.tsx quickly");
    assert!(!out.contains("@@"));
    // A standalone "test.tsx" elsewhere still tags.
    let out2 = apply_ide_file_tags(
        "and test.tsx separately",
        true,
        &terms(&["test.tsx", "main.test.tsx"]),
    );
    assert_eq!(out2, "and @test.tsx separately");
}

#[test]
fn natural_mention_casing_preserved() {
    let out = apply_ide_file_tags(
        "review AuthCheck.TS please",
        true,
        &terms(&["AuthCheck.TS"]),
    );
    assert_eq!(out, "review @AuthCheck.TS please");
}

#[test]
fn multiple_distinct_natural_mentions_all_tagged() {
    let out = apply_ide_file_tags(
        "compare utils.py with main.rs in this diff",
        true,
        &terms(&["utils.py", "main.rs"]),
    );
    assert_eq!(out, "compare @utils.py with @main.rs in this diff");
}

#[test]
fn natural_mention_non_ide_untouched() {
    let out = apply_ide_file_tags(
        "Open context_manager.rs now",
        false,
        &terms(&["context_manager.rs"]),
    );
    assert_eq!(out, "Open context_manager.rs now");
}

#[test]
fn non_ide_leaves_text_untouched() {
    let out = apply_ide_file_tags(
        "Please refactor at context_manager.rs to add retries",
        false,
        &terms(&["context_manager.rs"]),
    );
    assert_eq!(out, "Please refactor at context_manager.rs to add retries");
}

#[test]
fn non_filename_terms_do_not_tag() {
    // "retries" is not a filename; "at retries" must NOT become "@retries".
    let out = apply_ide_file_tags(
        "Please add at retries here",
        true,
        &terms(&["retries", "somevar"]),
    );
    assert_eq!(out, "Please add at retries here");
}

#[test]
fn word_boundary_prevents_substring_retag() {
    // "at config.rs" should tag, but "format.rs" must not be caught by "at.rs".
    let out = apply_ide_file_tags(
        "run format.rs and at config.rs now",
        true,
        &terms(&["config.rs"]),
    );
    assert_eq!(out, "run format.rs and @config.rs now");
}

#[test]
fn file_tag_is_idempotent() {
    let t = terms(&["context_manager.rs"]);
    let input = "Please refactor at context_manager.rs to add retries";
    let once = apply_ide_file_tags(input, true, &t);
    let twice = apply_ide_file_tags(&once, true, &t);
    assert_eq!(once, twice);
}

#[test]
fn multiple_filenames_all_tagged() {
    let out = apply_ide_file_tags(
        "check at utils.py and at main.rs please",
        true,
        &terms(&["utils.py", "main.rs"]),
    );
    assert_eq!(out, "check @utils.py and @main.rs please");
}

// ─────────────────────────── helper unit checks ───────────────────────────

#[test]
fn taggable_filename_detection() {
    assert!(looks_like_taggable_filename("context_manager.rs"));
    assert!(looks_like_taggable_filename("README.md"));
    assert!(looks_like_taggable_filename("main.test.tsx"));
    assert!(!looks_like_taggable_filename("just_a_word"));
    assert!(!looks_like_taggable_filename("foo.unknownext"));
    assert!(!looks_like_taggable_filename("has space.rs"));
    assert!(!looks_like_taggable_filename(".rs"));
    assert!(!looks_like_taggable_filename("trailing."));
}

#[test]
fn acronym_detection() {
    assert!(is_acronym("API"));
    assert!(is_acronym("H264"));
    assert!(is_acronym("RFC"));
    assert!(!is_acronym("I"));
    assert!(!is_acronym("Api"));
    assert!(!is_acronym("hello"));
}

// ─────────────────── workspace tagging support (case a) ───────────────────

#[test]
fn extract_taggable_filenames_finds_spoken_files() {
    let names = extract_taggable_filenames("look at context_manager.rs and also README.md please");
    assert!(names.contains(&"context_manager.rs".to_string()));
    assert!(names.contains(&"README.md".to_string()));
}

#[test]
fn extract_taggable_filenames_skips_non_filenames_and_already_tagged() {
    // Plain words, unknown extensions, and an already-sigilled token don't count.
    let names = extract_taggable_filenames("the function reads config and @main.rs is fine");
    assert!(names.iter().all(|n| n != "config"));
    // "@main.rs" is at a bad left boundary (preceded by '@'), so bare "main.rs"
    // is NOT extracted from inside it.
    assert!(names.iter().all(|n| n != "main.rs"));
}

#[test]
fn extract_taggable_filenames_dedups() {
    let names = extract_taggable_filenames("utils.py then utils.py again");
    assert_eq!(names.iter().filter(|n| *n == "utils.py").count(), 1);
}

#[test]
fn upgrade_unique_basename_to_relpath() {
    // A unique basename → replace the bare `@name` with the `@rel/path`.
    let out = upgrade_tags_to_paths("edit @caret_join.rs now", true, |b| {
        (b == "caret_join.rs").then(|| "src/winstt/context/caret_join.rs".to_string())
    });
    assert_eq!(out, "edit @src/winstt/context/caret_join.rs now");
}

#[test]
fn upgrade_leaves_ambiguous_basename_bare() {
    // resolve_unique returns None (collision / truncated) → keep the bare tag.
    let out = upgrade_tags_to_paths("open @index.ts here", true, |_| None);
    assert_eq!(out, "open @index.ts here");
}

#[test]
fn upgrade_is_idempotent_and_noop_off_ide() {
    let resolve =
        |b: &str| (b == "caret_join.rs").then(|| "src/winstt/context/caret_join.rs".to_string());
    let once = upgrade_tags_to_paths("see @caret_join.rs", true, resolve);
    let twice = upgrade_tags_to_paths(&once, true, resolve);
    assert_eq!(once, twice, "path upgrade must be idempotent");
    // Off-IDE: never upgrade.
    assert_eq!(
        upgrade_tags_to_paths("see @caret_join.rs", false, resolve),
        "see @caret_join.rs"
    );
}

#[test]
fn full_workspace_tag_flow_tags_spoken_file_not_on_screen() {
    // End-to-end at the caret_join level: a file NOT in context_terms but present
    // in the (simulated) workspace-augmented KNOWN set gets tagged; a random word
    // that isn't a real file is NOT tagged.
    let text = "please open context_manager.rs to see the bug";
    // Simulate the wiring's union: workspace basename spoken → added to known.
    let spoken = extract_taggable_filenames(text);
    assert!(spoken.contains(&"context_manager.rs".to_string()));
    let known = vec!["context_manager.rs".to_string()];
    let tagged = apply_ide_file_tags(text, true, &known);
    assert!(tagged.contains("@context_manager.rs"));
    // A random non-file word is never tagged.
    assert!(!tagged.contains("@please"));

    // And the unique-path upgrade turns it into a workspace-relative reference.
    let upgraded = upgrade_tags_to_paths(&tagged, true, |b| {
        (b == "context_manager.rs").then(|| "src/winstt/context/context_manager.rs".to_string())
    });
    assert!(upgraded.contains("@src/winstt/context/context_manager.rs"));
}

#[test]
fn upgrade_normalizes_root_level_casing() {
    // A root-level unique file: the upgrade rewrites the spoken-cased tag to the
    // on-disk casing even with no directory path (the union tags the spoken form,
    // the upgrade fixes casing from the index's ground truth).
    let tagged = apply_ide_file_tags("check config.toml now", true, &["config.toml".to_string()]);
    assert_eq!(tagged, "check @config.toml now");
    let upgraded = upgrade_tags_to_paths(&tagged, true, |b| {
        (b == "config.toml").then(|| "Config.toml".to_string())
    });
    assert_eq!(upgraded, "check @Config.toml now");
}
