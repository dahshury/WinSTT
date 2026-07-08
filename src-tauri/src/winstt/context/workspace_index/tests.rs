use std::path::{Path, PathBuf};

use super::*;

// ───────────────────────────── title parsing ─────────────────────────────

#[test]
fn parses_rootname_from_default_editor_title() {
    // `${activeEditorShort} - ${rootName} - ${appName}` for each editor flavor.
    assert_eq!(
        parse_root_name("context_manager.rs - WinSTT - Cursor").as_deref(),
        Some("WinSTT")
    );
    assert_eq!(
        parse_root_name("main.ts - my-app - Visual Studio Code").as_deref(),
        // "Visual Studio Code" is not one of our recognized short app names.
        None
    );
    assert_eq!(
        parse_root_name("main.ts - my-app - Code").as_deref(),
        Some("my-app")
    );
    assert_eq!(
        parse_root_name("app.tsx - dashboard - Code - Insiders").as_deref(),
        Some("dashboard")
    );
    assert_eq!(
        parse_root_name("readme.md - proj - Windsurf").as_deref(),
        Some("proj")
    );
    assert_eq!(
        parse_root_name("lib.rs - proj - VSCodium").as_deref(),
        Some("proj")
    );
}

#[test]
fn parses_bare_folder_window_two_segments() {
    // A folder window with no active editor collapses to `<rootName> - <App>`.
    assert_eq!(
        parse_root_name("claude - Cursor").as_deref(),
        Some("claude")
    );
}

#[test]
fn strips_dirty_indicator_prefix() {
    assert_eq!(
        parse_root_name("\u{25cf} file.rs - WinSTT - Cursor").as_deref(),
        Some("WinSTT")
    );
}

#[test]
fn rejects_non_editor_and_malformed_titles() {
    // No recognized trailing app segment.
    assert_eq!(parse_root_name("Untitled - Notepad"), None);
    // Only one segment.
    assert_eq!(parse_root_name("Cursor"), None);
    // Empty.
    assert_eq!(parse_root_name(""), None);
    // Multi-root `.code-workspace` label is NOT a folder basename.
    assert_eq!(
        parse_root_name("file.ts - MyStuff (Workspace) - Cursor"),
        None
    );
    // A rootName containing a path separator means a mis-split → reject.
    assert_eq!(parse_root_name("file.ts - a/b - Cursor"), None);
}

// ─────────────────────────── folder URI decode ───────────────────────────

#[test]
fn decodes_windows_file_uri_with_percent_encoding() {
    let p = decode_folder_uri("file:///e%3A/DL/Projects/WinSTT").unwrap();
    assert_eq!(p, PathBuf::from(r"e:\DL\Projects\WinSTT"));
}

#[test]
fn decodes_uri_with_spaces() {
    let p = decode_folder_uri("file:///c%3A/Users/me/My%20Project").unwrap();
    assert_eq!(p, PathBuf::from(r"c:\Users\me\My Project"));
}

#[test]
fn rejects_non_file_uri() {
    assert_eq!(decode_folder_uri("vscode-remote://ssh-remote/home/x"), None);
    assert_eq!(decode_folder_uri("file://"), None);
}

// ──────────────────────── pool match / disambiguation ─────────────────────

fn pool_from(pairs: &[(&str, u64)]) -> HashMap<String, Vec<PoolEntry>> {
    // Each pair is (absolute_path, mtime_secs_since_epoch).
    let mut pool: HashMap<String, Vec<PoolEntry>> = HashMap::new();
    for (path, secs) in pairs {
        let root = PathBuf::from(path);
        let basename = root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap()
            .to_lowercase();
        let mtime = std::time::UNIX_EPOCH + Duration::from_secs(*secs);
        pool.entry(basename)
            .or_default()
            .push(PoolEntry { root, mtime });
    }
    pool
}

#[test]
fn unique_basename_resolves_to_its_path() {
    let pool = pool_from(&[(r"e:\DL\Projects\WinSTT", 100)]);
    assert_eq!(
        match_root_in_pool(&pool, "WinSTT"),
        Some(PathBuf::from(r"e:\DL\Projects\WinSTT"))
    );
    // Case-insensitive on the name.
    assert_eq!(
        match_root_in_pool(&pool, "winstt"),
        Some(PathBuf::from(r"e:\DL\Projects\WinSTT"))
    );
}

