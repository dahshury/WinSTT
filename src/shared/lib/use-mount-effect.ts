import { type EffectCallback, useEffect } from "react";

/**
 * Run an effect exactly once, after the component mounts. A semantic wrapper for
 * the `useEffect(fn, [])` idiom: the empty dependency array is the whole point,
 * so naming the intent ("on mount") beats leaving a bare `[]` for the next
 * reader (and every linter) to second-guess.
 *
 * The wrapped effect is deliberately NOT reactive — values it closes over are
 * read once at mount and never re-synced. Reach for this only when that is the
 * intended behaviour (a one-shot warm-up / fetch on open). If the effect should
 * re-run when something changes, use `useEffect` with real dependencies instead.
 */
export function useMountEffect(effect: EffectCallback): void {
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only by design — the empty deps are this primitive's entire contract
	useEffect(effect, []); // react-doctor-disable-line react-doctor/exhaustive-deps -- mount-only by design; the empty deps are this primitive's entire contract
}
