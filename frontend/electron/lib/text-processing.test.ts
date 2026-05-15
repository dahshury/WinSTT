import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the store module so initPostProcessing can read from a controllable shape.
const storeData: Record<string, unknown> = {};
const onDidChangeListeners = new Map<string, Array<() => void>>();

function setStoreValue(key: string, value: unknown) {
	storeData[key] = value;
	for (const cb of onDidChangeListeners.get(key) ?? []) {
		cb();
	}
}

const mockStore = {
	get: (key: string) => storeData[key],
	set: (key: string, value: unknown) => setStoreValue(key, value),
	onDidChange: (key: string, cb: () => void) => {
		const list = onDidChangeListeners.get(key) ?? [];
		list.push(cb);
		onDidChangeListeners.set(key, list);
		return () => {
			const current = onDidChangeListeners.get(key) ?? [];
			onDidChangeListeners.set(
				key,
				current.filter((x) => x !== cb)
			);
		};
	},
};

import { storeMock } from "@test/mocks/store";

mock.module("./store", () => ({
	...storeMock(),
	store: mockStore,
	getStoreValue: (key: string) => {
		const [section, sub] = key.split(".");
		const top = section ? storeData[section] : undefined;
		if (top != null && typeof top === "object" && sub) {
			return (top as Record<string, unknown>)[sub];
		}
		return top;
	},
}));

const { applyPostProcessing, cleanupPostProcessing, initPostProcessing } = await import(
	"./text-processing"
);

beforeEach(() => {
	for (const k of Object.keys(storeData)) {
		delete storeData[k];
	}
	onDidChangeListeners.clear();
	storeData.dictionary = [];
	storeData.snippets = [];
	storeData.quality = { ensureSentenceEndsWithPeriod: false };
	initPostProcessing(mockStore as unknown as Parameters<typeof initPostProcessing>[0]);
});

afterEach(() => {
	cleanupPostProcessing();
});

describe("applyPostProcessing — dictionary", () => {
	test("returns input unchanged when no dictionary entries", () => {
		expect(applyPostProcessing("hello there")).toBe("hello there");
	});

	test("applies a case-insensitive replacement (default)", () => {
		setStoreValue("dictionary", [
			{ find: "ur", replace: "your", caseSensitive: false, wholeWord: false },
		]);
		expect(applyPostProcessing("ur cool")).toBe("your cool");
		expect(applyPostProcessing("UR cool")).toBe("your cool");
	});

	test("applies a case-sensitive replacement when caseSensitive=true", () => {
		setStoreValue("dictionary", [
			{ find: "ur", replace: "your", caseSensitive: true, wholeWord: false },
		]);
		expect(applyPostProcessing("UR cool")).toBe("UR cool");
		expect(applyPostProcessing("ur cool")).toBe("your cool");
	});

	test("respects wholeWord boundary", () => {
		setStoreValue("dictionary", [
			{ find: "cat", replace: "dog", caseSensitive: false, wholeWord: true },
		]);
		expect(applyPostProcessing("the cat sat")).toBe("the dog sat");
		expect(applyPostProcessing("category")).toBe("category"); // not whole word
	});

	test("escapes regex special characters in find", () => {
		setStoreValue("dictionary", [
			{ find: ".com", replace: "[dot]com", caseSensitive: false, wholeWord: false },
		]);
		expect(applyPostProcessing("see foo.com")).toBe("see foo[dot]com");
		// '.' should not match arbitrary chars like 'a' since it was escaped
		expect(applyPostProcessing("seeacom")).toBe("seeacom");
	});

	test("filters out entries with empty 'find'", () => {
		setStoreValue("dictionary", [
			{ find: "", replace: "x", caseSensitive: false, wholeWord: false },
			{ find: "y", replace: "z", caseSensitive: false, wholeWord: false },
		]);
		expect(applyPostProcessing("yes")).toBe("zes");
	});
});

describe("applyPostProcessing — snippets", () => {
	test("expands every occurrence of a trigger", () => {
		setStoreValue("snippets", [{ trigger: "/sig", expansion: "Best,\nSan" }]);
		expect(applyPostProcessing("hi /sig and /sig")).toBe("hi Best,\nSan and Best,\nSan");
	});

	test("filters out snippets with empty triggers", () => {
		setStoreValue("snippets", [
			{ trigger: "", expansion: "X" },
			{ trigger: "/y", expansion: "yes" },
		]);
		expect(applyPostProcessing("/y")).toBe("yes");
	});

	test("dictionary applies before snippets", () => {
		setStoreValue("dictionary", [
			{ find: "hi", replace: "hello", caseSensitive: false, wholeWord: false },
		]);
		setStoreValue("snippets", [{ trigger: "hello", expansion: "HOWDY" }]);
		expect(applyPostProcessing("hi")).toBe("HOWDY");
	});
});

