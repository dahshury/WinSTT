/**
 * Module-level timestamp of the most recent ``settingsLoad()`` IPC resolution.
 *
 * Shared between ``useSyncSettings`` (which stamps it on every IPC resolve)
 * and ``useSyncActiveModel`` (which reads it to suppress its transition-guard
 * ``beginSwap`` when the transition came from a setSettings(loaded) revert,
 * not a user pick). Lives at module scope rather than inside a ref so that
 * cross-hook reads work across StrictMode double-mount + multiple
 * useSyncSettings instances.
 *
 * The original death-spiral repro:
 *
 * 1. localStorage hydrates with stale ``model.model = "tiny"``.
 * 2. ``adoptRuntime`` flips settings to the actually-loaded canary.
 * 3. ``settingsLoad`` resolves with disk = (still-stale) tiny.
 * 4. ``setSettings(loaded)`` reverts the renderer back to tiny.
 * 5. ``useSyncActiveModel`` sees a canary → tiny transition and fires
 *    ``beginSwap("main", canary, tiny)`` — ``activeMain = "tiny"``.
 * 6. ``shouldAdoptRuntimeModel`` now bails because ``activeMain != null``.
 * 7. Debounced save fires with settings = tiny → disk = tiny.
 * 8. Next boot: same loop.
 *
 * The 500 ms guard window covers the entire boot reconciliation cycle
 * (Zustand hydration + IPC roundtrip + runtime_info arrival + adoption
 * + setSettings(loaded) re-render under StrictMode), longer than typical
 * user-pick reaction time. Any real user pick more than 500 ms after the
 * last settingsLoad still fires beginSwap normally.
 */
let lastResolvedAt = 0;

export function markIpcLoadResolved(): void {
	lastResolvedAt = Date.now();
}

export function recentIpcLoadAt(): number {
	return lastResolvedAt;
}

/**
 * Test-only: reset the module-level timestamp to 0 so the next consumer
 * sees "no recent IPC load" (guard inactive). Used by unit tests that
 * exercise `performScheduledSave` / `useSyncActiveModel` without standing
 * up the real boot reconciliation cycle.
 */
export function _resetIpcLoadTimingForTests(): void {
	lastResolvedAt = 0;
}
