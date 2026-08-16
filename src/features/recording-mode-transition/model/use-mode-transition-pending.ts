import { useModeTransitionStore } from "./transition-store";

export interface ModeTransitionPending {
	/** Mode the app is switching TO while `isPending`; null when settled. */
	target: string | null;
	/** Lock mode controls and show the spinner. */
	isPending: boolean;
}

/**
 * The one thing a mode control needs from the transition phase: whether to lock
 * itself and badge a spinner, plus the mode being loaded (for a label).
 */
export function useModeTransitionPending(): ModeTransitionPending {
	const isPending = useModeTransitionStore((s) => s.isPreparing);
	const target = useModeTransitionStore((s) => s.transition.to);
	return { target: isPending ? target : null, isPending };
}
