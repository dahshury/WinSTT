import type { ModelInfo } from "@/entities/model-catalog";
import {
	FAVORITES_GROUP_VALUE,
	isFavoritesGroupValue,
	withFavoritesGroup as withCoreFavoritesGroup,
} from "../../core/favorites";
import type { FamilyKey } from "./family-metadata";

const SIZE_UNIT_MULTIPLIER: Record<string, number> = {
	"": 1,
	K: 1e3,
	M: 1e6,
	B: 1e9,
	T: 1e12,
};

const SIZE_LABEL_RE = /^([\d.]+)\s*([KMBT]?)/i;

/**
 * Parses a parameter-count label like "39M" / "1.5B" / "600M" into a numeric
 * value used purely for ordering. Unrecognised labels sort last.
 */
export function parseParameterSize(sizeLabel: string): number {
	const match = sizeLabel.trim().match(SIZE_LABEL_RE);
	if (!match || match[1] === undefined) {
		return Number.POSITIVE_INFINITY;
	}
	const value = Number.parseFloat(match[1]);
	if (Number.isNaN(value)) {
		return Number.POSITIVE_INFINITY;
	}
	const unit = (match[2] ?? "").toUpperCase();
	return value * (SIZE_UNIT_MULTIPLIER[unit] ?? 1);
}

function bucketByFamily(
	models: readonly ModelInfo[],
): Map<FamilyKey, ModelInfo[]> {
	const grouped = new Map<FamilyKey, ModelInfo[]>();
	for (const m of models) {
		const list = grouped.get(m.family) ?? [];
		list.push(m);
		grouped.set(m.family, list);
	}
	return grouped;
}

/**
 * Group models by family. Both the *group* order and the order *within* each
 * group are driven by parameter count (smallest → largest), so the picker
 * surfaces the cheapest entry-point in each family first and the cheapest
 * family overall ends up at the top. Empty families are dropped.
 */
export function groupByFamily(
	models: readonly ModelInfo[],
): [FamilyKey, ModelInfo[]][] {
	const grouped = bucketByFamily(models);
	const entries: [FamilyKey, ModelInfo[]][] = [];
	for (const [family, list] of grouped) {
		if (list.length === 0) {
			continue;
		}
		const sorted = [...list].sort(
			(a, b) =>
				parseParameterSize(a.sizeLabel) - parseParameterSize(b.sizeLabel),
		);
		entries.push([family, sorted]);
	}
	entries.sort(
		([, a], [, b]) =>
			parseParameterSize(a[0]?.sizeLabel ?? "") -
			parseParameterSize(b[0]?.sizeLabel ?? ""),
	);
	return entries;
}

/**
 * Base UI Combobox grouped-items shape: one entry per author/family with its
 * member models. `value` is the family key (used as the group identity);
 * the visible heading is derived via {@link getAuthorLabel}.
 */
export interface AuthorGroup {
	items: ModelInfo[];
	value: FamilyKey;
}

export function groupModelsByAuthor(
	models: readonly ModelInfo[],
): AuthorGroup[] {
	return groupByFamily(models).map(([value, items]) => ({ value, items }));
}

/**
 * Synthetic group value for the flat, globally-sorted view. Like
 * {@link FAVORITES_GROUP_VALUE} it is NOT a {@link FamilyKey} — it holds every
 * surviving model in one bucket so an active sort isn't fragmented across the
 * per-maker groups (and the maker rail is suppressed while it's shown).
 */
export const SORTED_GROUP_VALUE = "__sorted__";

/** A picker list group is a real maker family, the synthetic "favorites"
 *  aggregate pinned to the top, or the synthetic flat "sorted" column. */
export type SttGroupValue =
	| FamilyKey
	| typeof FAVORITES_GROUP_VALUE
	| typeof SORTED_GROUP_VALUE;

/** Widened {@link AuthorGroup} that also admits the synthetic groups. */
export interface SttListGroup {
	items: ModelInfo[];
	value: SttGroupValue;
}

/** Narrowing helper — true for the synthetic favorites group. */
export function isFavoritesGroup(
	value: SttGroupValue,
): value is typeof FAVORITES_GROUP_VALUE {
	return isFavoritesGroupValue(value);
}

/** Narrowing helper — true for the synthetic flat "sorted" group. */
export function isSortedGroup(
	value: SttGroupValue,
): value is typeof SORTED_GROUP_VALUE {
	return value === SORTED_GROUP_VALUE;
}

/**
 * Prepend a synthetic "Favorites" group to the per-maker author groups.
 *
 * The favorited models are walked in maker-sorted order (the order the author
 * groups already arrive in) and de-duplicated, so the Favorites group reads
 * the same top-to-bottom as the rest of the list. The models are REPEATED, not
 * moved — each starred model keeps its normal maker-group card AND gains a
 * shortcut card up top, which is exactly the requested behaviour.
 *
 * Returns the author groups unchanged (widened to {@link SttListGroup}) when
 * nothing is favorited, so the Favorites group / rail tile only appear once the
 * user has starred at least one model.
 */
export function withFavoritesGroup(
	groups: readonly AuthorGroup[],
	isFavorite: (modelId: string) => boolean,
): SttListGroup[] {
	return withCoreFavoritesGroup(groups, isFavorite, (model) => model.id);
}
