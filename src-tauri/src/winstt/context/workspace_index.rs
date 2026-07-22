//! Workspace-wide IDE `@file` tagging (Wispr-parity: "the right file in your
//! workspace"). Widens the set of KNOWN filenames the deterministic caret-join
//! tagger ([`super::apply_ide_file_tags`]) can promote to `@file` from "only
//! filenames VISIBLE in the captured context" to "any real file in the user's
//! workspace" — so a spoken `context_manager.rs` tags even when it is not on
//! screen, and can be UPGRADED to a `@src/…/context_manager.rs` path when that
//! basename is unique on disk.
//!
//! ## Pipeline (all read-only, all fail-soft to today's behavior)
//!  1. RESOLVE THE ROOT for the pinned IDE window ([`resolve_root`]):
//!     - Parse the per-HWND window title. VS Code / Cursor / Windsurf / VSCodium
//!       all share the default template `${activeEditorShort} - ${rootName} -
//!       ${appName}` (adjacent-duplicate segments collapse), so the token
//!       immediately before the trailing app segment is the workspace-folder
//!       BASENAME. This is the ONLY genuinely per-window signal.
//!     - Decode the editor's `workspaceStorage` pool
//!       (`%APPDATA%\<Editor>\User\workspaceStorage\<hash>\workspace.json`, each
//!       `{"folder":"file:///e%3A/…"}`) into `basename -> [(abs_path, mtime)]`.
//!     - Match the title's rootName against the pool (case-insensitive basename);
//!       dedup by absolute path; on a multi-path collision pick most-recent mtime
//!       (MRU). Any ambiguity we cannot break → unresolved (never a wrong root).
//!  2. BUILD A BOUNDED INDEX for the resolved root ([`index_for_root`]): for a
//!     git checkout, enumerate the tracked + untracked-not-ignored files via
//!     `git ls-files --cached --others --exclude-standard -z` (native gitignore
//!     filtering, whole-repo in ~0.4 s, no walk-order starvation); for a non-git
//!     folder, fall back to a gitignore-aware [`ignore`]-crate walk. Basenames-
//!     only, one hard 50k-file cap, cached per-root (60 s TTL, LRU).
//!  3. LOOK UP a spoken basename ([`WorkspaceIndex::canonical_basename`] for the
//!     tagging union, [`WorkspaceIndex::unique_relpath`] for the path upgrade):
//!     exact case-insensitive basename match; a UNIQUE match yields a root-
//!     relative path, a collision or a truncated index yields only the bare
//!     basename (never a guessed path).
//!
//! EVERYTHING is `Option`/`Result`-returning and Windows-gated: a `None` root,
//! an empty/oversized index, an unreadable pool, a non-default title, or a
//! non-Windows target all collapse to the caller's context-terms-only tagging —
//! precision is strictly `>=` today because the KNOWN set only grows with real,
//! extension-bearing, on-disk-present filenames. The build runs off the dictation
//! hot path (a cache read at capture time is O(1)); enumeration is a whole-repo
//! `git ls-files` (git repos) or a generous-budget gitignore walk (non-git), so a
//! completed build is COMPLETE — `truncated` is set only on the genuine 50k hard
//! cap or a real enumeration error, never by a normal-completion wall clock.

#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

// ───────────────────────────── caps / knobs ─────────────────────────────

/// Hard cap on indexed files. An enumeration that exceeds this stops early and
/// the index is flagged `truncated`, forcing conservative bare-name tagging.
/// `git ls-files` output is already gitignore-filtered so a normal repo never
/// approaches this; it is a pure safety valve (and the sole `truncated` cause).
const MAX_INDEXED_FILES: usize = 50_000;

/// Generous wall-clock budget for the NON-GIT `ignore`-crate fallback walk. This
/// build runs OFF the dictation hot path (async on pin), so completeness matters
/// more than latency — a full enumeration must finish, unlike the old 150 ms cap
/// that starved deep source trees. Reaching this only aborts a pathological walk;
/// it is NOT a normal-completion signal and (like the git path) is the only wall
/// clock in the pipeline. The git enumeration has its own [`GIT_LS_FILES_TIMEOUT`].
const MAX_WALK: Duration = Duration::from_secs(2);

