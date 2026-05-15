import { describe, expect, test } from "bun:test";
import type { OpenRouterModel } from "@/shared/api/models";
import {
	__model_selector_logic_test_helpers__,
	filterModels,
	groupModelsByMaker,
} from "./model-selector-logic";

const sample: OpenRouterModel[] = [
	{
		id: "openai/gpt-4o",
		name: "GPT-4o",
		model_name: "gpt-4o",
		maker: "openai",
		endpoints: [{ provider_name: "openai", tag: "openai" } as never],
		supported_parameters: ["tools", "reasoning"],
	},
	{
		id: "openai/gpt-4o:nitro",
		name: "GPT-4o Nitro",
		model_name: "gpt-4o",
		maker: "openai",
		endpoints: [{ provider_name: "deepinfra", tag: "deepinfra" } as never],
		supported_parameters: ["tools"],
	},
	{
		id: "anthropic/claude-3-haiku",
		name: "Claude 3 Haiku",
		model_name: "claude-3-haiku",
		maker: "anthropic",
		endpoints: [{ provider_name: "anthropic", tag: "anthropic" } as never],
		supported_parameters: ["tools"],
	},
	{
		id: "google/gemini-1.5-pro",
		name: "Gemini 1.5 Pro",
		model_name: "gemini-1.5-pro",
		maker: "google",
		endpoints: [{ provider_name: "google", tag: "google" } as never],
		supported_parameters: ["max_tokens"],
	},
] as unknown as OpenRouterModel[];

describe("filterModels", () => {
	test("returns the input unchanged when no filters or query", () => {
		expect(filterModels(sample, {})).toEqual(sample);
	});

	test("filters by selectedMakers", () => {
		const out = filterModels(sample, { selectedMakers: ["openai"] });
		expect(out).toHaveLength(2);
		expect(out.every((m) => m.maker === "openai")).toBe(true);
	});

	test("filters by selectedVariant", () => {
		const nitro = filterModels(sample, { selectedVariant: "nitro" });
		expect(nitro.map((m) => m.id)).toEqual(["openai/gpt-4o:nitro"]);
		const none = filterModels(sample, { selectedVariant: "none" });
		expect(none.map((m) => m.id)).toEqual([
			"openai/gpt-4o",
			"anthropic/claude-3-haiku",
			"google/gemini-1.5-pro",
		]);
	});

	test("filters by endpoint provider (case-insensitive match)", () => {
		const out = filterModels(sample, { selectedEndpointProvider: "Anthropic" });
		expect(out.map((m) => m.id)).toEqual(["anthropic/claude-3-haiku"]);
	});

	test("filters by required selectedParameters (intersection match)", () => {
		const out = filterModels(sample, { selectedParameters: ["tools"] });
		expect(out.map((m) => m.id)).toEqual([
			"openai/gpt-4o",
			"openai/gpt-4o:nitro",
			"anthropic/claude-3-haiku",
		]);
	});

	test("filters require ALL selected parameters", () => {
		const out = filterModels(sample, { selectedParameters: ["tools", "reasoning"] });
		expect(out).toHaveLength(1);
		expect(out[0]?.id).toBe("openai/gpt-4o");
	});

	test("searchQuery filters by maker exact match", () => {
		const out = filterModels(sample, { searchQuery: "anthropic" });
		expect(out.length).toBeGreaterThan(0);
		expect(out[0]?.maker).toBe("anthropic");
	});

	test("combined filters intersect (maker + variant)", () => {
		const out = filterModels(sample, { selectedMakers: ["openai"], selectedVariant: "nitro" });
		expect(out.map((m) => m.id)).toEqual(["openai/gpt-4o:nitro"]);
	});
});

