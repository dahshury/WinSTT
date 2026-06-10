/**
 * Helpers for the Ollama quantization precision shelf — the per-model strip of
 * quant badges that mirrors the STT picker's precision shelf (one badge per
 * quantization, with click-to-download / select / pause / resume / cancel /
 * delete folded directly into the badge).
 *
 * Ollama's library tags entangle TWO axes on one flat list: parameter size and
 * quantization (e.g. `gemma3` exposes `4b`, `4b-q4_K_M`, `27b`, `27b-q8_0`).
 * A single model card represents ONE parameter size, so these helpers slice the
 * tag list down to the card's param-size and surface only the quant axis as
 * badges — exactly how the STT card surfaces only the precision axis.
 */

import type { OllamaLibraryTag } from "@/shared/api/models";

/**
 * Derive the base library slug from any Ollama pull tag or installed model name.
 * Everything before the first `:` is the family slug the library/tags endpoint
 * is keyed under: `gemma3:4b-q8_0` → `gemma3`, `llama3.2:1b` → `llama3.2`,
 * `gemma3` (bare) → `gemma3`. The result is lower-cased to match the
 * `tagsByModel` cache key (see `tagsCacheKey` in the library store).
 */
export function libraryBaseSlug(name: string): string {
	const trimmed = name.trim();
	const colonIdx = trimmed.indexOf(":");
	const base = colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed;
	return base.toLowerCase();
}

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

/**
 * Collapse installed models that are the SAME on-disk artifact reached through
 * different tag names. Ollama's `/api/tags` lists every tag that points at a
 * blob, so a model pulled under two names (e.g. `gemma4:e2b` and
 * `gemma4:e2b-it-q4_K_M` — identical digest, see {@link OLLAMA_TAG_ALIAS_GROUPS})
 * shows up as two rows that format to the same / near-same label. Group by
 * identity key and keep ONE representative per group:
 *   - the currently-selected tag wins (so the picker's `value` still resolves to
 *     a rendered row);
 *   - otherwise the shorter name wins — the bare default tag (`gemma4:e2b`)
 *     reads cleaner than its `-it-q4_K_M` sibling.
 * First-seen order is preserved.
 */
export function dedupeInstalledOllamaModels<T extends { name: string }>(
	models: readonly T[],
	selectedName?: string,
): T[] {
	const byIdentity = new Map<string, T>();
	const order: string[] = [];
	for (const model of models) {
		const key = ollamaTagIdentityKey(model.name);
		const existing = byIdentity.get(key);
		if (!existing) {
			byIdentity.set(key, model);
			order.push(key);
			continue;
		}
		byIdentity.set(
			key,
			preferInstalledOllamaTag(existing, model, selectedName),
		);
	}
	return order.map((key) => byIdentity.get(key) as T);
}

function preferInstalledOllamaTag<T extends { name: string }>(
	current: T,
	candidate: T,
	selectedName?: string,
): T {
	if (selectedName) {
		if (current.name === selectedName) {
			return current;
		}
		if (candidate.name === selectedName) {
			return candidate;
		}
	}
	// Shorter name = the barer default tag, which formats to the cleaner label.
	if (candidate.name.length < current.name.length) {
		return candidate;
	}
	return current;
}

/**
 * True when `tagName` is present in `installedNames`, treating a bare name and
 * its `:latest` tag as equal. Without this, a model pulled by a bare name (its
 * on-disk name becomes `<name>:latest`) leaves its "default" badge reading as
 * not-installed even though it's downloaded.
 */
export function findInstalledOllamaTag(
	installedNames: ReadonlySet<string>,
	tagName: string,
): string | undefined {
	if (installedNames.has(tagName)) {
		return tagName;
	}
	const target = ollamaTagIdentityKey(tagName);
	for (const name of installedNames) {
		if (ollamaTagIdentityKey(name) === target) {
			return name;
		}
	}
	return undefined;
}

export function isTagInstalled(
	installedNames: ReadonlySet<string>,
	tagName: string,
): boolean {
	return findInstalledOllamaTag(installedNames, tagName) !== undefined;
}

