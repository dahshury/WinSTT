/**
 * Generic scaffolding for the picker catalog-filter state shared by the STT and
 * Ollama selectors (the Ollama filter module was ported from STT's). The domain
 * filter shapes diverge — STT filters `ModelInfo` through a language + hardware
 * predicate pipeline, Ollama prunes separate installed / recommended lists — so
 * only the table-driven active-flag count is genuinely common. Each slice keeps
 * its own state interface, predicates, and empty-state constant.
 */

/**
 * Count how many of the given boolean flags are active on a filter state — the
 * table-driven "active filter" tally both selectors compute the same way (STT
 * then adds its per-language chip count on top). Passing only the flags a menu
 * actually renders keeps a stale flag from a host without the backing data from
 * inflating the trigger badge.
 */
export function countActiveFlags<TState>(
	state: TState,
	flags: readonly (keyof TState)[],
): number {
	return flags.filter((flag) => Boolean(state[flag])).length;
}
