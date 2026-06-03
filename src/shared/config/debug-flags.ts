/**
 * Debug-only feature flags.
 *
 * Single source of truth, importable from BOTH the renderer (`@/shared/...`)
 * and the reference main process (relative `../../src/shared/...`, the same way
 * `ipc-channels.ts` is consumed by the preload + handlers).
 *
 * These gate developer-only tooling that must NEVER ship visible to end users.
 * Flip a flag to `false` to fully remove the surface — the gated window, IPC,
 * polling loop, and tray entry all disappear. The code stays in the bundle but
 * is unreachable, which is exactly the "enable now, disable later" workflow.
 */

/**
 * Context-awareness playground: a live debug window that shows EXACTLY what the
 * context-capture pipeline pulls from whatever input field you focus in any
 * app — raw UIA snapshot, the deny-list verdict, the LLM prompt fragment, the
 * Whisper ASR prompt tail, and per-mode (tree / split / default / selection)
 * comparisons. Used to tune `general.contextAwareness`.
 *
 * Set to `false` before shipping a public build.
 */
export const CONTEXT_PLAYGROUND_ENABLED = false;