#[test]
fn same_path_opened_many_times_dedups_to_one() {
    // The SAME folder in the pool twice (reopened) is one candidate, not a
    // collision — it must resolve, not degrade.
    let pool = pool_from(&[
        (r"e:\DL\Projects\WinSTT", 100),
        (r"e:\DL\Projects\WinSTT", 200),
    ]);
    assert_eq!(
        match_root_in_pool(&pool, "WinSTT"),
        Some(PathBuf::from(r"e:\DL\Projects\WinSTT"))
    );
}

#[test]
fn cross_root_collision_picks_mru() {
    // Two DISTINCT roots share basename `python-whatsapp-bot`; MRU wins.
    let pool = pool_from(&[
        (r"e:\DL\Projects\python-whatsapp-bot", 100),
        (r"e:\DL\Projects\temp\python-whatsapp-bot", 500),
    ]);
    assert_eq!(
        match_root_in_pool(&pool, "python-whatsapp-bot"),
        Some(PathBuf::from(r"e:\DL\Projects\temp\python-whatsapp-bot"))
    );
}

#[test]
fn absent_basename_yields_none() {
    let pool = pool_from(&[(r"e:\DL\Projects\WinSTT", 100)]);
    assert_eq!(match_root_in_pool(&pool, "does-not-exist"), None);
}

// ─────────────────────────── index build + caps ──────────────────────────

/// Drive the pure index builder with a synthetic file list — no filesystem — so
/// cap/collision behavior is deterministic and platform-independent.
fn index_from_files(root: &Path, files: &[&str]) -> WorkspaceIndex {
    let owned: Vec<PathBuf> = files.iter().map(|f| root.join(f)).collect();
    build_index_with_walker(root, |_, on_file| {
        for p in &owned {
            if !on_file(p.clone()) {
                return;
            }
        }
    })
}

#[test]
fn index_maps_basename_to_relpath() {
    let root = Path::new(r"e:\proj");
    let idx = index_from_files(
        root,
        &[
            "src/winstt/context/caret_join.rs",
            "src/main.rs",
            "README.md",
        ],
    );
    assert_eq!(idx.len(), 3);
    assert!(!idx.is_truncated());
    // Unique basename → root-relative path with forward slashes.
    assert_eq!(
        idx.unique_relpath("caret_join.rs"),
        Some("src/winstt/context/caret_join.rs")
    );
    // Case-insensitive lookup.
    assert_eq!(idx.unique_relpath("README.MD"), Some("README.md"));
}

#[test]
fn collision_yields_no_unique_path_but_keeps_basename() {
    let root = Path::new(r"e:\proj");
    let idx = index_from_files(root, &["src/a/index.ts", "src/b/index.ts"]);
    // Two files share the basename → NO unique path (never guess).
    assert_eq!(idx.unique_relpath("index.ts"), None);
    // But the basename is still present for bare-name tagging.
    assert!(idx.basenames().iter().any(|b| b == "index.ts"));
}

#[test]
fn walk_stops_at_file_cap_and_marks_truncated() {
    let root = Path::new(r"e:\huge");
    // MAX_INDEXED_FILES + a few extra distinct files.
    let names: Vec<String> = (0..MAX_INDEXED_FILES + 10)
        .map(|i| format!("f{i}.rs"))
        .collect();
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let idx = index_from_files(root, &refs);
    assert!(
        idx.is_truncated(),
        "hitting the file cap must set truncated"
    );
    assert!(idx.len() <= MAX_INDEXED_FILES);
    // Truncated → even a would-be-unique basename must NOT emit a path.
    assert_eq!(idx.unique_relpath("f0.rs"), None);
}

#[test]
fn empty_walk_is_empty_not_truncated() {
    let idx = index_from_files(Path::new(r"e:\empty"), &[]);
    assert!(idx.is_empty());
    assert!(!idx.is_truncated());
    assert!(idx.basenames().is_empty());
}

// ──────────────────── real filesystem walk (gitignore) ────────────────────
//
// Only the real `ignore`-crate walker is Windows-gated; on other targets
// `default_walk_paths` is a stub, so run these on Windows only.

