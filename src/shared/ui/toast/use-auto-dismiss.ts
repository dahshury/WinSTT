import { useEffect } from "react";

/**
 * Schedules `onDismiss` to fire `ms` milliseconds after `active` becomes
 * truthy, cancelling the pending timer whenever `active` flips off or the
 * dependency changes. Centralises the "transient toast self-clears on a timer"
 * effect shared by every toast in the app.
 *
 * @param active When falsy, no timer is armed (and any pending one is cleared).
 *               Pass the toast's `current` entry (or a derived key) so a fresh
 *               notification restarts the countdown.
 * @param onDismiss Invoked once the timer elapses.
 * @param ms Delay before dismissal, in milliseconds.
 */
export function useAutoDismiss(
	active: unknown,
	onDismiss: () => void,
	ms: number,
): void {
	useEffect(() => {
		if (!active) {
			return;
		}
		const id = window.setTimeout(onDismiss, ms);
		return () => window.clearTimeout(id);
	}, [active, onDismiss, ms]);
}