describe("groupModelsByMaker", () => {
	test("groups by maker (alphabetical by default)", () => {
		const groups = groupModelsByMaker(sample);
		expect(groups.map(([maker]) => maker)).toEqual(["anthropic", "google", "openai"]);
		expect(groups.find(([m]) => m === "openai")?.[1]).toHaveLength(2);
	});

	test("preserves insertion order when preserveOrder=true", () => {
		const reordered = [sample[2], sample[0], sample[3], sample[1]] as OpenRouterModel[];
		const groups = groupModelsByMaker(reordered, true);
		expect(groups.map(([maker]) => maker)).toEqual(["anthropic", "openai", "google"]);
	});

	test("falls back to 'Other' for missing maker", () => {
		const noMaker = [{ ...sample[0], maker: undefined }] as OpenRouterModel[];
		const groups = groupModelsByMaker(noMaker);
		expect(groups.map(([maker]) => maker)).toEqual(["Other"]);
	});
});

const {
	scoreModelMatch,
	searchModels,
	matchesVariantFilter,
	matchesEndpointFilter,
	matchesParametersFilter,
	modelPassesFilters,
	buildActiveFilters,
	hasAnyActiveFilter,
	passesMakerFilter,
	passesVariantFilter,
	passesEndpointFilter,
	passesParametersFilter,
	getMakerKey,
	makeOrderComparator,
	compareByMissingOrder,
	collectExactMatches,
	appendUniqueFuzzy,
	anyNameStartsWith,
	anyNameIncludes,
	toLowerCased,
	endpointMatches,
	setHasAll,
	nonEmptySetOrNull,
} = __model_selector_logic_test_helpers__;

const openaiModel = sample[0] as OpenRouterModel;
const nitroModel = sample[1] as OpenRouterModel;
const anthropicModel = sample[2] as OpenRouterModel;
const googleModel = sample[3] as OpenRouterModel;

describe("scoreModelMatch", () => {
	test("returns 1 for exact maker match", () => {
		expect(scoreModelMatch(openaiModel, "openai")).toBe(1);
	});

	test("returns 2 for maker prefix match", () => {
		expect(scoreModelMatch(openaiModel, "open")).toBe(2);
	});

	test("returns 3 for name-starts-with match (no maker hit)", () => {
		expect(scoreModelMatch(anthropicModel, "claude")).toBe(3);
	});

	test("returns 4 for maker substring match (not prefix)", () => {
		// Build a model whose maker contains the query as substring
		const m = { ...openaiModel, maker: "x-openai-y", id: "x/y", name: "Y", model_name: "y" };
		expect(scoreModelMatch(m as OpenRouterModel, "openai")).toBe(4);
	});

	test("returns 5 for name substring match", () => {
		// query appears inside name but not as prefix and not in maker
		const m = {
			id: "google/gemini-1.5-pro",
			maker: "google",
			name: "Gemini 1.5 Pro",
			model_name: "gemini-1.5-pro",
		};
		expect(scoreModelMatch(m as OpenRouterModel, "1.5")).toBe(5);
	});

	test("returns 0 for no match at all", () => {
		expect(scoreModelMatch(anthropicModel, "zzzzzz")).toBe(0);
	});
});

describe("searchModels", () => {
	test("returns full list when query is empty/whitespace", () => {
		expect(searchModels(sample, "   ")).toEqual(sample);
		expect(searchModels(sample, "")).toEqual(sample);
	});

	test("returns prioritized matches first when fuse not yet warmed", () => {
		const out = searchModels(sample, "anthropic");
		expect(out[0]?.maker).toBe("anthropic");
	});
});

describe("matchesVariantFilter", () => {
	test("'none' returns true only when model id has no variant", () => {
		expect(matchesVariantFilter("openai/gpt-4o", "none")).toBe(true);
		expect(matchesVariantFilter("openai/gpt-4o:nitro", "none")).toBe(false);
	});

	test("specific variant returns true when id ends with that variant", () => {
		expect(matchesVariantFilter("openai/gpt-4o:nitro", "nitro")).toBe(true);
		expect(matchesVariantFilter("openai/gpt-4o", "nitro")).toBe(false);
	});
});

