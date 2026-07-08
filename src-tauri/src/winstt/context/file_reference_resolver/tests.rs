use super::*;

// ─────────────────────────── helpers ───────────────────────────

/// Build a non-truncated [`FileRefIndex`] from a synthetic list of root-relative
/// paths — no filesystem, no [`WorkspaceIndex`] — so tokenization + gate behavior
/// is deterministic and platform-independent.
fn index(files: &[&str]) -> FileRefIndex {
    FileRefIndex::from_relpaths(files.iter().copied(), false)
}

/// Convenience: sorted lowercase token vec of a basename for tokenizer asserts.
fn toks(basename: &str) -> Vec<String> {
    let (set, _) = tokenize_basename(basename);
    let mut v: Vec<String> = set.into_iter().collect();
    v.sort();
    v
}

/// A representative synthetic workspace mirroring the real-tree shapes the design
/// verified. Reused across the resolution tests.
fn sample_index() -> FileRefIndex {
    index(&[
        "src-tauri/src/winstt/managers/context_manager.rs",
        "src-tauri/src/winstt/managers/realtime_manager.rs",
        "src-tauri/src/winstt/managers/tts_download_manager.rs",
        "src-tauri/src/winstt/transcription/realtime.rs",
        "src/authMiddleware.ts",
        "src/features/OllamaModelManagerDialog.tsx",
        "src-tauri/src/winstt/context/settings_schema.rs",
    ])
}

// ─────────────────────────── tokenization ───────────────────────────

#[test]
fn tokenizes_snake_camel_kebab_dot_and_digits() {
    assert_eq!(toks("context_manager.rs"), vec!["context", "manager"]);
    assert_eq!(toks("authMiddleware.ts"), vec!["auth", "middleware"]);
    assert_eq!(
        toks("OllamaModelManagerDialog.tsx"),
        vec!["dialog", "manager", "model", "ollama"]
    );
    assert_eq!(toks("realtime_manager.rs"), vec!["manager", "realtime"]);
    assert_eq!(
        toks("tts_download_manager.rs"),
        vec!["download", "manager", "tts"]
    );
    assert_eq!(toks("settings_schema.rs"), vec!["schema", "settings"]);
    // kebab + a `use` prefix.
    assert_eq!(toks("use-tts-playback.ts"), vec!["playback", "tts", "use"]);
}

#[test]
fn compound_extension_tails_keep_meaningful_tokens() {
    // `.test.ts` strips only `.ts`; `test` is not an ext but a meaningful token.
    assert_eq!(
        toks("settings-store.test.ts"),
        vec!["settings", "store", "test"]
    );
    // `.d.ts` → strip `.ts`, keep `d` — but `d` is single-letter, dropped from
    // the SALIENT set (still present in the raw set here).
    let (set, salient) = tokenize_basename("types.d.ts");
    assert!(set.contains("types"));
    // `types` is the only salient token (`d` is single-letter).
    assert_eq!(salient, 1);
}

#[test]
fn acronyms_collapse_to_one_salient_lowercase_token() {
    // All-caps runs stay whole (domain terms), lowercased, and are salient.
    let (set, salient) = tokenize_basename("TTS_download.rs");
    assert!(set.contains("tts"));
    assert!(set.contains("download"));
    assert_eq!(salient, 2);
    // `HTTPServer` → {http, server} via the ABBR boundary.
    assert_eq!(toks("HTTPServer.ts"), vec!["http", "server"]);
}

#[test]
fn basename_with_no_recognized_ext_keeps_whole_stem() {
    // `Makefile` has no recognized trailing ext segment → the whole name tokenizes.
    let (set, _) = tokenize_basename("Makefile");
    assert!(set.contains("makefile"));
}

// ─────────────── candidate extraction (spans / cue anchoring) ───────────────

/// Convenience: the ordered lowercase salient words of a [`Candidate`].
fn salient_words(c: &Candidate) -> Vec<String> {
    c.salient.iter().map(|t| t.lower.clone()).collect()
}

#[test]
fn cue_verb_frames_content_span() {
    let cands = extract_candidates("fix the auth middleware file to add logging");
    // One content run: "auth middleware" (drop leading fix/the, trailing "file").
    assert!(!cands.is_empty());
    let c = &cands[0];
    assert_eq!(salient_words(c), vec!["auth", "middleware"]);
    assert!(c.cue_anchored, "a cue verb + trailing cue noun must anchor");
}