/// Timeout for the `git ls-files` subprocess. `git` enumerates this whole repo in
/// ~0.4 s; a hang past this (e.g. a wedged git, a network-mounted worktree) aborts
/// the child and falls back to the `ignore`-crate walk rather than blocking.
const GIT_LS_FILES_TIMEOUT: Duration = Duration::from_secs(5);

/// Per-root cache TTL. A dictation burst reuses one build; a brand-new file at
/// worst misses a path-upgrade (conservative), never mis-tags.
const CACHE_TTL: Duration = Duration::from_secs(60);

/// LRU bound on the per-root cache so project-switching cannot accumulate roots.
const MAX_CACHED_ROOTS: usize = 4;

/// Belt-and-suspenders directory denylist, skipped regardless of gitignore state
/// (thin `.gitignore` repos still must not walk build/cache trees).
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

// ───────────────────────────── title parsing ─────────────────────────────

/// Recognized editor `${appName}` values as they appear at the END of the
/// default window title. Note some app names themselves contain the ` - `
/// separator (`Code - Insiders`), so we match against the trailing SUBSTRING of
/// the whole title, not a single ` - `-split segment. Longest first so
/// `Code - Insiders` is tried before `Code`.
const TITLE_APP_SUFFIXES: &[&str] = &["Code - Insiders", "Cursor", "Windsurf", "VSCodium", "Code"];

/// Extract the `${rootName}` (workspace-folder basename) from a VS Code-family
/// window title of the form `<editor> - <rootName> - <AppName>` (segments joined
/// by ` - `; adjacent duplicates collapse so a bare-folder window is just
/// `<rootName> - <AppName>`).
///
/// Returns `None` when the title has no recognized trailing app name, no
/// `rootName` segment before it, or the rootName looks like a multi-root
/// workspace label (`Foo (Workspace)`) which is NOT a folder basename. Defensive
/// by construction: any shape we don't confidently understand → `None` → the
/// caller degrades to context-terms-only tagging.
pub fn parse_root_name(title: &str) -> Option<String> {
    let title = title.trim();
    if title.is_empty() {
        return None;
    }
    // Some editors prefix an unsaved-changes bullet ("● " / "* "); strip it.
    let title = title
        .trim_start_matches(['\u{25cf}', '\u{2022}', '*', ' '])
        .trim();

    // Strip the trailing ` - <AppName>` where the app name may itself contain
    // ` - ` (e.g. `Code - Insiders`). Match longest-first against the tail.
    let head = TITLE_APP_SUFFIXES.iter().find_map(|app| {
        let suffix = format!(" - {app}");
        let lower = title.to_lowercase();
        lower
            .strip_suffix(&suffix.to_lowercase())
            .map(|_| &title[..title.len() - suffix.len()])
    })?;

    // rootName is the last remaining ` - `-joined segment of the head.
    let root = head.rsplit(" - ").next()?.trim();
    if root.is_empty() {
        return None;
    }
    // A multi-root `.code-workspace` shows "<name> (Workspace)" — not a folder
    // basename; refuse it so we never resolve to the wrong absolute path.
    if root.to_lowercase().ends_with("(workspace)") {
        return None;
    }
    // A rootName must not itself contain a path separator (would mean we mis-split).
    if root.contains(['\\', '/']) {
        return None;
    }
    Some(root.to_string())
}

// ─────────────────────── workspaceStorage pool ───────────────────────────

/// Map an IDE exe basename (lowercased, e.g. `cursor.exe`) to its `%APPDATA%`
/// config folder name. Only Electron VS Code-family editors share the
/// `workspaceStorage` + `workspace.json` layout this reads; everything else →
/// `None` → terms-only.
fn appdata_folder_for_exe(app_exe: &str) -> Option<&'static str> {
    match app_exe.to_lowercase().as_str() {
        "cursor.exe" => Some("Cursor"),
        "windsurf.exe" => Some("Windsurf"),
        "code.exe" => Some("Code"),
        "code - insiders.exe" => Some("Code - Insiders"),
        "vscodium.exe" => Some("VSCodium"),
        _ => None,
    }
}