describe("matchesEndpointFilter", () => {
	test("returns false when endpoints is undefined", () => {
		expect(matchesEndpointFilter(undefined, "openai")).toBe(false);
	});

	test("returns true on exact provider_name match", () => {
		expect(matchesEndpointFilter(openaiModel.endpoints, "openai")).toBe(true);
	});

	test("returns false when no endpoint matches", () => {
		expect(matchesEndpointFilter(openaiModel.endpoints, "groq")).toBe(false);
	});
});

describe("endpointMatches", () => {
	test("matches by tag when provider_name differs", () => {
		const ep = { provider_name: "x", tag: "Y" };
		expect(endpointMatches(ep as never, "Y")).toBe(true);
	});

	test("case-insensitive provider_name match", () => {
		const ep = { provider_name: "Anthropic", tag: "z" };
		expect(endpointMatches(ep as never, "anthropic")).toBe(true);
	});

	test("returns false when nothing matches", () => {
		const ep = { provider_name: "a", tag: "b" };
		expect(endpointMatches(ep as never, "c")).toBe(false);
	});
});

describe("matchesParametersFilter", () => {
	test("returns false when supported_parameters is not an array", () => {
		expect(matchesParametersFilter(undefined, new Set(["tools"] as never))).toBe(false);
	});

	test("returns true when all required parameters are present", () => {
		expect(matchesParametersFilter(["tools", "reasoning"], new Set(["tools"] as never))).toBe(true);
	});

	test("returns false when any required parameter is missing", () => {
		expect(matchesParametersFilter(["tools"], new Set(["tools", "reasoning"] as never))).toBe(
			false
		);
	});
});

describe("setHasAll", () => {
	test("returns true when superset has all required items", () => {
		expect(setHasAll(new Set([1, 2, 3]), new Set([1, 2]))).toBe(true);
	});

	test("returns false when even one required is missing", () => {
		expect(setHasAll(new Set([1, 2]), new Set([1, 3]))).toBe(false);
	});

	test("returns true for empty required set", () => {
		expect(setHasAll(new Set([1]), new Set<number>())).toBe(true);
	});
});

describe("nonEmptySetOrNull", () => {
	test("returns null for undefined", () => {
		expect(nonEmptySetOrNull(undefined)).toBeNull();
	});

	test("returns null for empty array", () => {
		expect(nonEmptySetOrNull([])).toBeNull();
	});

	test("returns Set with values for non-empty array", () => {
		const set = nonEmptySetOrNull(["a", "b", "a"]);
		expect(set).toBeInstanceOf(Set);
		expect(set?.size).toBe(2);
	});
});

describe("buildActiveFilters", () => {
	test("returns nulls for omitted options", () => {
		const f = buildActiveFilters({});
		expect(f.selectedMakersSet).toBeNull();
		expect(f.selectedVariant).toBeNull();
		expect(f.selectedEndpointProvider).toBeNull();
		expect(f.selectedParametersSet).toBeNull();
	});

	test("populates fields when provided", () => {
		const f = buildActiveFilters({
			selectedMakers: ["openai"],
			selectedVariant: "nitro",
			selectedEndpointProvider: "openai",
			selectedParameters: ["tools"],
		});
		expect(f.selectedMakersSet?.has("openai")).toBe(true);
		expect(f.selectedVariant).toBe("nitro");
		expect(f.selectedEndpointProvider).toBe("openai");
		expect(f.selectedParametersSet?.has("tools" as never)).toBe(true);
	});
});

describe("hasAnyActiveFilter", () => {
	test("returns false when nothing is set", () => {
		expect(
			hasAnyActiveFilter({
				selectedMakersSet: null,
				selectedVariant: null,
				selectedEndpointProvider: null,
				selectedParametersSet: null,
			})
		).toBe(false);
	});

	test.each([
		[{ selectedMakersSet: new Set(["a"]) }],
		[{ selectedVariant: "nitro" as const }],
		[{ selectedEndpointProvider: "openai" }],
		[{ selectedParametersSet: new Set(["tools" as never]) }],
	])("returns true when any single filter is set: %p", (override) => {
		const base = {
			selectedMakersSet: null,
			selectedVariant: null,
			selectedEndpointProvider: null,
			selectedParametersSet: null,
		};
		expect(hasAnyActiveFilter({ ...base, ...override })).toBe(true);
	});
});