#[test]
fn framing_stopword_anchors_span() {
    let cands = extract_candidates("open the context manager");
    let c = &cands[0];
    // "manager" stays salient (content-bearing, matches a file token).
    assert_eq!(salient_words(c), vec!["context", "manager"]);
    assert!(c.cue_anchored);
}

// ─────────────────────────── POSITIVES (should tag) ───────────────────────────

#[test]
fn tags_context_manager_uniquely() {
    let idx = sample_index();
    let out = resolve_descriptive_tags("open the context manager", true, &idx);
    assert_eq!(
        out,
        "open the @src-tauri/src/winstt/managers/context_manager.rs"
    );
}

#[test]
fn tags_auth_middleware_and_absorbs_trailing_file_noun() {
    let idx = sample_index();
    let out = resolve_descriptive_tags("fix the auth middleware file to add logging", true, &idx);
    // "auth middleware file" → @…/authMiddleware.ts (trailing "file" absorbed).
    assert_eq!(out, "fix the @src/authMiddleware.ts to add logging");
}

#[test]
fn realtime_manager_wins_because_plain_realtime_lacks_manager() {
    let idx = sample_index();
    // {realtime, manager}: only realtime_manager.rs carries BOTH — the plain
    // transcription/realtime.rs lacks `manager`, so the candidate set is unique.
    let out = resolve_descriptive_tags("edit the realtime manager", true, &idx);
    assert_eq!(
        out,
        "edit the @src-tauri/src/winstt/managers/realtime_manager.rs"
    );
}

#[test]
fn three_token_phrase_locks_tts_download_manager() {
    let idx = sample_index();
    let out = resolve_descriptive_tags("open the tts download manager", true, &idx);
    assert_eq!(
        out,
        "open the @src-tauri/src/winstt/managers/tts_download_manager.rs"
    );
}

#[test]
fn superset_match_tags_when_cue_anchored() {
    // {ollama, dialog}: only OllamaModelManagerDialog carries both (a superset —
    // it has extra tokens model/manager). A cue anchor permits the superset tag.
    let idx = sample_index();
    let out = resolve_descriptive_tags("open the ollama dialog", true, &idx);
    assert_eq!(out, "open the @src/features/OllamaModelManagerDialog.tsx");
}

#[test]
fn light_plural_stemming_matches_singular_token() {
    // Spoken "managers" (plural) stems to "manager" which the index bears.
    let idx = sample_index();
    let out = resolve_descriptive_tags("open the context managers", true, &idx);
    assert_eq!(
        out,
        "open the @src-tauri/src/winstt/managers/context_manager.rs"
    );
}

// ─────────────────────────── NEGATIVES (must ABSTAIN) ───────────────────────────

#[test]
fn single_token_description_abstains() {
    let idx = index(&[
        "src-tauri/src/winstt/managers/context_manager.rs",
        "src-tauri/src/winstt/managers/realtime_manager.rs",
    ]);
    // "the manager" → one salient token → ABSTAIN (unchanged).
    let input = "open the manager";
    assert_eq!(resolve_descriptive_tags(input, true, &idx), input);
    // "the settings" likewise.
    let idx2 = index(&["a/settings_store.rs", "b/settings.ts"]);
    let input2 = "check the settings";
    assert_eq!(resolve_descriptive_tags(input2, true, &idx2), input2);
}

#[test]
fn absent_token_yields_no_coverage_and_abstains() {
    let idx = sample_index();
    // "login flow" — neither token bears any file → coverage < 1.0 → ABSTAIN.
    let input = "fix the login flow";
    assert_eq!(resolve_descriptive_tags(input, true, &idx), input);
}

#[test]
fn two_token_tie_across_two_files_abstains() {
    // {settings, store} owned by TWO set-equal files (both BASENAMES tokenize to
    // exactly {settings, store}) → no strictly-unique carrier → ABSTAIN. Note the
    // directory is NOT tokenized, so a `settings/store.ts` would carry only
    // {store} — the tie needs both tokens IN the basename.
    let idx = index(&[
        "src-tauri/src/winstt/settings_store.rs",
        "src/state/settings-store.ts",
    ]);
    let input = "open the settings store";
    assert_eq!(resolve_descriptive_tags(input, true, &idx), input);
}

#[test]
fn sort_state_tie_abstains() {
    // {sort, state}: two distinct sort-state.ts (ollama + stt pickers) → tie.
    let idx = index(&[
        "src/features/ollama-picker/sort-state.ts",
        "src/features/stt-picker/sort-state.ts",
    ]);
    let input = "edit the sort state";
    assert_eq!(resolve_descriptive_tags(input, true, &idx), input);
}

