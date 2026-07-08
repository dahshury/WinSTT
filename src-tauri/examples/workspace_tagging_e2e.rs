//! workspace_tagging_e2e — real-data end-to-end harness for workspace-wide IDE
//! `@file` tagging (Wispr-parity "the right file in your workspace").
//!
//! Drives the PRODUCTION pipeline against the REAL WinSTT repo as the workspace,
//! read-only, mirroring `actions::post_process::apply_caret_join`'s wiring:
//!   1. root discovery: `resolve_root(<real Cursor window title>, "cursor.exe")`
//!      decodes the machine's real `%APPDATA%\Cursor\User\workspaceStorage` pool
//!      and matches the title's rootName → an absolute root;
//!   2. index build: `build_index(root)` gitignore-aware walk over the real repo;
//!   3. tagging union: a spoken transcript whose filename is NOT in the on-screen
//!      context terms but IS in the workspace index gets tagged, and an
//!      unambiguous basename is upgraded to a root-relative path.
//!
//! Prints one JSON object to stdout (the E2E artifact). Pure observation: no
//! writes to the workspace, no process control. Run:
//!   cargo run --example workspace_tagging_e2e -- "<window title>"

use winstt_app_lib::winstt::context::workspace_index::{
    basenames_for_pinned, build_index, index_for_pinned, resolve_root,
};
use winstt_app_lib::winstt::context::{
    apply_ide_file_tags, extract_taggable_filenames, upgrade_tags_to_paths,
};

/// Reproduce `apply_caret_join`'s KNOWN-set union (workspace basenames the user
/// actually spoke ∪ on-screen context terms), then run the tag + path-upgrade
/// passes exactly as production does — minus the final `join_for_insertion`
/// casing pass, which is orthogonal to tagging.
fn tag_with_workspace(
    text: &str,
    context_terms: &[String],
    idx: &winstt_app_lib::winstt::context::workspace_index::WorkspaceIndex,
) -> String {
    let mut known = context_terms.to_vec();
    let existing: std::collections::HashSet<String> =
        known.iter().map(|t| t.to_lowercase()).collect();
    for spoken in extract_taggable_filenames(text) {
        if existing.contains(&spoken.to_lowercase()) {
            continue;
        }
        if idx.canonical_basename(&spoken).is_some() {
            known.push(spoken);
        }
    }
    let tagged = apply_ide_file_tags(text, true, &known);
    upgrade_tags_to_paths(&tagged, true, |b| idx.unique_relpath(b).map(str::to_string))
}

/// Uncapped mirror of `default_walk_paths`'s `ignore`-crate config (gitignore +
/// hard-denylist), returning `(total_files, elapsed_ms, cm_paths, cj_paths,
/// pkg_paths)` where the *_paths are the root-relative paths carrying the three
/// probe basenames — so multiplicity (unique vs collision) is visible.
fn uncapped_walk(root: &std::path::Path) -> (usize, u128, Vec<String>, Vec<String>, Vec<String>) {
    use ignore::WalkBuilder;
    const HARD_SKIP_DIRS: &[&str] = &[
        ".git",
        "node_modules",
        "target",
        "dist",
        "build",
        ".venv",
        "venv",
        "__pycache__",
        ".next",
        ".turbo",
        ".gradle",
        ".idea",
        ".vscode",
    ];
    let started = std::time::Instant::now();
    let mut total = 0usize;
    let (mut cm, mut cj, mut pkg) = (Vec::new(), Vec::new(), Vec::new());
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .parents(true)
        .follow_links(false)
        .filter_entry(|entry| {
            if entry.file_type().is_some_and(|t| t.is_dir())
                && let Some(name) = entry.file_name().to_str()
                && HARD_SKIP_DIRS.iter().any(|d| d.eq_ignore_ascii_case(name))
            {
                return false;
            }
            true
        })
        .build();
    for dent in walker.flatten() {
        if dent.file_type().is_some_and(|t| t.is_file()) {
            total += 1;
            let path = dent.into_path();
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            match path.file_name().and_then(|n| n.to_str()) {
                Some("context_manager.rs") => cm.push(rel),
                Some("caret_join.rs") => cj.push(rel),
                Some("package.json") => pkg.push(rel),
                _ => {}
            }
        }
    }
    (total, started.elapsed().as_millis(), cm, cj, pkg)
}