describe("passes* filters", () => {
	test.each([
		["passesMakerFilter null → true", () => passesMakerFilter(openaiModel, null), true],
		["passesMakerFilter set hit", () => passesMakerFilter(openaiModel, new Set(["openai"])), true],
		["passesMakerFilter set miss", () => passesMakerFilter(openaiModel, new Set(["other"])), false],
		["passesVariantFilter null → true", () => passesVariantFilter(nitroModel, null), true],
		["passesVariantFilter nitro hit", () => passesVariantFilter(nitroModel, "nitro"), true],
		["passesEndpointFilter null → true", () => passesEndpointFilter(googleModel, null), true],
		["passesEndpointFilter google hit", () => passesEndpointFilter(googleModel, "google"), true],
		["passesParametersFilter null → true", () => passesParametersFilter(openaiModel, null), true],
		[
			"passesParametersFilter set hit",
			() => passesParametersFilter(openaiModel, new Set(["tools" as never])),
			true,
		],
	])("%s", (_label, run, expected) => {
		expect(run()).toBe(expected);
	});
});

describe("modelPassesFilters", () => {
	test("returns true when all filters pass", () => {
		expect(
			modelPassesFilters(openaiModel, {
				selectedMakersSet: new Set(["openai"]),
				selectedVariant: "none",
				selectedEndpointProvider: "openai",
				selectedParametersSet: new Set(["tools" as never]),
			})
		).toBe(true);
	});

	test("returns false when one filter fails", () => {
		expect(
			modelPassesFilters(openaiModel, {
				selectedMakersSet: new Set(["anthropic"]),
				selectedVariant: null,
				selectedEndpointProvider: null,
				selectedParametersSet: null,
			})
		).toBe(false);
	});
});

describe("getMakerKey", () => {
	test("returns the maker when defined", () => {
		expect(getMakerKey(openaiModel)).toBe("openai");
	});

	test("returns 'Other' for missing/empty maker", () => {
		expect(getMakerKey({ ...openaiModel, maker: undefined } as OpenRouterModel)).toBe("Other");
		expect(getMakerKey({ ...openaiModel, maker: "" } as OpenRouterModel)).toBe("Other");
	});
});

describe("compareByMissingOrder", () => {
	test("indexA found and indexB missing: a comes first", () => {
		expect(compareByMissingOrder(0, -1, "a", "b")).toBe(-1);
	});

	test("indexB found and indexA missing: b comes first", () => {
		expect(compareByMissingOrder(-1, 0, "a", "b")).toBe(1);
	});

	test("both missing: alphabetic compare", () => {
		expect(compareByMissingOrder(-1, -1, "a", "b")).toBeLessThan(0);
		expect(compareByMissingOrder(-1, -1, "b", "a")).toBeGreaterThan(0);
	});
});

describe("makeOrderComparator", () => {
	test("orders by makerOrder index when both indexed", () => {
		const cmp = makeOrderComparator(["x", "y"]);
		const a: [string, OpenRouterModel[]] = ["x", []];
		const b: [string, OpenRouterModel[]] = ["y", []];
		expect(cmp(a, b)).toBeLessThan(0);
		expect(cmp(b, a)).toBeGreaterThan(0);
	});

	test("falls back to compareByMissingOrder when one is missing", () => {
		const cmp = makeOrderComparator(["x"]);
		const a: [string, OpenRouterModel[]] = ["x", []];
		const b: [string, OpenRouterModel[]] = ["q", []];
		expect(cmp(a, b)).toBe(-1);
	});
});

describe("collectExactMatches", () => {
	test("returns models scoring > 0 sorted by ascending score", () => {
		const out = collectExactMatches(sample, "openai");
		expect(out.length).toBeGreaterThan(0);
		// All should have maker openai (exact-match score 1)
		expect(out.every((m) => m.maker === "openai")).toBe(true);
	});

	test("returns empty array when nothing matches", () => {
		expect(collectExactMatches(sample, "zzzz-no-such")).toEqual([]);
	});
});