/// One decoded `workspaceStorage` entry: the absolute folder root plus the
/// `workspace.json` last-write time used for MRU tiebreaks.
#[derive(Debug, Clone)]
struct PoolEntry {
    root: PathBuf,
    mtime: std::time::SystemTime,
}

/// Decode a `file:///…` folder URI from a `workspace.json` into an absolute
/// path. Strips the `file:///` prefix and percent-decodes (`%3A` → `:`), so
/// `file:///e%3A/DL/Projects/WinSTT` → `e:/DL/Projects/WinSTT`. Returns `None`
/// for non-`file:` URIs (remote / virtual workspaces we can't walk).
pub fn decode_folder_uri(uri: &str) -> Option<PathBuf> {
    let rest = uri
        .strip_prefix("file:///")
        .or_else(|| uri.strip_prefix("file://"))?;
    let decoded = percent_encoding::percent_decode_str(rest)
        .decode_utf8()
        .ok()?;
    if decoded.is_empty() {
        return None;
    }
    Some(PathBuf::from(decoded.replace('/', "\\")))
}

/// Read the editor's `workspaceStorage` pool into `lowercased-basename ->
/// [PoolEntry]`. Cheap: parses ~15 tiny `workspace.json` files, never the
/// multi-GB `state.vscdb`. Any I/O error / missing dir → empty map (terms-only).
fn load_workspace_pool(appdata_folder: &str) -> HashMap<String, Vec<PoolEntry>> {
    let mut pool: HashMap<String, Vec<PoolEntry>> = HashMap::new();
    let Some(base) = std::env::var_os("APPDATA") else {
        return pool;
    };
    let storage = PathBuf::from(base)
        .join(appdata_folder)
        .join("User")
        .join("workspaceStorage");
    let Ok(entries) = std::fs::read_dir(&storage) else {
        return pool;
    };
    for entry in entries.flatten() {
        let ws_json = entry.path().join("workspace.json");
        let Ok(text) = std::fs::read_to_string(&ws_json) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let Some(folder) = value.get("folder").and_then(|v| v.as_str()) else {
            continue; // multi-root `workspace` key or empty-window storage: skip
        };
        let Some(root) = decode_folder_uri(folder) else {
            continue;
        };
        let Some(basename) = root
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_lowercase)
        else {
            continue;
        };
        let mtime = std::fs::metadata(&ws_json)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        pool.entry(basename)
            .or_default()
            .push(PoolEntry { root, mtime });
    }
    pool
}

/// Match a title `root_name` against the decoded pool, returning the single best
/// absolute root — or `None` when the name is absent OR resolves to more than
/// one DISTINCT path with no MRU winner. Dedup by absolute path (the same folder
/// opened many times is one candidate); on a genuine cross-root basename
/// COLLISION, pick the most-recently-written `workspace.json` (MRU). We never
/// invent a path when the collision can't be broken.
fn match_root_in_pool(pool: &HashMap<String, Vec<PoolEntry>>, root_name: &str) -> Option<PathBuf> {
    let candidates = pool.get(&root_name.to_lowercase())?;
    // Dedup by canonical (lowercased) path string; keep the newest mtime per path.
    let mut by_path: HashMap<String, PoolEntry> = HashMap::new();
    for c in candidates {
        let key = c.root.to_string_lossy().to_lowercase();
        by_path
            .entry(key)
            .and_modify(|e| {
                if c.mtime > e.mtime {
                    *e = c.clone();
                }
            })
            .or_insert_with(|| c.clone());
    }
    if by_path.is_empty() {
        return None;
    }
    if by_path.len() == 1 {
        return by_path.into_values().next().map(|e| e.root);
    }
    // Multiple DISTINCT roots share the basename → MRU tiebreak (most recent
    // workspace.json write wins). Deterministic; the design allows this.
    by_path
        .into_values()
        .max_by_key(|e| e.mtime)
        .map(|e| e.root)
}