#[test]
fn set_equal_module_wins_over_superset_manager() {
    // A plain `tts-download.rs` (basename set-equal to {tts,download}) AND a
    // `tts_download_manager.rs` (superset {tts,download,manager}) both carry the
    // full phrase {tts,download}. The UNIQUE set-equal owner is a strictly stronger
    // signal (the user named the file EXACTLY, no extra tokens) → it wins even
    // though a superset co-exists. (Precision-fix #1: set-equality beats supersets.
    // Two+ set-equal owners would still abstain — see `two_token_tie_across_*`.)
    // Note: a `tts/download.rs` would NOT be a {tts,download} owner — its basename
    // is `download.rs` → {download} — because the directory is never tokenized.
    let idx = index(&[
        "src-tauri/src/winstt/tts/tts-download.rs",
        "src-tauri/src/winstt/managers/tts_download_manager.rs",
    ]);
    let out = resolve_descriptive_tags("open the tts download", true, &idx);
    assert_eq!(out, "open the @src-tauri/src/winstt/tts/tts-download.rs");
}

#[test]
fn bare_superset_in_prose_without_cue_abstains() {
    // No cue verb, no framing stopword, no cue noun: "audio history" as ordinary
    // prose that merely intersects a basename must NOT tag. The file's salient set
    // is {audio, history, panel} (a SUPERSET of the {audio,history} phrase); a
    // bare superset without a cue anchor → ABSTAIN.
    let idx = index(&["src/features/history/audio-history-panel.tsx"]);
    // "and" is a stopword that is NOT a framing anchor, so it bounds the run
    // {audio, history} without anchoring it.
    let input = "broke and audio history and slow";
    assert_eq!(resolve_descriptive_tags(input, true, &idx), input);
}

#[test]
fn empty_candidate_set_abstains() {
    let idx = sample_index();
    // Two real tokens that never co-occur in any single basename → empty
    // intersection → ABSTAIN.
    let input = "open the auth schema";
    assert_eq!(resolve_descriptive_tags(input, true, &idx), input);
}

// ─────────────────────────── gate: truncation / non-IDE / empty ───────────────

#[test]
fn truncated_index_abstains() {
    let idx = FileRefIndex::from_relpaths(
        ["src-tauri/src/winstt/managers/context_manager.rs"],
        true, // truncated
    );
    let input = "open the context manager";
    assert_eq!(resolve_descriptive_tags(input, true, &idx), input);
}

#[test]
fn non_ide_leaves_text_unchanged() {
    let idx = sample_index();
    let input = "open the context manager";
    // is_ide = false → byte-for-byte unchanged.
    assert_eq!(resolve_descriptive_tags(input, false, &idx), input);
}

#[test]
fn empty_index_abstains() {
    let idx = index(&[]);
    let input = "open the context manager";
    assert_eq!(resolve_descriptive_tags(input, true, &idx), input);
}

#[test]
fn empty_output_unchanged() {
    let idx = sample_index();
    assert_eq!(resolve_descriptive_tags("", true, &idx), "");
}

// ─────────────────────────── idempotency ───────────────────────────

#[test]
fn re_running_is_a_no_op() {
    let idx = sample_index();
    let once = resolve_descriptive_tags("open the context manager", true, &idx);
    let twice = resolve_descriptive_tags(&once, true, &idx);
    assert_eq!(
        once, twice,
        "second pass must not change an already-tagged span"
    );
    assert_eq!(
        twice,
        "open the @src-tauri/src/winstt/managers/context_manager.rs"
    );
}

#[test]
fn already_tagged_path_is_not_retagged() {
    let idx = sample_index();
    // The path form already present: the descriptive scanner's tokens sit inside
    // the `@…` run (left_boundary_ok rejects the `@`), so no re-tag.
    let input = "open the @src-tauri/src/winstt/managers/context_manager.rs";
    assert_eq!(resolve_descriptive_tags(input, true, &idx), input);
}

// ─────────────────────────── boundary safety ───────────────────────────

#[test]
fn does_not_splice_immediately_after_a_sigil() {
    let idx = index(&["src/authMiddleware.ts"]);
    // The span "auth middleware" resolves, but it is glued to an `@` sigil: the
    // span start sits right after `@`, so `left_boundary_ok` is false → the splice
    // is skipped (no `@@`, no nested tag), text unchanged.
    let input = "@auth middleware";
    let out = resolve_descriptive_tags(input, true, &idx);
    assert_eq!(out, input, "must not splice right after a sigil");
    assert!(!out.contains("@@"), "never emit a double sigil: {out:?}");
}

