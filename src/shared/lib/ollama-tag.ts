/**
 * Ollama tag identity — shared by the model pickers (badge/alias rendering)
 * AND the llm-catalog store (pull lifecycle), so "the same artifact reached
 * through different tag names" is one notion everywhere. Two names alias when
 * they resolve to the same on-disk digest: the implicit `:latest` default
 * (`tinyllama` ≡ `tinyllama:latest`) and the curated same-digest groups below
 * (`gemma4:e2b` ≡ `gemma4:e2b-it-q4_K_M`). Keeping pull bookkeeping keyed on
 * identity (not raw strings) is what makes pause/cancel act on EVERY stream of
 * a model instead of whichever exact spelling started it.
 */

/**
 * Ollama's `:latest` is the implicit default tag — `ollama pull tinyllama` lands
 * on disk as `tinyllama:latest`, while the recommended list / library scrape may
 * name the same artifact bare (`tinyllama`). Canonicalize to the explicit
 * `:latest` form so installed/selected comparisons match regardless of which
 * form produced the name.
 */
export function canonicalOllamaTag(name: string): string {
	const trimmed = name.trim();
	return trimmed.includes(":") ? trimmed : `${trimmed}:latest`;
}

const OLLAMA_TAG_ALIAS_GROUPS: readonly (readonly string[])[] = [
	// Same Ollama digest aliases only. Do not map to a smaller/better quant here:
	// those are different downloads and must stay separate choices.
	["smollm2:135m-instruct-fp16", "smollm2:135m"],
	["smollm2:360m-instruct-fp16", "smollm2:360m"],
	["llama3.2:1b-instruct-q8_0", "llama3.2:1b"],
	["llama3.2:3b-instruct-q4_k_m", "llama3.2:3b"],
	["ministral-3:3b-instruct-2512-q4_k_m", "ministral-3:3b"],
	["gemma4:e2b-it-q4_k_m", "gemma4:e2b"],
	["gemma4:e4b-it-q4_k_m", "gemma4:e4b"],
	["gemma4:12b-it-q4_k_m", "gemma4:12b"],
];

function buildAliasLookup(
	groups: readonly (readonly string[])[],
): ReadonlyMap<string, string> {
	const lookup = new Map<string, string>();
	for (const group of groups) {
		const identity = group[0];
		if (!identity) {
			continue;
		}
		for (const alias of group) {
			lookup.set(canonicalOllamaTag(alias).toLowerCase(), identity);
		}
	}
	return lookup;
}

const OLLAMA_TAG_ALIAS_LOOKUP = buildAliasLookup(OLLAMA_TAG_ALIAS_GROUPS);

export function ollamaTagIdentityKey(name: string): string {
	const canonical = canonicalOllamaTag(name).toLowerCase();
	return OLLAMA_TAG_ALIAS_LOOKUP.get(canonical) ?? canonical;
}

/** True when `a` and `b` name the same Ollama artifact (treating bare ≡ `:latest`). */
export function isSameOllamaTag(a: string | undefined, b: string): boolean {
	return a !== undefined && ollamaTagIdentityKey(a) === ollamaTagIdentityKey(b);
}