/// Resolve the absolute workspace root for a pinned IDE window from its window
/// title + app exe. Returns `None` (→ terms-only) whenever the title has no
/// parseable rootName, the app isn't a known Electron editor, the pool is
/// unreadable, the rootName isn't in the pool, or the match is ambiguous.
///
/// The final root is verified to be an existing directory, so a stale pool entry
/// for a deleted folder can never be indexed.
pub fn resolve_root(window_title: &str, app_exe: Option<&str>) -> Option<PathBuf> {
    let root_name = parse_root_name(window_title)?;
    let appdata_folder = appdata_folder_for_exe(app_exe.unwrap_or_default())?;
    let pool = load_workspace_pool(appdata_folder);
    let root = match_root_in_pool(&pool, &root_name)?;
    if root.is_dir() { Some(root) } else { None }
}

// ─────────────────────────── bounded file index ──────────────────────────

/// A basenames-only workspace file index. `by_basename` is a multimap from a
/// lowercased basename to the on-disk relative paths that carry it (forward
/// slashes, root-relative); collisions keep every path so the lookup can tell
/// "unique" from "ambiguous". `truncated` means the 50k hard cap (or a
/// pathological fallback-walk abort) was hit — treat every hit as possibly-
/// ambiguous (bare name only). A normally-completed git/walk enumeration is
/// NOT truncated, so path upgrades are enabled for a complete workspace.
#[derive(Debug, Clone, Default)]
pub struct WorkspaceIndex {
    by_basename: HashMap<String, Vec<String>>,
    truncated: bool,
}

impl WorkspaceIndex {
    /// The set of on-disk basenames (canonical, on-disk spelling) — the union
    /// input for the tagger's KNOWN set. Deduped by basename (first-seen casing).
    pub fn basenames(&self) -> Vec<String> {
        let mut out = Vec::with_capacity(self.by_basename.len());
        for paths in self.by_basename.values() {
            if let Some(first) = paths.first() {
                let base = first.rsplit('/').next().unwrap_or(first);
                out.push(base.to_string());
            }
        }
        out
    }

    /// Every indexed ROOT-RELATIVE path (forward slashes, on-disk casing), in no
    /// particular order. Additive accessor over `by_basename` used by the sibling
    /// `file_reference_resolver` to build its basename-token inverted index once
    /// per root (off the hot path); it needs the full path list, not just the
    /// deduped basenames [`Self::basenames`] returns.
    pub fn relpaths(&self) -> impl Iterator<Item = &str> {
        self.by_basename
            .values()
            .flat_map(|paths| paths.iter().map(String::as_str))
    }

    /// Resolve a spoken basename to its ROOT-RELATIVE path when that basename is
    /// UNIQUE on disk; `None` on zero matches, a collision, or a truncated index
    /// (any of which means "don't emit a path — the bare `@name` is the ceiling").
    pub fn unique_relpath(&self, spoken_basename: &str) -> Option<&str> {
        if self.truncated {
            return None;
        }
        let paths = self.by_basename.get(&spoken_basename.to_lowercase())?;
        if paths.len() == 1 {
            Some(paths[0].as_str())
        } else {
            None
        }
    }

    /// The on-disk (canonical) basename for `spoken_basename` when the workspace
    /// contains at least one file with that basename (case-insensitive), else
    /// `None`. The returned spelling is the index's ground-truth casing, taken
    /// from the first indexed path with that basename. Used to widen the tagger's
    /// KNOWN set with real workspace files the user spoke, using the on-disk
    /// spelling rather than the spoken casing.
    pub fn canonical_basename(&self, spoken_basename: &str) -> Option<String> {
        let paths = self.by_basename.get(&spoken_basename.to_lowercase())?;
        let first = paths.first()?;
        Some(first.rsplit('/').next().unwrap_or(first).to_string())
    }

    pub fn is_truncated(&self) -> bool {
        self.truncated
    }

    pub fn len(&self) -> usize {
        self.by_basename.values().map(Vec::len).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.by_basename.is_empty()
    }
}