#[test]
fn preserves_surrounding_text_verbatim() {
    let idx = sample_index();
    let out = resolve_descriptive_tags(
        "please open the context manager and then run the tests",
        true,
        &idx,
    );
    assert_eq!(
        out,
        "please open the @src-tauri/src/winstt/managers/context_manager.rs and then run the tests"
    );
}

// ─────────────────────────── multi-span replacement ───────────────────────────

#[test]
fn two_disjoint_spans_each_resolve_independently() {
    let idx = sample_index();
    let out = resolve_descriptive_tags(
        "open the context manager and edit the auth middleware",
        true,
        &idx,
    );
    assert_eq!(
        out,
        "open the @src-tauri/src/winstt/managers/context_manager.rs and edit the @src/authMiddleware.ts"
    );
}

// ─────────────────────────── inverted-index internals ───────────────────────────

#[test]
fn intersection_is_candidate_superset_set() {
    let idx = sample_index();
    // {context, manager} → exactly one file index (context_manager.rs).
    let c = idx.intersect(&["context".into(), "manager".into()]);
    assert_eq!(c.len(), 1);
    // {manager} alone → several files (all the *_manager.rs + the Dialog).
    let m = idx.intersect(&["manager".into()]);
    assert!(m.len() >= 3, "manager owned by multiple files: {m:?}");
    // An absent token → empty.
    assert!(idx.intersect(&["nonexistenttoken".into()]).is_empty());
}

#[test]
fn build_from_relpaths_marks_truncated_at_cap() {
    let names: Vec<String> = (0..MAX_INDEXED_FILES + 5)
        .map(|i| format!("dir/file_number{i}.rs"))
        .collect();
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let idx = FileRefIndex::from_relpaths(refs.iter().copied(), false);
    assert!(idx.is_truncated());
    assert!(idx.file_count() <= MAX_INDEXED_FILES);
}

// ───────────── recall fixes: greedy prefix + set-equal-wins + role-noun ─────────────

/// A richer synthetic workspace covering the recall-fix shapes: a 2-token file
/// whose phrase is followed by ordinary prose (prefix trimming), a set-equal file
/// shadowed by a superset (set-equal-wins), and role-noun-suffixed descriptions.
fn recall_index() -> FileRefIndex {
    index(&[
        "src-tauri/src/winstt/context/workspace_index.rs",
        "src-tauri/src/winstt/context/secret_scrub.rs",
        "src-tauri/src/winstt/context/ax_tree.rs",
        "src-tauri/src/winstt/context/prompt_sections.rs",
        "src-tauri/src/winstt/context/caret_join.rs",
        "src-tauri/examples/caret_join_cli.rs", // superset of {caret,join}
        "src-tauri/src/winstt/settings_schema.rs",
        "src/shared/config/settings-schema.test.ts", // superset of {settings,schema}
        "src-tauri/src/winstt/managers/download_manager.rs",
        "src-tauri/src/winstt/managers/tts_download_manager.rs", // superset of {download,manager}
        "src-tauri/src/winstt/managers/tts_manager.rs",
    ])
}

#[test]
fn trims_trailing_prose_to_the_filename_prefix() {
    // The dictated run keeps going into prose after the real filename phrase; the
    // gate must score the LONGEST leading prefix that resolves, not the whole run.
    let idx = recall_index();
    let out = resolve_descriptive_tags(
        "open the workspace index so I can check the enumeration",
        true,
        &idx,
    );
    assert_eq!(
        out,
        "open the @src-tauri/src/winstt/context/workspace_index.rs so I can check the enumeration"
    );
}

#[test]
fn trailing_prose_after_manager_phrase_still_tags() {
    let idx = recall_index();
    let out = resolve_descriptive_tags(
        "the download manager keeps stalling, look at its progress logic",
        true,
        &idx,
    );
    // {download,manager} is set-equal to download_manager.rs even though
    // tts_download_manager.rs is a superset — set-equal wins.
    assert_eq!(
        out,
        "the @src-tauri/src/winstt/managers/download_manager.rs keeps stalling, look at its progress logic"
    );
}

#[test]
fn set_equal_beats_a_superset_distractor() {
    // {settings,schema}: settings_schema.rs is set-equal; settings-schema.test.ts
    // is a superset ({settings,schema,test}). The unique set-equal owner wins.
    let idx = recall_index();
    let out = resolve_descriptive_tags(
        "add a new field to the settings schema for the timeout",
        true,
        &idx,
    );
    assert_eq!(
        out,
        "add a new field to the @src-tauri/src/winstt/settings_schema.rs for the timeout"
    );
}