#[cfg(windows)]
#[test]
fn real_walk_honors_gitignore_and_hard_denylist() {
    use std::fs;

    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    // Tracked files.
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
    fs::write(root.join("README.md"), "# hi").unwrap();
    // A .gitignore that excludes `ignored/` and `*.log`.
    fs::write(root.join(".gitignore"), "ignored/\n*.log\n").unwrap();
    fs::create_dir_all(root.join("ignored")).unwrap();
    fs::write(root.join("ignored/secret.rs"), "// nope").unwrap();
    fs::write(root.join("app.log"), "noise").unwrap();
    // Hard-denylist dirs must be skipped even without a gitignore rule.
    fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
    fs::write(root.join("node_modules/pkg/index.js"), "//").unwrap();
    fs::create_dir_all(root.join("target/debug")).unwrap();
    fs::write(root.join("target/debug/build.rs"), "//").unwrap();

    let idx = build_index(root);

    // Tracked files present.
    assert_eq!(idx.unique_relpath("main.rs"), Some("src/main.rs"));
    assert!(idx.basenames().iter().any(|b| b == "README.md"));
    // gitignored file + pattern excluded.
    assert!(idx.unique_relpath("secret.rs").is_none());
    assert!(!idx.basenames().iter().any(|b| b == "secret.rs"));
    assert!(!idx.basenames().iter().any(|b| b == "app.log"));
    // Hard-denylisted trees excluded.
    assert!(!idx.basenames().iter().any(|b| b == "index.js"));
    assert!(!idx.basenames().iter().any(|b| b == "build.rs"));
}

// ──────────────────── git-native enumeration (git ls-files) ───────────────
//
// The production path enumerates a git checkout via `git ls-files` (native
// gitignore filtering, whole-repo, no walk-order starvation). These drive the
// REAL `git` subprocess against a temp repo, so they are gated on Windows (the
// feature target) AND skipped when `git` isn't on PATH (CI without git → the
// build silently falls back to the walk, which the walk test already covers).

#[cfg(windows)]
fn git_available() -> bool {
    std::process::Command::new("git")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(windows)]
fn git_init_repo(root: &Path) {
    for args in [
        &["init", "-q"][..],
        &["config", "user.email", "t@t.t"][..],
        &["config", "user.name", "t"][..],
    ] {
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        assert!(ok, "git {args:?} failed in temp repo");
    }
}

#[cfg(windows)]
#[test]
fn git_enumeration_indexes_deep_files_and_respects_gitignore() {
    use std::fs;

    if !git_available() {
        eprintln!("skipping git_enumeration test: git not on PATH");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    git_init_repo(root);

    // A DEEP source file — the exact shape the 150 ms walk cap used to starve on
    // a large repo. It must be indexed with its full root-relative path.
    let deep = root.join("src-tauri/src/winstt/managers");
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join("context_manager.rs"), "// deep").unwrap();
    // A shallow file (root) — always cheap to reach, present too.
    fs::write(root.join("package.json"), "{}").unwrap();
    // A gitignored file + a hard-denylisted tree that git also won't list.
    fs::write(root.join(".gitignore"), "ignored.rs\ntarget/\n").unwrap();
    fs::write(root.join("ignored.rs"), "// nope").unwrap();
    fs::create_dir_all(root.join("target/debug")).unwrap();
    fs::write(root.join("target/debug/build.rs"), "// built").unwrap();

    // `--others` lists untracked-not-ignored, so no commit is needed for the
    // tracked/untracked-visible files to appear; verify without staging.
    let idx = build_index(root);

    // DEEP file is indexed at its full path (the core defect: this used to be
    // missing because the walk hit the time cap before reaching it).
    assert_eq!(
        idx.unique_relpath("context_manager.rs"),
        Some("src-tauri/src/winstt/managers/context_manager.rs"),
        "deep source file must be indexed by git enumeration"
    );
    // Shallow file present.
    assert!(idx.basenames().iter().any(|b| b == "package.json"));
    // A completed git enumeration is COMPLETE, never truncated.
    assert!(
        !idx.is_truncated(),
        "a normal git enumeration must not set truncated"
    );
    // gitignored + hard-denylisted files are NOT indexed.
    assert!(
        idx.canonical_basename("ignored.rs").is_none(),
        "a .gitignored file must not be indexed"
    );
    assert!(
        idx.canonical_basename("build.rs").is_none(),
        "a target/ file (gitignored) must not be indexed"
    );
}