/// Build the workspace file index for `root`, collecting basenames + root-
/// relative paths. Pure over the filesystem; the caller caches the result.
///
/// Enumeration strategy (git-first):
///   1. If `root` is (inside) a git checkout — a `.git` dir OR a `.git` FILE
///      (worktrees/submodules use a gitdir-pointer file) is present — enumerate
///      via `git ls-files --cached --others --exclude-standard -z`. This lists
///      tracked + untracked-not-ignored files for the WHOLE repo in ~0.4 s with
///      native gitignore filtering and NO walk-order starvation, so deep source
///      files (`src-tauri/src/…/context_manager.rs`) are always present.
///   2. Otherwise (non-git folder, or git missing / errored / timed out) fall
///      back to the gitignore-aware [`ignore`]-crate walk.
///
/// `truncated` is set ONLY on the 50k hard cap; a clean completion (git or walk)
/// yields a COMPLETE index. A failed git run degrades to the walk, never to a
/// starved index.
pub fn build_index(root: &Path) -> WorkspaceIndex {
    if root_has_git(root)
        && let Some(index) = build_index_via_git(root)
    {
        return index;
    }
    build_index_with_walker(root, default_walk_paths)
}

/// True when `root` is (the top of) a git checkout: a `.git` directory (normal
/// clone) OR a `.git` FILE (worktree / submodule gitdir-pointer). We only need to
/// know it's a repo — `git ls-files` itself resolves the actual git dir.
fn root_has_git(root: &Path) -> bool {
    let dot_git = root.join(".git");
    dot_git.is_dir() || dot_git.is_file()
}

/// Enumerate `root`'s files via `git ls-files --cached --others --exclude-standard
/// -z` and fold them into a [`WorkspaceIndex`]. Returns `None` (→ caller falls back
/// to the walk) when git is missing, exits non-zero, times out, or produces
/// unusable output. The `-z` NUL separator makes parsing robust to paths with
/// spaces/newlines; git emits repo-relative FORWARD-slash paths, which are exactly
/// the index's relpath spelling — no separator translation needed.
fn build_index_via_git(root: &Path) -> Option<WorkspaceIndex> {
    let out = run_git_ls_files(root)?;
    let mut by_basename: HashMap<String, Vec<String>> = HashMap::new();
    let mut count = 0usize;
    let mut truncated = false;
    // `-z` gives NUL-separated records with no trailing bookkeeping; split on NUL
    // and drop empties (a trailing NUL yields one empty tail record).
    for rel in out.split(|&b| b == 0) {
        if rel.is_empty() {
            continue;
        }
        if count >= MAX_INDEXED_FILES {
            truncated = true;
            break;
        }
        // git paths are UTF-8 by default; skip any non-UTF-8 record rather than
        // lossily mangle a basename we'd then fail to match.
        let Ok(rel) = std::str::from_utf8(rel) else {
            continue;
        };
        // Repo-relative, forward-slash already. Basename is the last segment.
        let Some(basename) = rel.rsplit('/').next().filter(|s| !s.is_empty()) else {
            continue;
        };
        by_basename
            .entry(basename.to_lowercase())
            .or_default()
            .push(rel.to_string());
        count += 1;
    }
    // A repo with zero listed files (empty new repo) is a legitimate empty index,
    // but an empty result more often means the command produced nothing useful —
    // let the caller's walk fallback have a turn rather than caching empty.
    if by_basename.is_empty() {
        return None;
    }
    Some(WorkspaceIndex {
        by_basename,
        truncated,
    })
}