#[test]
fn caret_join_beats_cli_superset() {
    // {caret,join}: caret_join.rs is set-equal; caret_join_cli.rs is a superset.
    let idx = recall_index();
    let out = resolve_descriptive_tags("edit the caret join module to skip spans", true, &idx);
    assert_eq!(
        out,
        "edit the @src-tauri/src/winstt/context/caret_join.rs to skip spans"
    );
}

#[test]
fn drops_trailing_role_noun_and_absorbs_its_span() {
    // "ax tree walker": role-noun "walker" is not a basename token → dropped from
    // the scored set AND absorbed into the replacement span.
    let idx = recall_index();
    let out = resolve_descriptive_tags("fix the ax tree walker in the context capture", true, &idx);
    assert_eq!(
        out,
        "fix the @src-tauri/src/winstt/context/ax_tree.rs in the context capture"
    );
}

#[test]
fn role_noun_code_is_dropped_and_absorbed() {
    let idx = recall_index();
    let out = resolve_descriptive_tags(
        "let's refactor the secret scrub code to redact api keys",
        true,
        &idx,
    );
    assert_eq!(
        out,
        "let's refactor the @src-tauri/src/winstt/context/secret_scrub.rs to redact api keys"
    );
}

#[test]
fn role_noun_builder_dropped_mid_sentence() {
    let idx = recall_index();
    let out = resolve_descriptive_tags(
        "the prompt sections builder drops the focused field",
        true,
        &idx,
    );
    assert_eq!(
        out,
        "the @src-tauri/src/winstt/context/prompt_sections.rs drops the focused field"
    );
}

#[test]
fn three_token_manager_prefix_survives_trailing_prose() {
    let idx = recall_index();
    let out = resolve_descriptive_tags(
        "the tts download manager pack got double nested",
        true,
        &idx,
    );
    assert_eq!(
        out,
        "the @src-tauri/src/winstt/managers/tts_download_manager.rs pack got double nested"
    );
}

// ───────────── recall fixes: PRECISION GUARDRAILS (must still ABSTAIN) ─────────────

#[test]
fn lone_superset_in_prose_without_any_cue_abstains() {
    // A bare superset match with NO cue anchor (no cue verb, no framing stopword,
    // no cue noun in the run) must abstain even after prefix trimming. {audio,
    // history} is a strict subset of the {audio,history,panel} basename; "and"
    // bounds the run without anchoring it.
    let idx = index(&["src/features/history/audio-history-panel.tsx"]);
    let input = "broke and audio history and slow";
    assert_eq!(resolve_descriptive_tags(input, true, &idx), input);
}

#[test]
fn two_set_equal_owners_after_prefix_trim_abstains() {
    // Two files both set-equal to {sort,state}; even though the run has trailing
    // prose, every viable prefix is either ambiguous or uncovered → ABSTAIN.
    let idx = index(&[
        "src/features/ollama-picker/sort-state.ts",
        "src/features/stt-picker/sort-state.ts",
    ]);
    let input = "edit the sort state before we ship it";
    assert_eq!(resolve_descriptive_tags(input, true, &idx), input);
}

#[test]
fn role_noun_alone_cannot_manufacture_a_match() {
    // At the 2-token floor the trailing role-noun is NOT dropped (dropping would
    // fall below the floor); "tree walker" must fully cover a basename to tag, and
    // "walker" is absent here → no coverage → ABSTAIN. A role-noun is never a
    // discriminator that can lift a single real token to a match on its own.
    let idx = index(&["src-tauri/src/winstt/context/ax_tree.rs"]);
    let input = "fix the tree walker";
    assert_eq!(resolve_descriptive_tags(input, true, &idx), input);
}

#[test]
fn prose_prefix_that_is_not_a_file_abstains() {
    // "memory usage" leads a prose run but no basename is set-equal to it → the
    // greedy prefix search finds no unique winner → ABSTAIN.
    let idx = recall_index();
    let input = "reduce the memory usage during transcription";
    assert_eq!(resolve_descriptive_tags(input, true, &idx), input);
}

#[test]
fn genuine_role_noun_that_is_a_basename_token_is_kept() {
    // When the trailing noun IS a real basename token ("…_handler.rs"), it must NOT
    // be dropped/absorbed — the full phrase is the filename.
    let idx = index(&["src-tauri/src/winstt/context/event_handler.rs"]);
    let out = resolve_descriptive_tags("open the event handler", true, &idx);
    assert_eq!(
        out,
        "open the @src-tauri/src/winstt/context/event_handler.rs"
    );
}