#[cfg(windows)]
#[test]
fn git_enumeration_used_over_walk_for_git_roots() {
    use std::fs;

    if !git_available() {
        eprintln!("skipping git-vs-walk test: git not on PATH");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    // A `.git` presence flips `build_index` onto the git path.
    assert!(!root_has_git(root));
    git_init_repo(root);
    assert!(root_has_git(root), ".git dir must be detected");

    fs::write(root.join("only_via_git.rs"), "// x").unwrap();
    let idx = build_index(root);
    assert_eq!(
        idx.unique_relpath("only_via_git.rs"),
        Some("only_via_git.rs")
    );
    assert!(!idx.is_truncated());
}

#[cfg(windows)]
#[test]
fn non_git_folder_falls_back_to_walk() {
    use std::fs;

    // No `.git` → `root_has_git` is false → the walk enumerates (this is the
    // existing gitignore-aware fallback; assert the path still indexes files).
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    assert!(!root_has_git(root));
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();

    let idx = build_index(root);
    assert_eq!(idx.unique_relpath("main.rs"), Some("src/main.rs"));
    assert!(!idx.is_truncated());
}

// ─────────────────────────── graceful fallback ───────────────────────────

#[test]
fn resolve_root_fails_soft_on_unparseable_title() {
    // No recognized editor app segment → None (terms-only).
    assert_eq!(resolve_root("Some Doc - Word", Some("winword.exe")), None);
    // Non-editor exe even with a plausible title → None.
    assert_eq!(
        resolve_root("main.rs - Proj - Cursor", Some("notepad.exe")),
        None
    );
}

#[test]
fn basenames_for_pinned_is_empty_when_unresolved() {
    // Unparseable title → the union contributes nothing, so the tagger sees only
    // context_terms (today's behavior).
    assert!(basenames_for_pinned("Untitled - Notepad", Some("notepad.exe")).is_empty());
}

#[test]
fn appdata_folder_mapping_is_editor_only() {
    assert_eq!(appdata_folder_for_exe("cursor.exe"), Some("Cursor"));
    assert_eq!(appdata_folder_for_exe("code.exe"), Some("Code"));
    assert_eq!(
        appdata_folder_for_exe("code - insiders.exe"),
        Some("Code - Insiders")
    );
    assert_eq!(appdata_folder_for_exe("chrome.exe"), None);
    assert_eq!(appdata_folder_for_exe(""), None);
}

// ─────────────── union input: spoken-basename → workspace file ─────────────

#[test]
fn canonical_basename_returns_on_disk_spelling() {
    let root = Path::new(r"e:\proj");
    // On-disk casing is `Config.toml`; a spoken lowercase `config.toml` resolves
    // to the CANONICAL spelling so the tagger emits the on-disk name.
    let idx = index_from_files(root, &["Config.toml", "src/main.rs"]);
    assert_eq!(
        idx.canonical_basename("config.toml").as_deref(),
        Some("Config.toml")
    );
    assert_eq!(
        idx.canonical_basename("main.rs").as_deref(),
        Some("main.rs")
    );
    // A word that is not a workspace file → None (never enters the known set).
    assert_eq!(idx.canonical_basename("nonexistent.rs"), None);
}

#[test]
fn truncated_index_still_offers_basename_but_not_path() {
    // The union path uses canonical_basename (works even when truncated) so a
    // spoken file still TAGS; only the path UPGRADE is withheld when truncated.
    let root = Path::new(r"e:\huge");
    let names: Vec<String> = (0..MAX_INDEXED_FILES + 5)
        .map(|i| format!("f{i}.rs"))
        .collect();
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let idx = index_from_files(root, &refs);
    assert!(idx.is_truncated());
    // Bare-name tagging still available.
    assert_eq!(idx.canonical_basename("f0.rs").as_deref(), Some("f0.rs"));
    // Path upgrade withheld.
    assert_eq!(idx.unique_relpath("f0.rs"), None);
}