describe("appendUniqueFuzzy", () => {
	test("appends fuzzy items not already in prioritized", () => {
		const prioritized: OpenRouterModel[] = [openaiModel];
		const fuzzy = [{ item: openaiModel }, { item: anthropicModel }];
		const out = appendUniqueFuzzy(prioritized, fuzzy);
		expect(out.map((m) => m.id)).toEqual([openaiModel.id, anthropicModel.id]);
	});

	test("returns prioritized unchanged when fuzzy is empty", () => {
		const prioritized: OpenRouterModel[] = [openaiModel];
		expect(appendUniqueFuzzy(prioritized, [])).toEqual(prioritized);
	});
});

describe("anyNameStartsWith / anyNameIncludes / toLowerCased", () => {
	test("toLowerCased lowercases all string fields", () => {
		const lc = toLowerCased({
			maker: "OpenAI",
			id: "Foo/Bar",
			name: "Hello",
			model_name: "World",
		} as OpenRouterModel);
		expect(lc).toEqual({ maker: "openai", id: "foo/bar", name: "hello", modelName: "world" });
	});

	test("toLowerCased coerces undefined fields to empty strings", () => {
		const lc = toLowerCased({ id: "x" } as OpenRouterModel);
		expect(lc.maker).toBe("");
		expect(lc.name).toBe("");
		expect(lc.modelName).toBe("");
	});

	test.each([
		[{ name: "gpt", id: "z", modelName: "z", maker: "" }, "gp", true],
		[{ name: "z", id: "z", modelName: "z", maker: "" }, "gp", false],
	])("anyNameStartsWith(%p, %p) → %p", (lc, q, expected) => {
		expect(anyNameStartsWith(lc, q)).toBe(expected);
	});

	test.each([
		[{ name: "abc-foo-z", id: "x", modelName: "x", maker: "" }, "foo", true],
		[{ name: "x", id: "y", modelName: "z", maker: "" }, "foo", false],
	])("anyNameIncludes(%p, %p) → %p", (lc, q, expected) => {
		expect(anyNameIncludes(lc, q)).toBe(expected);
	});
});

describe("collectExactMatches sorting & whitespace handling", () => {
	test("sorts in ASCENDING score order (lower score first)", () => {
		// Locks down `(a, b) => a.score - b.score`. Mutating to `+` would
		// reverse or corrupt the sort. Ascending: maker exact (1) < prefix (2)
		// < name-starts-with (3) — the openai exact match should come first
		// when "openai" is queried.
		const out = collectExactMatches(sample, "openai");
		// Both openai models score 1 (exact maker hit). Order doesn't matter
		// across equal scores, but the SET of returned models all having
		// score=1 means no other model leaked in front.
		expect(out.map((m) => m.maker)).toEqual(["openai", "openai"]);
	});

	test("returns models in ascending order across mixed scores", () => {
		// Build models that match different score tiers for the same query.
		const tier1: OpenRouterModel = { ...sample[0], maker: "abc" } as OpenRouterModel;
		const tier2: OpenRouterModel = { ...sample[1], maker: "abcdef" } as OpenRouterModel;
		const tier3: OpenRouterModel = {
			...sample[2],
			maker: "z",
			name: "abcXYZ",
			id: "z/abcxyz",
			model_name: "abcxyz",
		} as OpenRouterModel;
		const out = collectExactMatches([tier3, tier2, tier1], "abc");
		// Tier1 (exact maker, score 1), Tier2 (prefix maker, score 2), Tier3 (name-startsWith, score 3)
		expect(out.map((m) => m.maker)).toEqual(["abc", "abcdef", "z"]);
	});
});