/// Run `git -C <root> ls-files --cached --others --exclude-standard -z`, returning
/// its raw stdout bytes, or `None` on spawn failure / non-zero exit / timeout.
/// Spawns the child and waits up to [`GIT_LS_FILES_TIMEOUT`]; a hung git is killed
/// and treated as a failure (→ walk fallback). On Windows, the wait is driven by
/// the child process handle becoming signalled rather than by periodic
/// process-status checks.
///
/// Stdout is drained on a DEDICATED thread so a large listing (this repo emits
/// ~0.5 MB, far past the OS pipe buffer) can never wedge the child on a full pipe
/// while the main thread waits for exit — the classic wait + un-drained pipe
/// deadlock. The reader thread owns the pipe and reads it to EOF; we join it after
/// the child exits (or after killing it on timeout, which closes the pipe and lets
/// the reader hit EOF).
#[cfg(windows)]
fn run_git_ls_files(root: &Path) -> Option<Vec<u8>> {
    use std::io::Read;
    use std::process::{Command, Stdio};

    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .ok()?;

    // Hand the stdout pipe to a reader thread so the child is never blocked on a
    // full pipe while we wait for its process handle below.
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });

    // Bounded kernel wait for exit; kill (closing the pipe → reader hits EOF) on
    // timeout. No timer loop wakes this thread while git is still running.
    let status = match wait_for_child_exit(&mut child, GIT_LS_FILES_TIMEOUT) {
        Ok(Some(status)) => status,
        Ok(None) | Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return None;
        }
    };

    let stdout = reader.join().ok()?;
    if status.success() { Some(stdout) } else { None }
}

/// Wait until `child` exits or `timeout` elapses. A Windows process handle is
/// signalled exactly once, when the process terminates, so this gives the caller
/// a reliable completion callback without timer polling. `None` means timeout;
/// the caller still owns the child and is responsible for terminating it.
#[cfg(windows)]
fn wait_for_child_exit(
    child: &mut std::process::Child,
    timeout: Duration,
) -> std::io::Result<Option<std::process::ExitStatus>> {
    use std::os::windows::io::AsRawHandle;

    use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::System::Threading::WaitForSingleObject;

    // `u32::MAX` is Win32's INFINITE sentinel, so keep a finite duration below
    // it even if a future caller supplies an unusually large timeout.
    let timeout_ms = timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32;
    let wait_result = unsafe { WaitForSingleObject(HANDLE(child.as_raw_handle()), timeout_ms) };
    match wait_result {
        WAIT_OBJECT_0 => child.wait().map(Some),
        WAIT_TIMEOUT => Ok(None),
        _ => Err(std::io::Error::last_os_error()),
    }
}

/// Workspace indexing is Windows-only. Keep the module's pure helpers available
/// to cross-platform tests without spawning a platform-specific git process.
#[cfg(not(windows))]
fn run_git_ls_files(_root: &Path) -> Option<Vec<u8>> {
    None
}