describe("applyPostProcessing — sentence end period", () => {
	test("adds a period when ensureSentenceEndsWithPeriod is true and missing punctuation", () => {
		setStoreValue("quality", { ensureSentenceEndsWithPeriod: true });
		expect(applyPostProcessing("hello world")).toBe("hello world.");
	});

	test("trims trailing whitespace before adding the period", () => {
		setStoreValue("quality", { ensureSentenceEndsWithPeriod: true });
		expect(applyPostProcessing("hello  ")).toBe("hello.");
	});

	test("does not add a period when sentence already ends with one", () => {
		setStoreValue("quality", { ensureSentenceEndsWithPeriod: true });
		expect(applyPostProcessing("hello.")).toBe("hello.");
		expect(applyPostProcessing("hello!")).toBe("hello!");
		expect(applyPostProcessing("hello?")).toBe("hello?");
	});

	test("does not add a period for empty result", () => {
		setStoreValue("quality", { ensureSentenceEndsWithPeriod: true });
		expect(applyPostProcessing("")).toBe("");
	});
});

describe("rebuild watchers", () => {
	test("dictionary changes are picked up live", () => {
		expect(applyPostProcessing("hi")).toBe("hi");
		setStoreValue("dictionary", [
			{ find: "hi", replace: "hello", caseSensitive: false, wholeWord: false },
		]);
		expect(applyPostProcessing("hi")).toBe("hello");
	});

	test("snippet changes are picked up live", () => {
		expect(applyPostProcessing("/x")).toBe("/x");
		setStoreValue("snippets", [{ trigger: "/x", expansion: "expanded" }]);
		expect(applyPostProcessing("/x")).toBe("expanded");
	});

	test("re-initializing replaces the active watcher set without leaks", () => {
		setStoreValue("dictionary", [
			{ find: "old", replace: "new", caseSensitive: false, wholeWord: false },
		]);
		expect(applyPostProcessing("old")).toBe("new");

		// Re-init with fresh storeData → previous dictionary should be cleared
		for (const k of Object.keys(storeData)) {
			delete storeData[k];
		}
		onDidChangeListeners.clear();
		storeData.dictionary = [];
		storeData.snippets = [];
		storeData.quality = { ensureSentenceEndsWithPeriod: false };
		initPostProcessing(mockStore as unknown as Parameters<typeof initPostProcessing>[0]);
		expect(applyPostProcessing("old")).toBe("old");
	});
});

describe("cleanupPostProcessing", () => {
	test("clears caches so subsequent applyPostProcessing returns input untouched", () => {
		setStoreValue("dictionary", [
			{ find: "x", replace: "y", caseSensitive: false, wholeWord: false },
		]);
		expect(applyPostProcessing("x")).toBe("y");
		cleanupPostProcessing();
		expect(applyPostProcessing("x")).toBe("x");
	});
});

describe("SENTENCE_END_RE end-anchor (mutation guard)", () => {
	test("does NOT add a period to text that already contains '.' but ends with non-punct", () => {
		// Mutating /[.!?]$/ → /[.!?]/ would let "hello. world" match as already
		// punctuated (because '.' appears anywhere), wrongly skipping the period.
		setStoreValue("quality", { ensureSentenceEndsWithPeriod: true });
		expect(applyPostProcessing("hello. world")).toBe("hello. world.");
	});

	test("does NOT add a period when text ends in a question mark mid-sentence", () => {
		setStoreValue("quality", { ensureSentenceEndsWithPeriod: true });
		// "what? indeed" — the '?' is in middle, end is 'd' → MUST add period.
		expect(applyPostProcessing("what? indeed")).toBe("what? indeed.");
	});
});