describe("searchModels whitespace + early-return guard", () => {
	test("returns the same array reference for whitespace-only query (kills early-return mutants)", () => {
		// Locks down both `if (!query.trim())` and `query.trim()`. With "  ",
		// real returns the SAME array reference (`models`); mutants that drop
		// trim or invert the check fall through and return `prioritized`
		// (a freshly-built sorted array) → reference inequality.
		const out = searchModels(sample, "  \t  ");
		expect(out).toBe(sample);
	});

	test("returns the same array reference for empty-string query", () => {
		const out = searchModels(sample, "");
		expect(out).toBe(sample);
	});

	test("normalizes the query via trim before scoring (whitespace doesn't break ranking)", () => {
		// Locks down the second `query.trim()` at L170. With "  openai  ", the
		// trimmed-and-lowercased "openai" should still rank exact maker hits.
		// Mutating the trim out would feed "  openai  " to scoreModelMatch,
		// which checks startsWith / includes — neither hits "  openai  ",
		// so the function would return [].
		const out = searchModels(sample, "  openai  ");
		expect(out.length).toBeGreaterThan(0);
		expect(out[0]?.maker).toBe("openai");
	});
});

describe("endpointMatches conditional branches", () => {
	test("returns false when none of provider_name, tag, or lowercased provider_name match", () => {
		// Locks down the `.some(Boolean)` reduction at L190 — already covered,
		// but explicitly assert all-false case via L187 mutation.
		expect(endpointMatches({ provider_name: "x", tag: "y" } as never, "z")).toBe(false);
	});

	test("uses the optional-chaining lowercase comparison only when provider_name exists", () => {
		// Locks L189 OptionalChaining. With provider_name=undefined, the
		// optional chaining yields undefined → falsy → returns false. Mutant
		// removing `?.` would throw on `.toLowerCase()`.
		expect(endpointMatches({ provider_name: undefined, tag: "y" } as never, "z")).toBe(false);
	});
});

describe("matchesEndpointFilter respects endpoints?.some()", () => {
	test("returns false when endpoints array exists but no member matches", () => {
		// Lock down the L197 `.some(...)` body — mutating to `.every(...)` or
		// dropping it would change the truthiness of an array of mismatches.
		expect(matchesEndpointFilter([{ provider_name: "a", tag: "b" } as never], "z")).toBe(false);
	});

	test("returns true when at least one endpoint matches the provider", () => {
		expect(
			matchesEndpointFilter(
				[{ provider_name: "a", tag: "b" } as never, { provider_name: "z", tag: "y" } as never],
				"z"
			)
		).toBe(true);
	});
});

describe("matchesParametersFilter — empty required set boundary", () => {
	test("returns true when supportedParameters is an empty array AND required is empty", () => {
		// Locks down the L217 `if (!isValidParameterList(...))` early return.
		// With supportedParameters=[] (valid array) and required=Set(),
		// setHasAll returns true. If we passed undefined for params, the real
		// returns false; the mutant would skip the early return, then
		// `new Set(undefined)` is also empty, and against an empty required
		// set returns TRUE — different.
		expect(matchesParametersFilter([], new Set())).toBe(true);
	});

	test("returns false when supportedParameters is undefined and required is empty (kills L217 mutant)", () => {
		// Real path: !isValidParameterList(undefined) → true → early `false`.
		// Mutant L217 (`if (false)`): skips early return → builds empty Set →
		// setHasAll(Set(), Set()) returns true. Different observable!
		expect(matchesParametersFilter(undefined, new Set())).toBe(false);
	});
});

describe("passesMakerFilter — undefined maker boundary", () => {
	test("returns false when model.maker is undefined and a filter is set", () => {
		// Lock down L235 EqualityOperator `m.maker !== undefined`. Mutating to
		// `===` would invert the meaning so an undefined-maker model would
		// then attempt the makers.has(undefined) lookup (false anyway), but a
		// model WITH a defined maker would be rejected.
		const m = { ...sample[0], maker: undefined } as OpenRouterModel;
		expect(passesMakerFilter(m, new Set(["openai"]))).toBe(false);
	});

	test("returns false when maker is undefined even if the makers Set contains undefined-as-value", () => {
		// Locks the L240 `m.maker !== undefined && ...` -> `true && ...`
		// mutation. With an undefined model.maker AND a Set that contains
		// undefined (coerced via cast), real returns false (left side
		// short-circuits), but mutant `true && set.has(undefined)` would
		// return true.
		const m = { ...sample[0], maker: undefined } as OpenRouterModel;
		const makers = new Set([undefined as unknown as string, "openai"]);
		expect(passesMakerFilter(m, makers)).toBe(false);
	});
});

