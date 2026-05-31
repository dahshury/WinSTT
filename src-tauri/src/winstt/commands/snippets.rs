// PORT IMPL — snippet expansion command + cache-warm bridge.
//
// Source (behavioral): frontend/electron/lib/text-processing.ts
// (`applyPostProcessing` / `getPostProcessingVocab` / the `onDidChange("snippets")`
// watcher) + frontend/src/shared/lib/fuzzy-match.ts (`replaceWithSnippets`).
//
// Snippet CRUD has NO dedicated IPC command in the reference — the snippets array
// is part of the settings tree and is edited wholesale through
// `winstt_set_settings({ snippets })` (the renderer's SnippetsTable is fully
// controlled by its parent panel). So this file deliberately exposes NO add/remove/
// list commands; it provides:
//
//   * `winstt_expand_snippets` — a read-only command that returns exactly what the
//     recorder would expand for a given input (the in-proc analogue of the renderer
//     calling `applyPostProcessing` over IPC). Useful for the context playground /
//     a live snippet preview, and harmless otherwise. It reads the live settings so
//     a just-edited snippet shows immediately.
//
//   * `install_snippet_reload_bridge` — keeps the in-memory snippet cache warm:
//     loads it once at startup and re-loads it on every `settings:changed`
//     broadcast (the Rust analogue of the TS store watcher). Call once from lib.rs
//     setup AFTER `seed_defaults`. NOT a `#[tauri::command]` — it's a setup hook.

use tauri::{AppHandle, Listener};

use crate::winstt::snippets;

/// `winstt_expand_snippets` — apply the user's snippet expansions to `text` and
/// return the result (reading the live settings first so a fresh edit is
/// reflected immediately). A no-op when there are no snippets. Mirrors the snippet
/// half of `applyPostProcessing`; the recorder's paste path applies the same
/// transform via `snippets::expand_cached` on the finalized transcription.
#[tauri::command]
#[specta::specta]
pub fn winstt_expand_snippets(app: AppHandle, text: String) -> String {
    snippets::expand_snippets(&app, &text)
}

/// Warm the snippet cache at startup and keep it in sync with settings edits.
///
/// The expansion hot path (`snippets::expand_cached`, called from the paste
/// pipeline) reads an in-memory cache instead of the store on every utterance.
/// This installer:
///   1. loads the cache once from the persisted settings, and
///   2. subscribes to `settings:changed` so a snippet add/remove (which the
///      renderer posts via `winstt_set_settings`) rebuilds the cache on the very
///      next utterance — the in-proc equivalent of the TS
///      `onDidChange("snippets", rebuildSnippets)` watcher.
///
/// Idempotent enough for one call from lib.rs setup; a second call would simply
/// register a second (harmless) listener, so call it exactly once.
pub fn install_snippet_reload_bridge(app: &AppHandle) {
    // Initial warm-up from the persisted tree.
    snippets::reload_from_settings(app);

    // Rebuild on every settings save. `settings:changed` carries the full snapshot,
    // but we re-read the store (cheap, and the single source of truth) rather than
    // parsing the event payload so the cache can never diverge from disk.
    let handle = app.clone();
    app.listen("settings:changed", move |_event| {
        snippets::reload_from_settings(&handle);
    });
}