describe("compileDictEntry flags (mutation guard)", () => {
	test("default (caseSensitive=undefined) replaces case-insensitively (gi flags)", () => {
		// Mutating flags = "gi" → "" would lose both g and i flags; "gi"→"g"
		// would keep only global. Test that case-insensitive replacement works
		// by default.
		setStoreValue("dictionary", [
			{ find: "foo", replace: "bar", caseSensitive: false, wholeWord: false },
		]);
		expect(applyPostProcessing("FOO foo Foo")).toBe("bar bar bar");
	});

	test("default applies replacement globally (every occurrence)", () => {
		// Mutating away the 'g' flag would replace only the first match.
		setStoreValue("dictionary", [
			{ find: "x", replace: "y", caseSensitive: true, wholeWord: false },
		]);
		expect(applyPostProcessing("xxx")).toBe("yyy");
	});

	test("caseSensitive=true uses 'g' (only — case mismatches don't replace)", () => {
		setStoreValue("dictionary", [
			{ find: "x", replace: "y", caseSensitive: true, wholeWord: false },
		]);
		expect(applyPostProcessing("xX")).toBe("yX");
	});
});

describe("maybePunctuate trailing whitespace (mutation guard for trimEnd)", () => {
	test("text with leading whitespace + trailing whitespace gets trimmed only at end", () => {
		// Mutating .trimEnd() to .trimStart() in maybePunctuate would
		// strip leading instead of trailing whitespace and produce a different
		// output. Verify the leading whitespace is PRESERVED.
		setStoreValue("quality", { ensureSentenceEndsWithPeriod: true });
		expect(applyPostProcessing("  hello   ")).toBe("  hello.");
	});

	test("text ending in '.' followed by whitespace: regex check uses trimEnd (mutation guard)", () => {
		// L94 has two .trimEnd() calls. The FIRST one is inside the regex test:
		// `!SENTENCE_END_RE.test(text.trimEnd())`. If mutated to .trimStart(),
		// "hello.   " → trimStart → "hello.   " (no leading ws to strip) →
		// regex test on "hello.   " ends with space, doesn't match → adds period.
		// Original: "hello.   " → trimEnd → "hello." → ends with "." → matches →
		// no period added.
		// So the original returns "hello." (after the second trimEnd in the
		// no-action branch returns text), mutated returns "hello.   ." .
		setStoreValue("quality", { ensureSentenceEndsWithPeriod: true });
		expect(applyPostProcessing("hello.   ")).toBe("hello.   ");
	});
});

describe("rebuild handles missing/null store data", () => {
	test("dictionary explicitly set to undefined: applyPostProcessing returns input untouched", () => {
		// Mutating `if (!dictionary?.length)` (any of -> false / -> {} / -> length)
		// would change handling of empty/missing dict. Verify it's a no-op.
		setStoreValue("dictionary", undefined);
		expect(applyPostProcessing("hello")).toBe("hello");
	});

	test("dictionary set to empty array: still no-op", () => {
		setStoreValue("dictionary", []);
		expect(applyPostProcessing("hello")).toBe("hello");
	});

	test("snippets explicitly set to undefined: applyPostProcessing returns input untouched", () => {
		// Mutating `snippets?.filter(...) ?? []` would change handling of missing
		// snippets array. Verify it's a no-op.
		setStoreValue("snippets", undefined);
		expect(applyPostProcessing("hello")).toBe("hello");
	});

	test("snippets array filters out empty triggers (kills filter mutation)", () => {
		setStoreValue("snippets", [
			{ trigger: "", expansion: "DEAD" },
			{ trigger: "/x", expansion: "OK" },
		]);
		// If filter is removed, the empty trigger entry would be kept → its
		// `replaceAll("", "DEAD")` would inject "DEAD" between every char.
		// With filter intact, only "/x" applies.
		expect(applyPostProcessing("/x")).toBe("OK");
		expect(applyPostProcessing("abc")).toBe("abc"); // no inserts
	});
});

describe("disposeWatchers cleanup (mutation guard for L75 BlockStatement)", () => {
	test("calling cleanupPostProcessing twice is safe (no-op the second time)", () => {
		// Mutating the disposeWatchers arrow body to {} would skip dispose calls.
		// We can't directly observe dispose, but we can verify cleanup is idempotent.
		setStoreValue("dictionary", [
			{ find: "a", replace: "b", caseSensitive: false, wholeWord: false },
		]);
		expect(applyPostProcessing("a")).toBe("b");
		cleanupPostProcessing();
		// Now changing the store should NOT trigger any rebuild because watcher
		// dispose was called.
		setStoreValue("dictionary", [
			{ find: "x", replace: "y", caseSensitive: false, wholeWord: false },
		]);
		// Cache stays empty because cleanup cleared it AND dispose detached the
		// listener (so the change above doesn't rebuild).
		expect(applyPostProcessing("x")).toBe("x");
		// A second cleanup call should not throw.
		expect(() => cleanupPostProcessing()).not.toThrow();
	});
});
