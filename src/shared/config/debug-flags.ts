/**
 * Debug-only feature flags.
 *
 * Single source of truth, importable from BOTH the renderer (`@/shared/...`)
 * and the reference main process (relative `../../src/shared/...`, the same way
 * `ipc-channels.ts` is consumed by the preload + handlers).
 *
 * These gate developer-only tooling that must NEVER ship visible to end users.
 * Flip a flag to `false` to remove the visible surface. Production builds also
 * drop the context-playground entry unless `VITE_CONTEXT_PLAYGROUND=1`.
 */

/**
 * Context-awareness playground: a live debug window that shows EXACTLY what the
 * context-capture pipeline pulls from whatever input field you focus in any
 * app — raw UIA snapshot, the deny-list verdict, the LLM prompt fragment, the
 * Whisper ASR prompt tail, and per-mode (tree / split / default / selection)
 * comparisons. Used to tune `general.contextAwareness` (and the IDE / code
 * "Variable Recognition" backtick path).
 *
 * ON automatically in dev (`tauri dev`), OFF in shipped builds. Force it on in a
 * production build with `VITE_CONTEXT_PLAYGROUND=1` — the same env var that makes
 * `vite.config.ts` ship the `context-playground` HTML entry. The Rust side pairs
 * with this via `#[cfg(any(debug_assertions, feature = "context-playground"))]`,
 * so the window spec + live commands exist exactly when this flag is true.
 */
export const CONTEXT_PLAYGROUND_ENABLED =
	import.meta.env.DEV || import.meta.env.VITE_CONTEXT_PLAYGROUND === "1";