fn main() {
    // Real Cursor window title for a WinSTT editor window (default template
    // `${activeEditorShort} - ${rootName} - ${appName}`). Overridable via argv[1].
    let title = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "context_manager.rs - WinSTT - Cursor".to_string());
    let app_exe = "cursor.exe";

    // ── 1. ROOT DISCOVERY on the machine's real workspaceStorage pool ──
    let resolved = resolve_root(&title, Some(app_exe));
    let resolved_str = resolved
        .as_ref()
        .map(|p| p.display().to_string())
        .unwrap_or_default();

    // ── 2. INDEX over the resolved root (fall back to argv root only if unset) ──
    let root = resolved
        .clone()
        .unwrap_or_else(|| std::path::PathBuf::from(r"E:\DL\Projects\WinSTT"));
    let idx = build_index(&root);

    // Sanity probes over the real index.
    let has_context_manager = idx.unique_relpath("context_manager.rs");
    let has_caret_join = idx.unique_relpath("caret_join.rs");
    let has_package_json = idx.canonical_basename("package.json");
    let has_node_modules_marker = idx.canonical_basename(".package-lock.json"); // npm cache marker inside node_modules
    let excludes_git = idx.basenames().iter().any(|b| b == "ORIG_HEAD"); // .git-only file
    let indexed_len = idx.len();
    let truncated = idx.is_truncated();

    // basenames_for_pinned goes through the SAME resolve+cache path production uses.
    let pinned_basenames = basenames_for_pinned(&title, Some(app_exe));
    let pinned_index = index_for_pinned(&title, Some(app_exe));

    // ── 3. TAGGING UNION on a transcript whose file is NOT on screen ──
    // On-screen context terms are EMPTY: the filename is only known via the index.
    let empty_terms: Vec<String> = Vec::new();
    let t1 = "please update context_manager.rs to add a retry";
    let out_tagged = tag_with_workspace(t1, &empty_terms, &idx);

    // A made-up filename that is NOT in the workspace must NOT be tagged.
    let t2 = "please open nonexistent_zzz.rs";
    let out_untagged = tag_with_workspace(t2, &empty_terms, &idx);

    // caret_join.rs (real file) spoken naturally, no on-screen terms.
    let t3 = "the bug is in caret_join.rs somewhere";
    let out_caret = tag_with_workspace(t3, &empty_terms, &idx);

    // Probe: is a file that the (partial) index DID reach taggable via the union?
    // package.json is reached early (root/docs/tools) — it should be in the
    // partial index even when truncated, proving the union LOGIC works and only
    // the truncation ORDER (not a code bug) starves the deep src-tauri files.
    let pkg_in_partial = idx.canonical_basename("package.json").is_some();
    let t4 = "please regenerate package.json for the build";
    let out_pkg = tag_with_workspace(t4, &empty_terms, &idx);
    // Also tag context_manager.rs against a MANUALLY-complete index (union logic
    // proof): if we hand `apply_ide_file_tags` the known filename directly, it
    // tags — isolating truncation as the sole reason the real partial index does
    // not. (This is the same call the union makes once canonical_basename hits.)
    let out_manual_known = apply_ide_file_tags(t1, true, &["context_manager.rs".to_string()]);

    // GRACEFUL FALLBACK: no workspace root (unparseable title) → terms-only.
    // With empty terms and no index, nothing tags (byte-for-byte prior behavior).
    let no_root = resolve_root("Untitled - Notepad", Some("notepad.exe"));
    let fallback_terms_only = apply_ide_file_tags(t1, true, &empty_terms);

    // ── DIAGNOSTIC: uncapped gitignore-aware walk (same builder config as the
    // production `default_walk_paths`) to isolate the 150ms MAX_WALK cap as the
    // cause of truncation and to report the true multiplicity of the target
    // basenames on this repo. Read-only.
    let (uncapped_total, uncapped_ms, cm_paths, cj_paths, pkg_paths) = uncapped_walk(&root);

    let artifact = serde_json::json!({
        "title": title,
        "app_exe": app_exe,
        "diagnostic_uncapped_walk": {
            "total_files": uncapped_total,
            "elapsed_ms": uncapped_ms,
            "max_walk_ms_cap": 150,
            "context_manager_rs_paths": cm_paths,
            "caret_join_rs_paths": cj_paths,
            "package_json_paths": pkg_paths,
        },
        "root_discovery": {
            "resolved_root": resolved_str,
            "resolved_matches_winstt": resolved.as_ref().is_some_and(|p| {
                p.to_string_lossy()
                    .to_lowercase()
                    .replace('\\', "/")
                    .ends_with("dl/projects/winstt")
            }),
        },
        "index": {
            "len": indexed_len,
            "truncated": truncated,
            "context_manager_rs_path": has_context_manager,
            "caret_join_rs_path": has_caret_join,
            "package_json_basename": has_package_json,
            "node_modules_leak_marker": has_node_modules_marker,
            "git_dir_leak_ORIG_HEAD": excludes_git,
            "pinned_basenames_count": pinned_basenames.len(),
            "index_for_pinned_some": pinned_index.is_some(),
        },
        "tagging": {
            "input_not_on_screen": t1,
            "output_tagged": out_tagged,
            "input_nonexistent": t2,
            "output_nonexistent_untouched": out_untagged,
            "input_caret_join": t3,
            "output_caret_join": out_caret,
            "package_json_in_partial_index": pkg_in_partial,
            "input_package_json": t4,
            "output_package_json": out_pkg,
            "output_manual_known_set": out_manual_known,
        },
        "fallback": {
            "no_root_resolves_none": no_root.is_none(),
            "terms_only_no_tag": fallback_terms_only,
        }
    });
    println!("{}", serde_json::to_string_pretty(&artifact).unwrap());
}