/**
 * True when an installed model covers the same (base slug, parameter size) as
 * `tagName`, regardless of quantization OR the `-it` instruction-tuned suffix.
 *
 * {@link isTagInstalled} is deliberately quant-SPECIFIC — the quant shelf marks
 * one badge per precision — but a recommended/library CARD represents a whole
 * parameter size, so it must disappear once the user has ANY variant of that
 * size on disk. Without this, the recommended `gemma4:e2b` card sits right next
 * to the installed `gemma4:e2b-it-q8_0` card (whose quant the brittle alias
 * table in {@link ollamaTagIdentityKey} doesn't map), reading as a duplicate
 * "Gemma 4 E2B" / "Gemma 4 E2B IT" pair. The installed card's own quant shelf
 * already lists every precision for the size, so collapsing into it loses
 * nothing.
 *
 * A `tagName` with no parseable param token (a bare base) is covered by any
 * installed sibling sharing the base slug.
 */
export function isModelSizeInstalled(
	installedNames: ReadonlySet<string>,
	tagName: string,
): boolean {
	const base = libraryBaseSlug(tagName);
	const param = normalizeParamSize(paramSizeFromName(tagName));
	for (const name of installedNames) {
		if (libraryBaseSlug(name) !== base) {
			continue;
		}
		if (!param || normalizeParamSize(paramSizeFromName(name)) === param) {
			return true;
		}
	}
	return false;
}

/**
 * Normalize a parameter-size label for comparison. Installed models report
 * `details.parameterSize` as `4B` / `1.2B`; library tags carry `parameterSize`
 * as `4b` / `1.2b`. Lower-casing + whitespace-stripping makes them comparable
 * without caring which source produced the string.
 */