/// The production walk: `ignore`-crate, gitignore + global-gitignore aware, with
/// the hard directory denylist layered on top. Calls `on_file` per regular file
/// and stops early when it returns `false` (a cap was hit).
#[cfg(windows)]
fn default_walk_paths(root: &Path, on_file: &mut dyn FnMut(PathBuf) -> bool) {
    use ignore::WalkBuilder;
    let walker = WalkBuilder::new(root)
        .hidden(false) // .gitignore rules still apply; we want dotfiles like .env
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        // Honor `.gitignore` even when the root isn't a git checkout yet (a freshly
        // opened folder, a submodule, or a non-repo project still carries ignore
        // rules we want to respect).
        .require_git(false)
        .parents(true)
        .follow_links(false)
        .filter_entry(|entry| {
            // Hard-skip denylisted directories regardless of gitignore state.
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
        if dent.file_type().is_some_and(|t| t.is_file()) && !on_file(dent.into_path()) {
            return; // caller signalled a cap was hit
        }
    }
}

/// Non-Windows stub — the feature is Windows-only, but keeping the generic
/// `build_index_with_walker` compilable everywhere lets the pure index/cap logic
/// be unit-tested on any target via an injected walker.
#[cfg(not(windows))]
fn default_walk_paths(_root: &Path, _on_file: &mut dyn FnMut(PathBuf) -> bool) {}

/// Generic index build over an injectable file-walker (`walk` calls `on_file`
/// for each file path and stops early when `on_file` returns `false`). This is
/// the NON-GIT fallback path (and the injectable test seam). Applies the 50k
/// hard cap and a generous [`MAX_WALK`] pathological-abort budget, recording
/// `truncated` only when one of those actually fires — a normal walk completes
/// well within both and yields a COMPLETE (`truncated == false`) index. Split
/// out so tests can drive it over a temp dir with the real walker OR a synthetic
/// one.
fn build_index_with_walker(
    root: &Path,
    walk: impl Fn(&Path, &mut dyn FnMut(PathBuf) -> bool),
) -> WorkspaceIndex {
    let started = Instant::now();
    let mut by_basename: HashMap<String, Vec<String>> = HashMap::new();
    let mut count = 0usize;
    let mut truncated = false;

    let mut on_file = |path: PathBuf| -> bool {
        if count >= MAX_INDEXED_FILES || started.elapsed() >= MAX_WALK {
            truncated = true;
            return false; // stop the walk
        }
        let Some(basename) = path.file_name().and_then(|n| n.to_str()) else {
            return true;
        };
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        by_basename
            .entry(basename.to_lowercase())
            .or_default()
            .push(rel);
        count += 1;
        true
    };
    walk(root, &mut on_file);

    WorkspaceIndex {
        by_basename,
        truncated,
    }
}

// ───────────────────────────── per-root cache ────────────────────────────

struct CacheSlot {
    built_at: Instant,
    index: std::sync::Arc<WorkspaceIndex>,
}

/// Global per-root index cache keyed by canonical (lowercased) absolute root.
static INDEX_CACHE: Lazy<Mutex<HashMap<String, CacheSlot>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn cache_key(root: &Path) -> String {
    root.to_string_lossy().to_lowercase()
}

/// Return the cached index for `root`, (re)building it when the cache is cold or
/// stale (TTL). LRU-bounds the cache to [`MAX_CACHED_ROOTS`]. The build
/// ([`build_index`]) runs OFF the dictation hot path (async on pin), so it favors
/// a COMPLETE enumeration (git ~0.4 s, non-git walk within [`MAX_WALK`]) over the
/// old tight synchronous deadline. A warm cache read at capture time stays O(1).
pub fn index_for_root(root: &Path) -> std::sync::Arc<WorkspaceIndex> {
    let key = cache_key(root);
    {
        let cache = INDEX_CACHE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(slot) = cache.get(&key)
            && slot.built_at.elapsed() < CACHE_TTL
        {
            return slot.index.clone();
        }
    }
    // Build OUTSIDE the lock (git enumeration ~0.4 s; the non-git walk up to
    // MAX_WALK) so a concurrent cached-root read never blocks on this build.
    let index = std::sync::Arc::new(build_index(root));
    let mut cache = INDEX_CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    cache.insert(
        key.clone(),
        CacheSlot {
            built_at: Instant::now(),
            index: index.clone(),
        },
    );
    // LRU eviction: drop the oldest builds beyond the cap.
    if cache.len() > MAX_CACHED_ROOTS {
        let mut by_age: Vec<(String, Instant)> =
            cache.iter().map(|(k, s)| (k.clone(), s.built_at)).collect();
        by_age.sort_by_key(|(_, t)| *t);
        let excess = cache.len() - MAX_CACHED_ROOTS;
        for (old_key, _) in by_age.into_iter().take(excess) {
            if old_key != key {
                cache.remove(&old_key);
            }
        }
    }
    index
}

// ───────────────────────── top-level entry points ────────────────────────

/// Resolve the pinned IDE window's workspace index, or `None` in every skip
/// case. Composes [`resolve_root`] + [`index_for_root`]; a `None` here leaves the
/// caller's KNOWN set exactly `= context_terms` (today's behavior).
pub fn index_for_pinned(
    window_title: &str,
    app_exe: Option<&str>,
) -> Option<std::sync::Arc<WorkspaceIndex>> {
    let root = resolve_root(window_title, app_exe)?;
    let index = index_for_root(&root);
    if index.is_empty() { None } else { Some(index) }
}

/// The set of workspace basenames to UNION into the tagger's KNOWN set for the
/// pinned IDE window. Empty in every skip case (root unknown / index empty /
/// non-Windows) so the union is a no-op and behavior is byte-for-byte today's.
pub fn basenames_for_pinned(window_title: &str, app_exe: Option<&str>) -> Vec<String> {
    index_for_pinned(window_title, app_exe)
        .map(|idx| idx.basenames())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests;