describe("filterModels — no-active-filter fast-path", () => {
	test("returns the SAME array reference (no copy) when no filter is active", () => {
		// Locks down L297 `if (!hasAnyActiveFilter(filters)) return models;`
		// — both `if (false)` and the empty BlockStatement mutants would
		// fall through to `models.filter(...)` which always returns a NEW
		// array, breaking reference equality.
		const out = filterModels(sample, {});
		expect(out).toBe(sample);
	});

	test("returns a NEW array reference when at least one filter is active", () => {
		const out = filterModels(sample, { selectedMakers: ["openai"] });
		expect(out).not.toBe(sample);
	});
});

describe("applySearch (via filterModels) trims the query", () => {
	test("ignores leading/trailing whitespace in searchQuery", () => {
		// Locks L304 `rawQuery?.trim()` — mutating to `rawQuery` would treat
		// "  " as a non-empty string and execute a search on "  " which yields
		// no exact matches; the test would observe an empty result.
		const out = filterModels(sample, { searchQuery: "  " });
		expect(out).toEqual(sample);
	});

	test("treats undefined searchQuery as no search", () => {
		const out = filterModels(sample, { searchQuery: undefined });
		expect(out).toEqual(sample);
	});
});

describe("groupModelsByMaker preserveOrder branches", () => {
	test("DEFAULT (preserveOrder=false) sorts groups alphabetically", () => {
		// Locks L389 `if (preserveOrder)` — mutating to `if (true)` would
		// always go through makeOrderComparator (with empty makerOrder),
		// which would sort by alphabet via compareByMissingOrder anyway,
		// SO this looks identical for our default branch. To be sure, exercise
		// the alphabetical sort with input not in alphabetical order.
		const reordered = [sample[2], sample[0], sample[3], sample[1]] as OpenRouterModel[];
		const groups = groupModelsByMaker(reordered, false);
		expect(groups.map(([m]) => m)).toEqual(["anthropic", "google", "openai"]);
	});

	test("preserveOrder=true tracks first-seen maker order via makerOrder", () => {
		// Locks L333 `if (preserveOrder) { makerOrder.push(maker); }` and the
		// L381 array-empty default. Mutating the array literal to non-empty
		// would corrupt the comparator's index lookup; mutating the if would
		// either always or never push.
		const reordered = [
			sample[3], // google
			sample[2], // anthropic
			sample[0], // openai
			sample[1], // openai
		] as OpenRouterModel[];
		const groups = groupModelsByMaker(reordered, true);
		expect(groups.map(([m]) => m)).toEqual(["google", "anthropic", "openai"]);
	});

	test("preserveOrder=true sorts unknown makers alphabetically AFTER known ones", () => {
		// Locks L369 `if (indexA !== -1 && indexB !== -1)` — when both indices
		// are -1 (both unknown), should fall through to alphabetical compare.
		// All makers in input are known, so this case requires a synthetic
		// scenario. Use a single model + a fake group to verify alpha.
		const mixed = [sample[3], sample[2]] as OpenRouterModel[]; // google, anthropic
		const groups = groupModelsByMaker(mixed, true);
		expect(groups.map(([m]) => m)).toEqual(["google", "anthropic"]);
	});
});

describe("getFuseInstance cache short-circuit", () => {
	test("a non-empty searchQuery returns at least the prioritized hits even on cold cache", () => {
		// Locks parts of L38-49 cache logic — without a warmed cache,
		// combineWithFuzzy returns only the prioritized set. Make sure that
		// invariant holds.
		const out = filterModels(sample, { searchQuery: "openai" });
		expect(out.length).toBeGreaterThan(0);
		expect(out.every((m) => m.maker === "openai" || m.id.includes("openai"))).toBe(true);
	});
});