function normalizeParamSize(value: string | null | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

/**
 * The param-size token carried by an installed model name's variant, when the
 * structured `details.parameterSize` is missing. `gemma3:4b-q8_0` → `4b`,
 * `qwen3:1.7b` → `1.7b`. Returns `""` when the name has no `<digits>b/m/k`
 * token (e.g. a bare `gemma3` or `phi3:mini`).
 */
// The optional `e` prefix captures Gemma 3n/4 MatFormer "effective" sizes
// (`gemma4:e2b` → `e2b`) so they group/filter like any other param token.
const PARAM_FROM_VARIANT_RE = /(?:^|[-_])(e?\d+(?:\.\d+)?[mbk])(?=$|[-_])/i;
export function paramSizeFromName(name: string): string {
	const colonIdx = name.indexOf(":");
	const variant = colonIdx >= 0 ? name.slice(colonIdx + 1) : "";
	const match = PARAM_FROM_VARIANT_RE.exec(variant);
	return match?.[1] ? match[1].toLowerCase() : "";
}

/**
 * Cloud-hosted variants (`gemma3:4b-cloud`) aren't local quantizations — they
 * carry no download size and resolve to a hosted endpoint rather than weights —
 * so the quant shelf (which is a download/select strip) omits them.
 */
const CLOUD_TOKEN_RE = /(?:^|[-_:])cloud(?=$|[-_])/i;
function isCloudTag(tag: OllamaLibraryTag): boolean {
	return CLOUD_TOKEN_RE.test(tag.name);
}

/**
 * Sort quant tags heaviest → lightest (descending download size) so the shelf
 * reads most-capable / most-RAM on the left to least on the right — higher
 * precision is bigger AND more faithful. Tags with no known size sort last;
 * equal sizes keep their incoming order (stable).
 */
function tagWeight(tag: OllamaLibraryTag): number {
	return tag.sizeBytes ?? -1;
}
function sortByCapabilityDesc(
	tags: readonly OllamaLibraryTag[],
): readonly OllamaLibraryTag[] {
	return [...tags].sort((a, b) => tagWeight(b) - tagWeight(a));
}

/**
 * Quant pruning — Ollama lists 15–20+ tags per size (legacy linear q4_0/q5_1,
 * Apple-only MLX, niche mxfp8/nvfp4, every K-quant _S/_M/_L, bf16≈fp16). Most are
 * strictly dominated or platform-irrelevant, so the shelf shows ONLY the explicit
 * canonical precision ladder — q4_K_M (sweet spot) · q5_K_M · q8_0 · fp16.
 *
 * The bare "default" / `:latest` tag (no precision token) is deliberately NOT a
 * shelf badge — it is the model's AUTO/recommended pick, surfaced by clicking the
 * card BODY instead (mirrors the STT picker, where the "Auto" badge was removed
 * and a card-body click selects the recommended precision). Anything else is
 * hidden UNLESS the user already has it on disk / downloading / paused / selected
 * (so an installed odd quant — or the default they already pulled — never vanishes
 * mid-flight; `pruneToShownQuants`'s `forceKeep` keeps it).
 */
const CANONICAL_QUANT_RE = /(?:^|[-_:])(q4_k_m|q5_k_m|q8_0|fp16)(?=$|[-_:])/i;

function isShownQuantTag(name: string): boolean {
	// Only the explicit canonical quant ladder gets a badge. A bare default (no
	// precision token) is now the card-body "auto" pick, not a shelf badge; a
	// non-canonical precision token (mlx / mxfp8 / bf16 / q2_K …) stays dominated.
	return CANONICAL_QUANT_RE.test(name);
}

/**
 * Drop dominated/irrelevant quants from a tag list, keeping the canonical ladder
 * plus any tag `forceKeep` vouches for (installed / pulling / paused / selected).
 */
export function pruneToShownQuants(
	tags: readonly OllamaLibraryTag[],
	forceKeep: (name: string) => boolean,
): readonly OllamaLibraryTag[] {
	return tags.filter((tag) => isShownQuantTag(tag.name) || forceKeep(tag.name));
}

/**
 * Filter a model's library tags down to those matching one parameter size — the
 * size the card represents. Each surviving tag becomes one quant badge. Cloud
 * variants are dropped first (not locally pullable).
 *
 * When `paramSize` is empty (e.g. a bare-base library hit with no param token,
 * or an installed model that didn't advertise one) every pullable tag is kept so
 * the shelf still shows the available quants rather than collapsing to nothing.
 */
export function tagsForParamSize(
	tags: readonly OllamaLibraryTag[],
	paramSize: string | null | undefined,
): readonly OllamaLibraryTag[] {
	const pullable = tags.filter((tag) => !isCloudTag(tag));
	const target = normalizeParamSize(paramSize);
	if (!target) {
		return sortByCapabilityDesc(pullable);
	}
	const matched = pullable.filter(
		(tag) => normalizeParamSize(tag.parameterSize) === target,
	);
	// If nothing matched the requested size (the tag list might omit
	// `parameterSize`, or use a slightly different label), fall back to the full
	// pullable list so the shelf is never empty when tags exist.
	return sortByCapabilityDesc(matched.length > 0 ? matched : pullable);
}

/**
 * The badge label for one quant tag. Prefers the parsed `quantization` marker
 * (`Q8_0`, `Q4_K_M`, `fp16`); recognizes the `qat` token (quantization-aware
 * training — a distinct int4 build the `q\d…` parser misses, so it would
 * otherwise collapse to "default"); falls back to `latest` for the `latest`
 * alias and `default` for a bare tag with no advertised quant — mirroring how
 * the STT shelf labels its "default" export.
 */
const QAT_TOKEN_RE = /(?:^|[-_:])qat(?=$|[-_])/i;
export function quantBadgeLabel(tag: OllamaLibraryTag): string {
	if (tag.quantization && tag.quantization.trim().length > 0) {
		return tag.quantization;
	}
	if (QAT_TOKEN_RE.test(tag.name)) {
		return "QAT";
	}
	if (tag.isLatest) {
		return "latest";
	}
	return "default";
}

/**
 * The on-disk state of one quant badge, mapped to the same vocabulary the STT
 * shelf uses for its `badgeToneForCache` tints:
 *   - `cached`     installed → muted emerald
 *   - `partial`    paused pull on disk → muted amber
 *   - `not_cached` neither → neutral (the badge is the download button)
 *
 * Active pulls aren't a cache state — they're handled separately (progress fill
 * + pause/cancel controls), like the STT shelf's `isDownloading` branch.
 */
export type QuantBadgeCacheState = "cached" | "partial" | "not_cached";

export function quantBadgeCacheState(opts: {
	installed: boolean;
	paused: boolean;
}): QuantBadgeCacheState {
	if (opts.installed) {
		return "cached";
	}
	if (opts.paused) {
		return "partial";
	}
	return "not_cached";
}
