import { beforeEach, describe, expect, test } from "bun:test";
import {
	isStringArray,
	readPersistedSelectorState,
	writePersistedSelectorState,
} from "./persisted-selector-state";

interface PersistedFixture {
	filter: string;
	sort: string | null;
}

const KEY = "winstt:test:persisted-selector-state";
const FALLBACK: PersistedFixture = { filter: "all", sort: null };

function isPersistedFixture(value: unknown): value is PersistedFixture {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Partial<PersistedFixture>;
	return (
		typeof candidate.filter === "string" &&
		(candidate.sort === null || typeof candidate.sort === "string")
	);
}

describe("persisted selector state", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	test("round-trips validated JSON through localStorage", () => {
		writePersistedSelectorState(KEY, { filter: "cached", sort: "size" });

		expect(readPersistedSelectorState(KEY, isPersistedFixture, FALLBACK)).toEqual({
			filter: "cached",
			sort: "size",
		});
	});

	test("falls back for invalid JSON or an invalid shape", () => {
		window.localStorage.setItem(KEY, "{bad json");
		expect(readPersistedSelectorState(KEY, isPersistedFixture, FALLBACK)).toBe(
			FALLBACK,
		);

		window.localStorage.setItem(KEY, JSON.stringify({ filter: 12, sort: "size" }));
		expect(readPersistedSelectorState(KEY, isPersistedFixture, FALLBACK)).toBe(
			FALLBACK,
		);
	});

	test("validates string arrays", () => {
		expect(isStringArray(["en", "fr"])).toBe(true);
		expect(isStringArray(["en", 42])).toBe(false);
		expect(isStringArray("en")).toBe(false);
	});
});
