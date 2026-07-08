import { describe, expect, test } from "bun:test";
import {
	bestRelevance,
	orderByRelevance,
	rankBySearch,
	rankGroupsBySearch,
	type SearchRankable,
} from "./model-search";

interface Row {
	corpus?: string[];
	id: string;
	maker: string;
	name: string;
}

function project(row: Row): SearchRankable {
	return {
		corpus: row.corpus ?? [row.name, row.id, row.maker],
		maker: row.maker,
		names: [row.name, row.id],
	};
}

const acme: Row = {
	id: "acme/parakeet-v3",
	maker: "acme",
	name: "Parakeet v3",
};
const nvidia: Row = {
	id: "nvidia/parakeet-version-3",
	maker: "nvidia",
	name: "Parakeet version 3",
};
const whisper: Row = { id: "openai/whisper", maker: "openai", name: "Whisper" };

describe("rankBySearch", () => {
	test("returns items unchanged for a blank query (new array)", () => {
		const items = [acme, nvidia, whisper];
		const out = rankBySearch(items, "  ", project);
		expect(out).toEqual(items);
		expect(out).not.toBe(items);
	});

	test("fuzzy-only matches follow in original order (typo query)", () => {
		expect(
			rankBySearch([acme, nvidia, whisper], "Parkeet v3", project).map(
				(m) => m.id,
			),
		).toEqual(["acme/parakeet-v3", "nvidia/parakeet-version-3"]);
	});

	test("maker-exact outranks name-substring, both ahead of fuzzy-only", () => {
		const makerExact: Row = { id: "x/one", maker: "cohere", name: "One" };
		const nameSub: Row = { id: "y/two", maker: "acme", name: "cohere-ish two" };
		const fuzzy: Row = { id: "z/coheer", maker: "zeta", name: "Coheer" };
		expect(
			rankBySearch([nameSub, fuzzy, makerExact], "cohere", project).map(
				(m) => m.id,
			),
		).toEqual(["x/one", "y/two", "z/coheer"]);
	});

	test("drops non-matching items", () => {
		expect(
			rankBySearch([acme, whisper], "parakeet", project).map((m) => m.id),
		).toEqual(["acme/parakeet-v3"]);
	});
});

describe("orderByRelevance", () => {
	test("blank query preserves order (new array)", () => {
		const items = [whisper, acme, nvidia];
		const out = orderByRelevance(items, "", project);
		expect(out).toEqual(items);
		expect(out).not.toBe(items);
	});

	test("keeps non-matching items but sinks them below direct matches", () => {
		// Base UI hides the non-matching tail; the surviving order is what matters.
		expect(
			orderByRelevance([whisper, acme, nvidia], "parakeet", project).map(
				(m) => m.id,
			),
		).toEqual([
			"acme/parakeet-v3",
			"nvidia/parakeet-version-3",
			"openai/whisper",
		]);
	});

	test("stable within a tier (original order preserved)", () => {
		const a: Row = { id: "a", maker: "z", name: "gpt a" };
		const b: Row = { id: "b", maker: "z", name: "gpt b" };
		expect(orderByRelevance([a, b], "gpt", project).map((m) => m.id)).toEqual([
			"a",
			"b",
		]);
	});
});

describe("bestRelevance", () => {
	test("returns the lowest tier present, Infinity when none match", () => {
		expect(bestRelevance([whisper, acme], "acme", project)).toBe(1);
		expect(bestRelevance([whisper], "parakeet", project)).toBe(
			Number.POSITIVE_INFINITY,
		);
		expect(bestRelevance([whisper], "  ", project)).toBe(
			Number.POSITIVE_INFINITY,
		);
	});
});

describe("rankGroupsBySearch", () => {
	interface Group {
		items: Row[];
		value: string;
	}
	const rebuild = (group: Group, items: Row[]): Group => ({ ...group, items });

	test("blank query leaves groups untouched (new array)", () => {
		const groups: Group[] = [
			{ items: [whisper], value: "openai" },
			{ items: [acme], value: "acme" },
		];
		const out = rankGroupsBySearch(groups, "", project, rebuild);
		expect(out).toEqual(groups);
		expect(out).not.toBe(groups);
	});

	test("promotes the group holding the closest match and orders its items", () => {
		const groups: Group[] = [
			{ items: [whisper], value: "openai" },
			{ items: [nvidia, acme], value: "asr" },
		];
		const out = rankGroupsBySearch(groups, "parakeet", project, rebuild);
		expect(out.map((g) => g.value)).toEqual(["asr", "openai"]);
		// Both are name-prefix (tier 3) → stable, original within-group order kept.
		expect(out[0]?.items.map((m) => m.id)).toEqual([
			"nvidia/parakeet-version-3",
			"acme/parakeet-v3",
		]);
	});
});
