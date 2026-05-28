/**
 * Module-level timestamp of the most recent ``model_swap_failed`` event.
 *
 * Shared between the model-swap store (which stamps it the moment the server
 * reports a failed/superseded swap) and ``useSyncActiveModel`` (which reads it
 * to suppress its transition-guard ``beginSwap`` when the next
 * ``settings.model`` change is a failure-induced ROLLBACK, not a user pick).
 *
 * The bug this fixes — the "first click shows a reversed B→A swap that spins
 * forever":
 *
 * 1. User (on model A) clicks model B. The picker writes ``settings.model =
 *    B`` and fires ``reload_main_model(B)``.
 * 2. The server swap fails (or is superseded) → ``model_swap_failed``.
 * 3. The swap controller's failure handler rolls the picker back:
 *    ``settings.model = A``.
 * 4. ``useSyncActiveModel`` sees ``settings.model`` go B → A while
 *    ``runtimeInfo.model`` is still the stale B, so it interprets the
 *    rollback as a *fresh* user swap and fires ``beginSwap("main", B, A)`` —
 *    a reversed, never-completing "switch to the model that's already
 *    loaded". Nothing clears it, so the chip is stuck on "B → A" forever.
 *
 * A rollback is never a real swap (no ``reload_*_model`` is in flight for it),
 * so the implicit beginSwap must be skipped for it. Stamping the failure time
 * and guarding the next transition for a short window does exactly that
 * without affecting genuine cross-window user picks (which never emit
 * ``model_swap_failed``). Lives at module scope — not a ref — so cross-hook
 * reads work across StrictMode double-mount and multiple hook instances, same
 * as {@link ./ipc-load-timing}.
 */
let lastSwapFailedAt = 0;

export function markSwapFailed(): void {
	lastSwapFailedAt = Date.now();
}

export function recentSwapFailedAt(): number {
	return lastSwapFailedAt;
}

/** Test-only: reset to 0 so the next consumer sees "no recent failure". */
export function _resetSwapFailureTimingForTests(): void {
	lastSwapFailedAt = 0;
}
